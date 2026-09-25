import { appendFile, mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import readline from "node:readline/promises"
import Database from 'better-sqlite3'

import { Content, BlockRow, BlockType, BlockEventDetails, WorkflowNode } from "./workflow.ts"
import { getErrorMessage } from "./helper.ts"

const PERSISTENCE_VERSION = 1
const NODE_PI_FLOW_DIR = '.node-pi-flow'
const PERSISTENCE_DETAILS_FILE = 'persistence.json'

type PersistenceEngineGetter = (config: PersistenceConfig) => StorageEngine

interface PersistenceConfigProps {
    storageEngine?: 'none' | 'file' | 'sqlite' | string
    sessionRetrieval?: boolean
}

type PersistenceConfig = Required<PersistenceConfigProps>

const schemaToFields = {
    'runs': [
        'rootRunId', 'name', 'runId', 'parentRunId', 'level'
    ],
    'blocks': [
        'rootRunId', 'id', 'runId', 'timestamp', 'type', 'content', 'details'
    ],
    'sessions': [
        'rootRunId', 'id', "source", 'path'
    ],
    'system-prompts': [
        'rootRunId', 'hash', 'prompt'
    ],
    'system-prompt-history': [
        'rootRunId', 'sessionId', 'hash', 'timestamp'
    ]
}

type Schema = keyof typeof schemaToFields

async function unlinkAllFiles(targetDir: string) {
    try {
        const entries = await readdir(targetDir)
        if (entries.length === 0) {
            return
        }
        const deletionPromises = entries.map(entryName => {
            const fullPath = path.join(targetDir, entryName)
            return new Promise<void>(async (resolve, reject) => {
                try {
                    await unlink(fullPath)
                } catch (e) {}
                resolve()
            })
        })
        await Promise.all(deletionPromises)
    } catch (e) {}
}

function getFieldIndex(type: Schema, field: string): number {
    const index = schemaToFields[type].indexOf(field)
    if (index === -1) {
        throw Error(`Unknown field "${field}" in type "${type}"`)
    }
    return index
}

abstract class StorageEngine {

    protected static idToEngineGetter = new Map<string, PersistenceEngineGetter>
    protected static idToInstance = new Map<string, StorageEngine>()
    public readonly config: PersistenceConfig
    protected basePath: string
    protected sessionBaseDir: string

    protected constructor(config: PersistenceConfig) {
        this.config = config
        this.basePath = path.resolve(process.cwd(), NODE_PI_FLOW_DIR)
        this.sessionBaseDir = path.resolve(this.basePath, 'sessions')
    }

    static add(id: string, engineGetter: PersistenceEngineGetter) {
        StorageEngine.idToEngineGetter.set(id, engineGetter)
    }

    static get(config: PersistenceConfig) {
        const { storageEngine } = config
        const engine = StorageEngine.idToInstance.get(storageEngine)
        if (engine) {
            return engine
        }
        const getter = StorageEngine.idToEngineGetter.get(storageEngine)
        if (!getter) {
            throw Error(`No storage engine getter registered for id "${storageEngine}"`)
        }
        const instance = getter(config)
        StorageEngine.idToInstance.set(storageEngine, instance)
        return instance
    }

    public async init() {
        if (!this.sessionBaseDir) return

        await unlinkAllFiles(this.sessionBaseDir)
    }

    public abstract appendEntry(type: Schema, entry: any[]) :Promise<void>

    public abstract loadEntries(type: Schema, matching?: Record<string, any>): Promise<any[][]>

    public abstract loadDistinct(type: Schema, field: string, matching?: Record<string, any>): Promise<string[]>

    public abstract deleteEntries(type: Schema, matching?: Record<string, any>): Promise<void>

    public async loadEntry(type: Schema, matching: Record<string, any> = {}): Promise<any[] | undefined> {
        const entries = await this.loadEntries(type, matching)
        if (entries.length === 1) {
            return entries[0]
        } else if (!entries.length) {
            return undefined
        }
        throw Error(`Expected one or no matching persisted entry of "${type}" but found ${entries.length}`)
    }

    public getSessionBaseDir() {
        if (!this.config.sessionRetrieval) return

        return this.sessionBaseDir
    }
}

const schemaToDefinition: Record<Schema, string> = {
    'runs': `
        rootRunId VARCHAR(80) NOT NULL,
        name VARCHAR(80) NOT NULL,
        runId VARCHAR(80) NOT NULL,
        parentRunId VARCHAR(80) NOT NULL,
        level INTEGER NOT NULL
    `,
    'blocks': `
        rootRunId VARCHAR(80) NOT NULL,
        id INTEGER NOT NULL PRIMARY KEY,
        runId VARCHAR(80) NOT NULL,
        timestamp INTEGER NOT NULL,
        type VARCHAR(80) NOT NULL,
        content TEXT NOT NULL,
        details TEXT NOT NULL   
    `,
    'sessions': `
        rootRunId VARCHAR(80) NOT NULL,
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        source VARCHAR(80) NOT NULL,
        path TEXT NOT NULL
    `,
    'system-prompts': `
        rootRunId VARCHAR(80) NOT NULL,
        hash VARCHAR(80) NOT NULL,
        prompt TEXT NOT NULL
    `,
    'system-prompt-history': `
        rootRunId VARCHAR(80) NOT NULL,
        sessionId VARCHAR(80) NOT NULL,
        hash VARCHAR(80) NOT NULL,
        timestamp INTEGER NOT NULL
    `
}

const contentIndex = getFieldIndex('blocks', 'content')
const detailsIndex = getFieldIndex('blocks', 'details')
const pathIndex = getFieldIndex('sessions', 'path')

const schemaToDecode: Record<Schema, undefined | ((row: any[]) => any[])> = {
    runs: undefined,
    blocks: (row: any[]): any[] => {
        row[contentIndex] = JSON.parse(row[contentIndex])
        row[detailsIndex] = JSON.parse(row[detailsIndex])
        return row
    },
    sessions: (row: any[]): any[] => {
        row[pathIndex] = JSON.parse(row[pathIndex])
        return row
    },
    'system-prompts': undefined,
    'system-prompt-history': undefined
}

const schemaToEncode: Record<Schema, undefined | ((row: any[]) => any[])> = {
    runs: undefined,
    blocks: (row: any[]): any[] => {
        const newRow = [...row]
        newRow[contentIndex] = JSON.stringify(row[contentIndex])
        newRow[detailsIndex] = JSON.stringify(row[detailsIndex])
        return newRow
    },
    sessions: (row: any[]): any[] => {
        const newRow = [...row]
        newRow[pathIndex] = JSON.stringify(row[pathIndex])
        return newRow
    },
    'system-prompts': undefined,
    'system-prompt-history': undefined
}

function getTableName(key: string) {
    return key.replaceAll('-', '_')
}

class SqliteStorageEngine extends StorageEngine {

    protected db: any

    public constructor(config: PersistenceConfig) {
        super(config)
        const dbPath = path.resolve(process.cwd(), NODE_PI_FLOW_DIR, 'persistence.db')
        const db = new Database(dbPath)
        db.pragma('journal_mode = WAL')

        this.db = db
    }

    protected async createOrDeleteTables(tables: Schema[], required: boolean) {
        for (const table of tables) {
            const def = schemaToDefinition[table]
            await this.db.exec(`DROP TABLE IF EXISTS ${getTableName(table)}`)
            if (required) {
                await this.db.exec(`CREATE TABLE ${getTableName(table)} (${def})`)
            }
        }
    }

    public async init() {
        await super.init()
        await this.createOrDeleteTables(['runs', 'blocks'], true)
        await this.createOrDeleteTables(['sessions', 'system-prompts', 'system-prompt-history'], this.config.sessionRetrieval)
    }

    public async appendEntry(type: Schema, entry: any[]): Promise<void> {
        const fields = schemaToFields[type]
        if (entry.length !== fields.length) return

        let params = []
        let pos = []
        const encode = schemaToEncode[type]
        if (encode) {
            entry = encode(entry)
        }
        for (let value of entry) {
            params.push(value)
            pos.push('?')
        }
        let sql = `INSERT INTO ${getTableName(type)} (${fields.join(', ')}) VALUES (${pos.join(', ')})`
        await this.db.prepare(sql).run(...params)
    }

    protected getCriteria(matching: Record<string, any>, params: any[]): string {
        let criteria = []
        for (const [name, values] of Object.entries(matching)) {
            let sql = name + ' '
            if (Array.isArray(values)) {
                const pos = []
                for (const value of values) {
                    params.push(value)
                    pos.push('?')
                }
                sql += `IN (${pos.join(', ')})`
            } else {
                sql += '= ?'
                params.push(values)
            }
            criteria.push(sql)
        }
        if (!criteria.length) return ''

        return ' WHERE ' + criteria.join(' AND ')
    }

    public async loadEntries(type: Schema, matching: Record<string, any> = {}): Promise<any[][]> {
        const params: any[] = []
        let rows = await this.db.prepare(`
            SELECT 
                *
            FROM 
                ${getTableName(type)}
            ${this.getCriteria(matching, params)}
        `).raw().all(...params)

        const decode = schemaToDecode[type]
        if (decode) {
            rows = rows.map(decode)
        }
        return rows
    }

    public async loadDistinct(type: Schema, field: string, matching: Record<string, any> = {}): Promise<string[]> {
        const params: any[] = []
        const rows = await this.db.prepare(`
            SELECT 
                DISTINCT ${field}
            FROM 
                ${getTableName(type)}
            ${this.getCriteria(matching, params)}
        `).raw().all(...params)

        return rows.map((row: any[]) => row[0])
    }

    public async deleteEntries(type: Schema, matching: Record<string, any> = {}): Promise<void> {
        const params: any[] = []
        await this.db.prepare(`
            DELETE FROM ${getTableName(type)} 
                ${this.getCriteria(matching, params)}
        `).run(...params)
    }
}

StorageEngine.add('sqlite', (config: PersistenceConfig) => new SqliteStorageEngine(config))

class FileStorageEngine extends StorageEngine {

    static historyFileNames = [
        'blocks',
        'runs'
    ]
    static sessionFileNames = [
        'sessions',
        'system-prompts',
        'system-prompt-history'
    ]
    static fileLocks: Record<string, Promise<void>> = {}

    protected hasEntries = new Set<string>()

    constructor(config: Required<PersistenceConfig>) {
        super(config)
    }

    protected async initializeFileSet(fileNames: string[], required: boolean) {
        for (const file of fileNames) {
            const filePath = path.join(this.basePath, file + '.jsonl')
            FileStorageEngine.fileLocks[filePath] = Promise.resolve()
            try {
                if (required) {
                    await writeFile(filePath, '', { encoding: 'utf8' })
                } else {
                    await unlink(filePath)
                }
            } catch (e) {
                // ignore
            } finally {
                this.hasEntries.delete(filePath)
            }
        }
        return
    }

    public async init() {
        await super.init()
        try {
            await mkdir(this.basePath)
        } catch (e) {
            try {
                const stats = await stat(this.basePath)
                if (!stats.isDirectory()) {
                    console.error(`Could not create directory "${this.basePath}": ${getErrorMessage(e)}`)
                }
            } catch (statError) {}
        }
        await this.initializeFileSet(FileStorageEngine.historyFileNames, true)
        await this.initializeFileSet(FileStorageEngine.sessionFileNames, this.config.sessionRetrieval)
    }

    protected async withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
        const previous = FileStorageEngine.fileLocks[filePath] ?? Promise.resolve()

        let resolveLock!: () => void
        const lock = new Promise<void>(resolve => {
            resolveLock = resolve
        })
        FileStorageEngine.fileLocks[filePath] = previous.then(() => lock)
        try {
            await previous
            return await operation()
        } finally {
            resolveLock()
        }
    }

    public async appendEntry(type: Schema, entry: any[]) {
        const filePath = path.resolve(this.basePath, `${type}.jsonl`)
        try {
            await this.withFileLock(filePath, async () => {
                let newLine = os.EOL
                if (!this.hasEntries.has(filePath)) {
                    newLine = ''
                    this.hasEntries.add(filePath)
                }
                await appendFile(filePath, newLine + JSON.stringify(entry))
            })
        } catch (e) {
            console.error(`Persisting ${type} to file ${filePath} failed: ${getErrorMessage(e)}`)
        }
    }

    public async processLines(type: Schema, process: (row: any[]) => void, matching: Record<string, any> = {}, exclude = false): Promise<void> {
        const filePath = path.resolve(this.basePath, `${type}.jsonl`)
        const criteria: ((row: any[]) => boolean)[] = []
        for (const [field, values] of Object.entries(matching)) {
            const index = getFieldIndex(type, field)
            if (Array.isArray(values)) {
                criteria.push((row: any[]) => values.includes(row[index]))
            } else {
                criteria.push((row: any[]) => values === row[index])
            }
        }

        const fileStream = fs.createReadStream(filePath)
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        })
        const expectedLength = schemaToFields[type].length
        for await (const line of rl) {
            const row = JSON.parse(line.trim())
            if (!Array.isArray(row) || row.length !== expectedLength) continue

            let matching = !exclude
            if (exclude) {
                let matches = 0
                for (const isMatching of criteria) {
                    if (isMatching(row)) {
                        matches++
                    }
                }
                matching = !(matches > 0 && matches === criteria.length)
            } else {
                for (const isMatching of criteria) {
                    if (!isMatching(row)) {
                        matching = false
                        break
                    }
                }
            }
            if (matching) process(row)
        }
    }

    public async loadEntries(type: Schema, matching: Record<string, any> = {}): Promise<any[][]> {
        const result: any[][] = []
        const add = (row: any[])=> {
            result.push(row)
        }
        await this.processLines(type, add, matching)
        return result
    }

    public async loadDistinct(type: Schema, field: string, matching: Record<string, any> = {}) {
        const distinct = new Set<string>()

        const index = getFieldIndex(type, field)
        const add = (row: any[])=> {
            const value = row[index]
            if (!value || typeof value !== 'string') return

            distinct.add(value)
        }
        await this.processLines(type, add, matching)
        return [...distinct.values()]
    }

    public async deleteEntries(type: Schema, matching?: Record<string, any>): Promise<void> {
        const filePath = path.resolve(this.basePath, `${type}.jsonl`)
        try {
            await this.withFileLock(filePath, async () => {
                let content: string = ''
                const add = (row: any[])=> {
                    content += (content ? os.EOL : '') + JSON.stringify(row)
                }
                await this.processLines(type, add, matching, true)
                await writeFile(filePath, content, { encoding: 'utf8' })
            })
        } catch (e) {
            console.error(`Deleting ${type} entries in file ${filePath} failed: ${getErrorMessage(e)}`)
        }
    }
}

StorageEngine.add('file', (config: PersistenceConfig) => new FileStorageEngine(config))

class PersistenceHandler {

    protected static blockId = 0

    protected rootRunId?: string
    protected storageEngine: StorageEngine

    constructor(engine: StorageEngine) {
        this.storageEngine = engine
    }

    public setRootRunId(rootRunId: string) {
        this.rootRunId = rootRunId
    }

    get sessionRetrieval() {
        return this.storageEngine.config.sessionRetrieval
    }

    public async start() {
        const filePath = path.resolve(process.cwd(), NODE_PI_FLOW_DIR, PERSISTENCE_DETAILS_FILE)
        await writeFile(filePath, JSON.stringify({
            version: PERSISTENCE_VERSION,
            config: this.storageEngine.config
        }), { encoding: 'utf8' })

    }

    // ------------------------------------------------
    //   Block history
    // ------------------------------------------------

    public async persistBlock(runId: string, type: BlockType, content: Content, details: BlockEventDetails): Promise<void> {
        const id = ++PersistenceHandler.blockId
        await this.storageEngine.appendEntry('blocks', [
            this.rootRunId,
            id,
            runId,
            details.timestamp,
            type,
            content,
            details
        ])
        details.id = id
        details.runId = runId
    }

    public async persistWorkflowNode(node: WorkflowNode): Promise<void> {
        await this.storageEngine.appendEntry('runs', [
            this.rootRunId,
            ...node
        ])
    }

    public async getRootRunIds(): Promise<string[]> {
        return await this.storageEngine.loadDistinct('runs', 'rootRunId')
    }

    public async getSubtreeBlocks(id: string, matching: Record<string, any> = {}): Promise<BlockRow[]> {
        const treeNodes = await this.getSubTreeNodes(id)
        matching.runId = treeNodes.map(node => node.id)
        const rows = await this.storageEngine.loadEntries('blocks', matching)
        const result: BlockRow[] = []
        for (const row of rows) {
            result.push(row.slice(row.length - 3) as BlockRow)
        }
        return result
    }

    public async getSubTreeNodes(id: string) {
        const runRows = await this.storageEngine.loadEntries('runs')
        const runIdToPath = new Map<string, string[]>()
        const idIndex = getFieldIndex('runs', 'runId')
        const nameIndex = getFieldIndex('runs', 'name')
        const parentIndex = getFieldIndex('runs', 'parentRunId')
        const levelIndex = getFieldIndex('runs', 'level')
        const treeNodes = []
        for (const row of runRows) {
            const parentId = row[parentIndex]
            const path: string[] = !parentId ? [] : [...runIdToPath.get(parentId)!]
            const runId = row[idIndex]
            path.push(runId)
            runIdToPath.set(runId, path)
            if (!path.includes(id)) continue

            treeNodes.push({
                id: runId,
                name: row[nameIndex],
                parentId,
                level: row[levelIndex],
                path
            })
        }
        treeNodes.sort((a, b) => {
            if (a.id === b.id) return 0

            // TODO we should use the creation time here
            if (a.parentId === b.parentId) {
                return a.name > b.name ? 1 : -1
            } else {
                return a.level > b.level ? 1 : -1
            }
        })
        return treeNodes
    }

    // ------------------------------------------------
    //   Session Context retrieval
    // ------------------------------------------------

    public async persistSessionSource(id: string, source: string, path: string | null): Promise<void> {
        if (!this.sessionRetrieval) return

        await this.storageEngine.appendEntry('sessions', [
            this.rootRunId,
            id,
            source,
            path
        ])
    }

    public async persistSystemPrompt(hash: string, prompt: string): Promise<void> {
        if (!this.sessionRetrieval) return

        await this.storageEngine.appendEntry('system-prompts', [
            this.rootRunId,
            hash,
            prompt
        ])
    }

    public async persistSystemPromptUsage(sessionId: string, hash: string, timestamp: number): Promise<void> {
        if (!this.sessionRetrieval) return

        await this.storageEngine.appendEntry('system-prompt-history', [
            this.rootRunId,
            sessionId,
            hash,
            timestamp
        ])
    }

    public async getSession(id: string): Promise<any[] | void> {
        const sessionRows = await this.storageEngine.loadEntries('sessions', { id })
        if (!sessionRows.length) return undefined

        return sessionRows[0]
    }

    public async getSystemPrompt(sessionId: string, timestamp: number): Promise<string> {
        const sessionHashes = await this.storageEngine.loadEntries('system-prompt-history', { sessionId })
        if (!sessionHashes.length) return ''

        const hashIndex = getFieldIndex('system-prompt-history', 'hash')
        const timestampIndex = getFieldIndex('system-prompt-history', 'timestamp')
        let hash: string | undefined = undefined
        for (const hashRow of sessionHashes) {
            if (hashRow[timestampIndex] >= timestamp) break
            hash = hashRow[hashIndex]
        }
        if (!hash) {

        }
        const promptRows = await this.storageEngine.loadEntries('system-prompts', { hash })
        if (!promptRows.length) return ''

        const promptIndex = getFieldIndex('system-prompts', 'prompt')
        return promptRows[0][promptIndex]
    }

    public async deleteRootRunId(id: string) {
        const matching = {rootRunId: id}
        await this.storageEngine.deleteEntries('runs', matching)
        await this.storageEngine.deleteEntries('blocks', matching)
        if (!this.sessionRetrieval) return

        await this.storageEngine.deleteEntries('sessions', matching)
        await this.storageEngine.deleteEntries('system-prompts', matching)
        await this.storageEngine.deleteEntries('system-prompt-history', matching)
    }
}

const createPersistenceHandler = (engine: StorageEngine): PersistenceHandler => {
    return new PersistenceHandler(engine)
}

const restorePersistenceHandler = async (): Promise<PersistenceHandler | undefined> => {
    const filePath = path.resolve(process.cwd(), NODE_PI_FLOW_DIR, PERSISTENCE_DETAILS_FILE)
    let content: string | undefined
    try {
        content = await readFile(filePath, 'utf-8')
    } catch (e) {}

    if (!content) return undefined

    const parsed = JSON.parse(content)
    if (typeof parsed !== 'object') {
        throw Error(`Expected config object in file ${filePath} but got ${typeof parsed}`)
    }

    const { version, config } = parsed
    if (version !== PERSISTENCE_VERSION) {
        throw Error(`Invalid persistence version: ${version}`)
    }
    const engine = StorageEngine.get(config)

    return createPersistenceHandler(engine)

}

export {
    createPersistenceHandler,
    restorePersistenceHandler,
    PersistenceHandler,
    StorageEngine,
    PersistenceConfigProps,
    NODE_PI_FLOW_DIR,
    PERSISTENCE_DETAILS_FILE
}