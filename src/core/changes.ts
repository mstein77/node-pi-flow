import path from "node:path"
import fs from "node:fs/promises"
import syncFs from "node:fs"
import OS from "node:os"
import { getErrorMessage, without } from "./helper.ts"
import { getCmdOutput } from "./cli.ts"
import { NODE_PI_FLOW_DIR } from "./persistence.ts"

type ChangeStatus = 'new' | 'changed' | 'deleted'

// TODO gitBased should also get all dirs + files, for setting correct isDir
// TODO API connections should publish their changes to the root runner and the root runner will
//   have to merge these because a run is only temporary
// TODO throttle down the tracking rate to allow live-previews
// TODO item-exclusion (.gitignore)

interface ChangeItem {
    isDir: boolean | undefined
    path: string
    level: number
    status: ChangeStatus
}

abstract class ChangesTracker {

    protected scopeToChanges: Record<string, ChangeItem[]> = {}
    protected startTime = Date.now()
    protected basePath: string

    constructor(basePath: string) {
        this.basePath = basePath
    }

    protected isAllowedDir(name: string, relPath: string): boolean {
        return !['.git', '.idea', 'node_modules', NODE_PI_FLOW_DIR].includes(name)
    }

    protected isAllowedFile(name: string, relPath: string): boolean {
        return true
    }

    get changes(): Record<string, ChangeItem[]> | undefined {
        if (!Object.keys(this.scopeToChanges).length) return

        return this.scopeToChanges
    }

    public abstract getSnapshot(): Promise<ChangeItem[]>

    public storeSnapshot(scope: string, changes: ChangeItem[]) {
        this.scopeToChanges[scope] = changes
    }

    public async start(): Promise<void> {
        this.scopeToChanges = {}
        this.startTime = Date.now()
    }
}

function getRelPathLevel(relPath: string) {
    const parts = relPath.split(path.sep)
    return parts.length - 1
}

interface FoundItems {
    dirs: string[]
    files: string[]
}

function createFoundItems(): FoundItems {
    return {
        dirs: [],
        files: []
    }
}

class FilesystemBasedChangesTracker extends ChangesTracker {

    protected foundOnStart?: FoundItems

    protected async addFolderChanges(changes: ChangeItem[], found: FoundItems, relPath: string = '', level = 0): Promise<ChangeItem[]> {
        const currPath = path.join(this.basePath, relPath)
        const items = await fs.readdir(currPath)
        for (const item of items) {
            const fullPath = path.join(currPath, item)
            const fullRelPath = path.join(relPath, item)
            try {
                const stats = await fs.lstat(fullPath)
                const isDir = stats.isDirectory()
                if ((isDir && !this.isAllowedDir(item, fullRelPath)) || (!isDir && !this.isAllowedFile(item, fullRelPath))) continue

                if (isDir) {
                    found.dirs.push(fullRelPath)
                } else {
                    found.files.push(fullRelPath)
                }
                let status: 'changed' | 'new' = 'changed'
                if (stats.birthtime.getTime() >= this.startTime) {
                    status = 'new'
                } else if (isDir) {
                    await this.addFolderChanges(changes, found, fullRelPath, level + 1)
                    continue
                } else if (stats.mtime.getTime() < this.startTime) {
                    continue
                }
                changes.push({
                    isDir,
                    path: fullRelPath,
                    status,
                    level
                })
            } catch (e) {
                console.error(`Error reading stats of ${fullPath}: ${getErrorMessage(e)}`)
            }
        }
        return changes
    }

    public async getSnapshot(): Promise<ChangeItem[]> {
        const changes: ChangeItem[] = []
        const found = createFoundItems()
        const result = await this.addFolderChanges(changes, found)
        if (this.foundOnStart) {
            const missingDirs = without<string>(this.foundOnStart.dirs, found.dirs)
            for (const dir of missingDirs) {
                result.push({
                    isDir: true,
                    path: dir,
                    status: 'deleted',
                    level: getRelPathLevel(dir)
                })
            }
            const missingFiles = without<string>(this.foundOnStart.files, found.files)
            for (const file of missingFiles) {
                result.push({
                    isDir: false,
                    path: file,
                    status: 'deleted',
                    level: getRelPathLevel(file)
                })
            }
        }
        return result
    }

    protected async addAllDirsAndFiles(found: FoundItems, relPath = ''): Promise<void> {
        const currPath = path.join(this.basePath, relPath)
        const items = await fs.readdir(currPath)
        for (const item of items) {
            const fullPath = path.join(currPath, item)
            const fullRelPath = path.join(relPath, item)
            try {
                const stats = await fs.lstat(fullPath)
                const isDir = stats.isDirectory()
                if ((isDir && !this.isAllowedDir(item, fullRelPath)) || (!isDir && !this.isAllowedFile(item, fullRelPath))) continue

                if (isDir) {
                    found.dirs.push(fullRelPath)
                    await this.addAllDirsAndFiles(found, fullRelPath)
                } else {
                    found.files.push(fullRelPath)
                }
            } catch (e) {
                console.error(`Error reading stats of ${fullPath}: ${getErrorMessage(e)}`)
            }
        }
    }

    public async start(): Promise<void> {
        await super.start()
        this.foundOnStart = createFoundItems()
        await this.addAllDirsAndFiles(this.foundOnStart)
    }
}

class GitBasedChangesTracker extends ChangesTracker {

    protected deletedOnStart: string[] | undefined

    public async getGitStatusChanges(deleted: string[]): Promise<ChangeItem[]> {
        const output = await getCmdOutput(`cd ${this.basePath} && git status --short`)
        const lines = output.split(OS.EOL)
        const items = []
        for (let line of lines) {
            line = line.trim()
            if (!line) continue

            const idx = line.indexOf(' ')
            if (idx === -1) continue

            const status = line.slice(0, idx)
            const path = line.slice(idx).trim()
            if (!path) continue

            if (status.endsWith('D')) {
                deleted.push(path)
            } else {
                items.push(path)
            }
        }
        const changes: ChangeItem[] = []
        for (const item of items) {
            const fullPath = path.join(this.basePath, item)
            const fullRelPath = item
            try {
                const stats = await fs.lstat(fullPath)
                const isDir = stats.isDirectory()
                if ((isDir && !this.isAllowedDir(item, fullRelPath)) || (!isDir && !this.isAllowedFile(item, fullRelPath))) continue

                let status: 'changed' | 'new' = 'changed'
                if (stats.birthtime.getTime() >= this.startTime) {
                    status = 'new'
                } else if (isDir || (stats.mtime.getTime() < this.startTime)) {
                    continue
                }
                changes.push({
                    isDir,
                    path: fullRelPath,
                    status,
                    level: getRelPathLevel(item)
                })
            } catch (e) {
                console.error(`Error reading stats of ${fullPath}: ${getErrorMessage(e)}`)
            }
        }
        return changes
    }

    public async getSnapshot(): Promise<ChangeItem[]> {
        const deleted: string[] = []
        const changes = await this.getGitStatusChanges(deleted)
        if (this.deletedOnStart) {
            for (const item of without<string>(deleted, this.deletedOnStart)) {
                changes.push({
                    isDir: undefined,
                    path: item,
                    status: 'deleted',
                    level: getRelPathLevel(item)
                })
            }
        }
        return changes
    }

    public async start(): Promise<void> {
        await super.start()
        this.deletedOnStart = []
        await this.getGitStatusChanges(this.deletedOnStart)
    }
}

const createChangesTracker = (basePath: string) => {
    let hasGit = true
    try {
        const handle = syncFs.opendirSync(path.resolve(basePath, '.git'))
        handle.closeSync()
    } catch (e) {
        hasGit = false
    }
    if (hasGit) {
        return new GitBasedChangesTracker(basePath)
    }
    return new FilesystemBasedChangesTracker(basePath)
}

export {
    ChangeItem,
    ChangesTracker,
    createChangesTracker
}
