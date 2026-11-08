import { ToolDefinition, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent"
import type { ThinkingLevel } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts"
import { Agent, AgentRegistry, AgentConfig, AbortableSession, ContentItem } from "./agent.ts"
import { ModelTracker } from "./model.ts"
import { BudgetManager, Metrics, createMetrics, DeltasAndValues } from "./metrics.ts"
import {
    isProcessingStatus,
    createAbortController,
    createAutoReject,
    createRandomId,
    getReadableOffset,
    sleep,
    sleepWithSignal
} from "./helper.ts"
import {
    createUpLinkMessageProcessor,
    MessageWithoutFromTo,
    Messenger,
    DownLinkMessage,
    RemoteWorkflowController,
    MessageSession,
    MessageSystemPrompt,
    MessageWorkflow,
    MessageBlock,
    MessageModel,
    MessageDelta,
    MessageStats,
    MessageStatus,
    MessageRegister,
    MessageUnregister,
    UpLinkMessage
} from "./messages.ts"
import type { AssistantImages, ImagesInputContent, ImageContent, TextContent, ThinkingContent, ToolCall } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts"
import { ChangesTracker, createChangesTracker, ChangeItem } from "./changes.ts"
import { PersistenceConfigProps, createPersistenceHandler, PersistenceHandler, StorageEngine } from "./persistence.ts"
import fs from "node:fs/promises"
import { fork } from "node:child_process"
import path from 'node:path'
import { createApiConnection, ApiConfig, ApiConnection } from "./http.ts"

import Debug from "debug"
const runnerDebug = Debug("tyrolite:workflow:runner")
const runDebug = Debug("tyrolite:workflow:run")

const EXTRA_BLOCKS = {
    INOUT: 1,
    THINKING: 2,
    TOOLS: 4,
    PREVIEW: 8,
    ALL: 0
}
EXTRA_BLOCKS.ALL = EXTRA_BLOCKS.INOUT | EXTRA_BLOCKS.THINKING | EXTRA_BLOCKS.TOOLS | EXTRA_BLOCKS.PREVIEW

interface State {
    [key: string]: any
    lastAgent?: string
    lastResponse?: string
}

interface RunContext {
    get signal(): AbortSignal
    get agent(): Agent
    run: WorkflowRun,
    modelRegistry: ModelRuntime
}

type ValueOrFunc<T> = T | ((state: State, context: RunContext) => T)

interface StageConfig {
    label?: string,
    skip?: ValueOrFunc<boolean>,
    next?: ValueOrFunc<string | boolean>,
}

interface Abortable {
    abort: () => Promise<void>
}

class AbortError extends Error {}

function createAbortError(reason: string | DOMException = 'Aborted') {
    return new AbortError(typeof reason === 'string' ? reason : reason.message)
}

const runOnce: AddEventListenerOptions = {once: true}

abstract class Stage {
    readonly id: string
    protected _label?: string
    protected next: ValueOrFunc<string | boolean>
    protected skip: ValueOrFunc<boolean>

    protected constructor(id: string, config: StageConfig) {
        this.id = id
        this._label = config.label
        this.next = config.next ?? true
        this.skip = config.skip ?? false
    }

    abstract exec(state: State, ctx: RunContext): Promise<any>

    get label(): string | undefined {
        return this._label
    }

    public isAsync(): boolean | string {
        return false
    }

    public isSkip(state: State, ctx: RunContext): boolean {
        return typeof this.skip === 'function' ? this.skip(state, ctx) : this.skip
    }

    public getNext(state: State, ctx: RunContext): string | boolean {
        return typeof this.next === 'function' ? this.next(state, ctx) : this.next
    }

    public async doExec(state: State, ctx: RunContext): Promise<any> {
        if (ctx.signal.aborted) throw createAbortError(ctx.signal.reason)

        let abortHandler: () => void
        return new Promise(async (resolve, reject) => {
            abortHandler = (): void => {
                reject(createAbortError(ctx.signal.reason))
            }
            try {
                ctx.signal.addEventListener('abort', abortHandler, runOnce)
                const result = await this.exec(state, ctx)
                resolve(result)
            } catch (e) {
                reject(e)
            }
        }).finally(
            // TODO removed async here, everything okay?
            () => {
                if (abortHandler) ctx.signal.removeEventListener('abort', abortHandler, runOnce)
            }
        )
    }
}

interface WorkflowConfig {
    id?: string,
    name?: string,
    source?: string
    stages?: Stage[] | (() => Stage[])
}

class Workflow {

    protected static count = 0

    public id: string
    public name: string
    private unresolved: (Stage | (() => Stage[]))[] = []
    private resolved: Stage[] = []
    public source?: string

    constructor(configOrStages: WorkflowConfig | Stage[] = {}) {
        if (Array.isArray(configOrStages)) {
            configOrStages = {stages: configOrStages}
        }
        this.id = configOrStages.id ?? 'workflow_' + (++Workflow.count)
        this.name = configOrStages.name ?? this.id
        this.source = configOrStages.source
        if (configOrStages.stages) this.add(configOrStages.stages)
    }

    add(stages: Stage | Stage[] | (() => Stage[])): Workflow {
        if (Array.isArray(stages)) {
            for (const stage of stages) {
                this.add(stage)
            }
            return this
        }
        this.unresolved.push(stages)
        return this
    }

    get stages(): Stage[] {
        while (this.unresolved.length) {
            const item = this.unresolved.shift()
            if (!item) continue

            if (typeof item === 'function') {
                const stages = item()
                if (!Array.isArray(stages)) {
                    throw Error(`Workflow "${this.id}" didn't return stages in stages-function`)
                }
                this.resolved.push(...stages)
            } else {
                this.resolved.push(item)
            }
        }
        return this.resolved
    }
}

interface WorkflowRegistryOptions {
    autoLoad?: boolean
}

/**
 * Holds all known workflows
 */
class WorkflowRegistry {

    protected autoLoad: boolean
    private idToWorkflow: Map<string, Workflow> = new Map()
    private pendingAdds?: Workflow[] | Workflow
    private dependencies: Record<string, any> | undefined

    public constructor(workflows: Workflow[] | Workflow = [], options: WorkflowRegistryOptions = {}) {
        const { autoLoad = true } = options
        this.autoLoad = autoLoad
        this.pendingAdds = workflows
    }

    public async init(dependencies: Record<string, any> | undefined) {
        if (this.autoLoad) {
            const cwd = process.cwd()
            this.dependencies = dependencies
            await this.loadWorkflowsFromDirectory(path.join(getAgentDir(), 'workflows'))
            await this.loadWorkflowsFromDirectory(path.join(cwd, 'workflows'))
            await this.loadWorkflowsFromDirectory(cwd)
        }
        if (this.pendingAdds) {
            this.add(this.pendingAdds)
            this.pendingAdds = undefined
        }
    }

    public async loadWorkflowFromFile(filePath: string, id?: string): Promise<boolean> {
        try {
            const module = await import(filePath)

            const getWorkflowFunction = module.default
            if (typeof getWorkflowFunction !== 'function') {
                throw Error(`Module ${filePath} doesn't export a default function`)
            }
            const workflow = new Workflow({
                id,
                source: filePath,
                stages: () => getWorkflowFunction(this.dependencies)
            })
            this.add(workflow)
        } catch (error) {
            console.error(`Dynamically loaded workflow module "${filePath}":`, error)
            return false
        }
        return true
    }

    public async loadWorkflowsFromDirectory(dir: string): Promise<void> {
        try {
            await fs.stat(dir)
            if (!(await fs.stat(dir)).isDirectory()) return
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return
            }
            throw error
        }
        const files = await fs.readdir(dir, {withFileTypes: true})
        const suffix = '.workflow.js'
        for (const file of files) {
            if (file.isDirectory() || !file.name.endsWith(suffix)) continue

            const id = file.name.slice(0, file.name.length - suffix.length)
            if (!id) continue

            await this.loadWorkflowFromFile(path.join(file.parentPath, file.name), id)
        }
    }

    /**
     * Adds the given workflow or workflows to the registry
     */
    public add(workflow: Workflow | Workflow[]): WorkflowRegistry {
        if (!Array.isArray(workflow)) {
            workflow = [workflow]
        }
        for (const item of workflow) {
            this.idToWorkflow.set(item.id, item)
        }
        return this
    }

    /**
     * Returns the workflow with the given id or throws an exception if it doesn't exist
     */
    public get(id: string): Workflow {
        const workflow = this.idToWorkflow.get(id)
        if (!workflow) throw Error(`Unknown workflow id "${id}" given`)

        return workflow
    }

    /**
     * Returns an object which maps all available workflow ids to their name
     */
    public getAvailable(): Record<string, string> {
        const result: Record<string, string> = {}
        for (const workflow of this.idToWorkflow.values()) {
            result[workflow.id] = workflow.name
        }
        return result
    }
}

interface WorkflowResult {
    status: "error" | "aborted" | "completed"
    data: any
    runId: string | null
    args: Record<string, any>
    changes?: Record<string, ChangeItem[]>
    stats?: Record<string, number>
    runtime: number
}


type Content = string | ContentItem[]
type InputType = 'text' | 'select'
type WorkflowStatus = 'ready' | 'awaiting' | 'completed' | 'running' | 'error' | 'aborted'

interface RunHandlers {
    renderDelta: (event: DeltaEvent) => Promise<void> | void
    renderBlock: (blockType: BlockType, content: Content, details: BlockEventDetails) => Promise<void> | void
    input: (run: WorkflowRun, type: InputType, options: Record<string, any>) => Promise<string | void>
    sendUplinkMessage: (message: UpLinkMessage) => void
    restart: () => void
    messenger?: Messenger
}

type ContextItemRole = 'system' | 'user' | 'assistant' | 'toolResult'
type ContentItemType = 'text' | 'thinking' | 'image' | 'tool' | 'prompt'

interface ContextItem {
    role: ContextItemRole, type: ContentItemType, content: Content
}

interface SessionOptions {
    clean?: boolean
    thinkingLevel?: ThinkingLevel
    tools?: string[]
    noTools?: 'all' | 'builtin'
    customTools?: ToolDefinition[]
}

interface DeltaBlock {
    scope: 'response' | 'thinking' | 'toolCall'
    model?: string
    updates: number
    text: string
    last: string | boolean
    consumed: boolean
}

interface DeltaEvent {
    session: string
    deltas: Record<number, DeltaBlock>
}

interface BlockEventDetails {
    id?: number
    runId?: string
    info?: string,
    subInfo?: string,
    session?: string
    timestamp: number,
    deltasAndValues?: DeltasAndValues,
    isError?: boolean
}

interface RemoteWorkflowConfig {
    type: 'fork' | 'socket' | 'api'
    workflow: string
    run: WorkflowRun
    signal: AbortSignal
    resolve: (result: WorkflowResult) => void
    reject: (error: any) => void
}

function getSubRunnerPath(type: string) {
    return path.resolve(import.meta.dirname, '..', type)
}

type BlockType = 'prompt' | 'session' | 'compaction' | 'response' | 'thinking'
    | 'tool-call' | 'tool-execution' | 'tool-result' | 'assistant' | 'user'

type WorkflowNode = [name: string, runId: string, parentRunId: string, level: number]

interface RunConfig {
    showBlocks: number
    parentRunId?: string
    rootRunId?: string
    mainRun?: WorkflowRun
    engine?: StorageEngine
    sessionsDir?: string
    registry: WorkflowRegistry
}

interface StageAbortController {
    asyncId?: string | true
    abortController: AbortController
}

/**
 * A workflow run manages the execution of a workflow
 */
class WorkflowRun {

    public id: string
    public status: WorkflowStatus = 'ready'
    public mainRun: WorkflowRun
    public rootRunId: string
    public parentRunId: string | undefined
    public showBlocks = 0
    public lastImageGenerator?: string
    public lastAgent?: string
    public sessionsDir?: string

    protected workflow: Workflow
    protected maxIndex: number
    protected labelToIndex: Map<string, number> = new Map()
    protected currIndex = 0
    protected pendingError: any
    public handlers: RunHandlers
    protected pendingStages = new Set<StageAbortController>()
    protected ignoreAborts = new Set<StageAbortController>()
    protected asyncIds = new Set<string>()
    protected pendingAsyncIds = new Set<string>()
    protected remoteIdToStatus = new Map<string, WorkflowStatus>()
    protected context: RunContext
    protected agentRegistry = new AgentRegistry()
    protected debugPrefix: string
    protected _metrics?: Metrics
    protected changesTracker?: ChangesTracker
    protected abortController = new AbortController()
    protected remoteRunToStatus = new Map<string, WorkflowStatus>()
    protected persistenceHandler: PersistenceHandler | undefined
    protected connected: Record<string, ApiConnection> = {}
    protected workflowNodes: WorkflowNode[] = []
    protected registry: WorkflowRegistry

    constructor(id: string, workflow: Workflow, handlers: RunHandlers, config: RunConfig) {
        const { rootRunId, parentRunId, mainRun, engine, showBlocks, sessionsDir, registry } = config

        this.id = id
        this.workflow = workflow
        this.debugPrefix = `[${workflow.id}:${id}]`
        this.maxIndex = workflow.stages.length
        this.registry = registry
        this.mainRun = mainRun ?? this
        this.rootRunId = rootRunId ?? this.mainRun.id
        this.parentRunId = parentRunId
        this.showBlocks = showBlocks
        this.sessionsDir = sessionsDir
        let type = 'sub'
        if (!mainRun) type = parentRunId ? 'remote' : 'root'
        runDebug(`${this.debugPrefix} Instantiating new ${type} run with ${this.maxIndex} stages`)
        let i = -1
        for (const stage of workflow.stages) {
            i++
            if (!stage.label) continue

            if (this.labelToIndex.has(stage.label))
                throw Error(`Label "${stage.label}" is not unique`)

            this.labelToIndex.set(stage.label, i)
        }
        this.init()
        this.handlers = handlers
        this.context = {
            get signal(): AbortSignal {
                return this.run.signal
            },
            get agent(): Agent {
                return this.run.getAgent(this.run.lastAgent)
            },
            run: this,
            modelRegistry: ModelTracker.modelRegistry,
        }
        this.changesTracker = this.isMainRun() ? createChangesTracker(process.cwd()) : undefined
        if (this.isRootRun() && engine) {
            this.persistenceHandler = createPersistenceHandler(engine)
            this.persistenceHandler.setRootRunId(this.id)
        }
    }

    protected init(): void {}

    get metrics(): Metrics {
        if (this.isMainRun()) {
            if (!this._metrics) {
                this._metrics = createMetrics('run', `Run ${this.id}`)
            }
            return this._metrics
        } else {
            return this.mainRun.metrics
        }
    }

    get messenger(): Messenger | undefined {
        return this.handlers.messenger
    }

    /**
     * Indicates whether this run is the root run or not
     */
    public isRootRun(): boolean {
        return !this.parentRunId
    }

    /**
     * Indicates whether this run is running in a different process or server than its root run
     * or not. A remote run must use messenger to communicate with the root run
     */
    public isRemoteRun(): boolean {
        return !this.mainRun.isRootRun()
    }

    public isKnownRunId(id: string): boolean {
        return runIdToRun.has(id)
    }

    public async connectToApi(apiId: string, config: ApiConfig): Promise<void> {
        this.connected[apiId] = await createApiConnection(config)
    }

    public getChanges(): Record<string, ChangeItem[]> | undefined {
        if (this.changesTracker) {
            return this.changesTracker.changes
        }
    }

    public setRemoteStatus(runId: string, status: WorkflowStatus) {
        this.remoteIdToStatus.set(runId, status)
    }

    protected getLevelOfRunId(id: string) {
        if (id === '') return 0

        let i = 0
        while (i < this.workflowNodes.length && this.workflowNodes[i][1] !== id) {
            i++
        }
        if (i >= this.workflowNodes.length) {
            throw Error(`Invalid run id "${id}" given`)
        }
        let level = 1
        let parent = this.workflowNodes[i][2]
        while (i >= 0 && parent !== '') {
            if (this.workflowNodes[i][1] === parent) {
                level++
                parent = this.workflowNodes[i][2]
            }
            i--
        }
        return level
    }

    public async handleMessageInRootRun(message: MessageWithoutFromTo, onlyIfRemote = false): Promise<void> {
        if (this.isRemoteRun()) {
            this.sendToRootRun(message)
            return
        }
        if (onlyIfRemote) return

        const target = (this.isRootRun() ? this : this.mainRun)
        await this.handleMessage(target, message)
    }

    public async handleMessage(target: WorkflowRun, message: MessageWithoutFromTo) {
        switch (message.type) {
            case 'block':
                await target.registerBlock(message)
                break

            case 'delta':
                await target.updateDeltas(message)
                break

            case 'register':
                target.registerRemoteRun(message)
                break

            case 'unregister':
                target.unregisterRemoteRun(message)
                break

            case 'model':
                target.registerModel(message)
                break

            case 'workflow':
                await target.registerWorkflow(message)
                break

            case 'session':
                await target.registerSession(message)
                break

            case 'systemPrompt':
                await target.registerSystemPrompt(message)
                break

            case 'stats':
                target.updateStats(message)
                break

            case 'status':
                target.updateRemoteStatus(message)
                break
        }

    }

    protected registerModel(message: Pick<MessageModel, 'model'>) {
        const { model } = message
        ModelTracker.markAsUsed(model)
    }

    protected async registerBlock(message: Pick<MessageBlock, 'blockType' | 'content' | 'details'>) {
        const { blockType, content, details } = message
        if (this.persistenceHandler) {
            await this.persistenceHandler.persistBlock(details.runId ?? this.id, blockType, content, details)
        }
        if (this.isBlockTypeSupported(blockType)) {
            await this.handlers.renderBlock(blockType, content, details)
        }
    }

    protected async updateDeltas(message: Pick<MessageDelta, 'event'>) {
        const { event } = message
        await this.handlers.renderDelta(event)
    }

    protected updateStats(message: Pick<MessageStats, 'deltas' | 'timer' | 'model'>) {
        const { deltas, timer, model } = message
        this.addRemoteStats({ model, timer, deltas })
    }

    protected updateRemoteStatus(message: Pick<MessageStatus, 'status' | 'runId'>) {
        const { status, runId } = message
        if (!runId) return

        this.setRemoteStatus(runId, status)
    }

    protected registerRemoteRun(message: Pick<MessageRegister, 'runId' | 'parent'>) {
        const { runId, parent } = message
        workflowTree.addNode(runId, parent)
        this.remoteRunToStatus.set(runId, 'ready')
    }

    protected unregisterRemoteRun(message: Pick<MessageUnregister, 'runId'>) {
        const { runId } = message
        const workflowIds = workflowTree.deleteSubtree(runId)
        for (const id of workflowIds) {
            const ac = originToInputAbort.get(id)
            if (ac) ac.abort()
        }
    }

    protected async registerWorkflow(message: Pick<MessageWorkflow, 'name' | 'runId' | 'parentRunId'>) {
        const { name, runId, parentRunId = '' } = message
        const node: WorkflowNode = [name, runId, parentRunId, parentRunId === '' ? 0 : this.getLevelOfRunId(parentRunId)]
        this.workflowNodes.push(node)

        if (this.persistenceHandler) {
            await this.persistenceHandler.persistWorkflowNode(node)
        }
    }

    protected async registerSession(message: Pick<MessageSession, 'sessionId' | 'source' | 'path'>): Promise<void> {
        if (this.persistenceHandler) {
            await this.persistenceHandler.persistSessionSource(message.sessionId, message.source, message.path)
        }
    }

    protected async registerSystemPrompt(message: Pick<MessageSystemPrompt, 'prompt' | 'hash' | 'session' | 'timestamp'>): Promise<void> {
        const { hash, prompt, session, timestamp } = message

        const hashes = Agent.idToSystemPromptHashes.get(session) ?? []
        if (!hashes.length || hashes[0].hash !== hash) {
            hashes.unshift({
                hash,
                timestamp
            })
            Agent.idToSystemPromptHashes.set(session, hashes)
            if (this.persistenceHandler) {
                await this.persistenceHandler.persistSystemPromptUsage(session, hash, timestamp)
            }
        }

        if (Agent.hashToSystemPrompt.has(hash)) return

        if (this.persistenceHandler) {
            await this.persistenceHandler.persistSystemPrompt(hash, prompt)
        }
        Agent.hashToSystemPrompt.set(hash, prompt)
    }

    public sendToParentRun(message: MessageWithoutFromTo) {
        if (!this.parentRunId) {
            throw Error(`No parent run`)
        }
        this.sendUplinkMessage({ ...message, from: this.id, to: this.parentRunId })
    }

    public sendToRootRun(message: MessageWithoutFromTo) {
        this.sendUplinkMessage({ ...message, from: this.id, to: this.rootRunId })
    }

    public sendUplinkMessage(message: UpLinkMessage) {
        this.handlers.sendUplinkMessage(message)
    }

    public hasPendingStages(ids: string | string[] | undefined): boolean {
        if (!ids) return this.pendingStages.size > 0

        if (!Array.isArray(ids)) ids = [ids]
        for (const id of ids) {
            if (!this.asyncIds.has(id)) throw Error(`Unknown async id "${id}" given`)
        }

        for (const id of ids) {
            if (this.pendingAsyncIds.has(id)) return true
        }
        return false
    }

    public async updateLocalChanges() {
        if (!this.changesTracker) return

        try {
            const snapshot = await this.changesTracker.getSnapshot()
            if (snapshot.length) {
                this.changesTracker.storeSnapshot('local', snapshot)
            }
        } catch (e) {
            console.error(e)
        }
    }

    public async handleDeltaEvent(event: DeltaEvent): Promise<void> {
        if ((this.showBlocks & EXTRA_BLOCKS.PREVIEW) === 0) return

        await this.handleMessageInRootRun({
            type: 'delta',
            event
        })
    }

    protected isBlockTypeSupported(type: BlockType) {
        switch (type) {
            case 'prompt':
            case 'session':
            case 'compaction':
            case 'response':
            case 'tool-result':
                return (this.showBlocks & EXTRA_BLOCKS.INOUT) > 0

            case 'thinking':
                return (this.showBlocks & EXTRA_BLOCKS.THINKING) > 0

            case 'tool-execution':
            case 'tool-call':
                return (this.showBlocks & EXTRA_BLOCKS.TOOLS) > 0
        }
        return true
    }

    public handleBlockEvent(type: BlockType, content: Content, details: BlockEventDetails): void {
        details.runId = this.id
        // start a promise here and continue
        this.handleMessageInRootRun(structuredClone({
            type: 'block',
            blockType: type,
            content,
            details
        }))
    }

    public async setStatus(status: WorkflowStatus): Promise<boolean> {
        if (status === this.status) return false

        runDebug(`${this.debugPrefix} Set status "${status}"`)
        const timestamp = Date.now()
        let event: 'start' | 'end' | undefined
        if (status === 'awaiting') {
            this.metrics.startTimer('time-awaiting', timestamp)
            event = 'start'
        } else if (this.status === 'awaiting') {
            this.metrics.stopTimer('time-awaiting', timestamp)
            event = 'end'
        }
        if (event) {
            await this.handleMessageInRootRun({
                type: 'stats',
                timer: ['awaiting', event, timestamp]
            })
        }
        this.status = status
        await this.handleMessageInRootRun({
            type: 'status',
            status,
            runId: this.id
        })
        return true
    }

    public isMainRun(): boolean {
        return this === this.mainRun
    }

    public async start(args: Record<string, any>): Promise<any> {
        runDebug(`${this.debugPrefix} Starting...`)
        await this.reset()
        if (this.isMainRun()) {
            BudgetManager.startRun(this)
            this.metrics.startTimer('time-duration')
        }
        await this.handleMessageInRootRun({
            type: 'workflow',
            name: this.workflow.name,
            runId: this.id,
            parentRunId: this.parentRunId
        })
        return await this.process(args)
    }

    protected async reset(): Promise<void> {
        this.lastAgent = undefined
        this.pendingError = undefined
        this.workflowNodes = []
        this.currIndex = 0
        if (this.isMainRun()) this.metrics.reset()
        this.agentRegistry.clear()
        this.asyncIds.clear()
        this.pendingAsyncIds.clear()
        this.abortController = createAbortController()
        this.abortController.signal.addEventListener('abort', async () => {
            if (!this.pendingError) {
                this.pendingError = createAbortError(this.abortController.signal.reason)
                await this.setStatus('aborted')
            }
        })
        this.handlers.restart()
        await this.changesTracker?.start()
        if (this.persistenceHandler) {
            await this.persistenceHandler.start()
        }
    }

    public isProcessing(): boolean {
        return isProcessingStatus(this.status)
    }

    protected assertNotAborted() {
        if (this.signal.aborted) {
            throw createAbortError(this.signal.reason)
        }
    }

    get signal(): AbortSignal {
        return this.abortController.signal
    }

    protected setPendingErrorIfNew(error: unknown): boolean {
        if (!this.pendingError && this.status !== 'completed') {
            this.pendingError = error
            return true
        }
        return false
    }

    /**
     * Aborts either all or a given list of pending stages and ignores their errors
     */
    public abortAndIgnorePendingStages(ids: (string)[] = []): void {
        let controllers: StageAbortController[] = []
        if (!ids.length) {
            controllers = [...this.pendingStages.values()]
        } else {
            for (const controller of this.pendingStages.values()) {
                if (typeof controller.asyncId !== 'string') continue

                if (ids.includes(controller.asyncId)) {
                    controllers.push(controller)
                }
            }
        }
        for (const controller of controllers) {
            this.ignoreAborts.add(controller)
            controller.abortController.abort('Aborted by workflow abort stage')
        }
    }

    protected async process(args: Record<string, any>) :Promise<any> {
        runDebug(`${this.debugPrefix} Start processing stages...`)

        let result= undefined
        try {
            await this.setStatus('running')
            const state = {
                ...structuredClone(args)
            }
            let data
            while (this.status === 'running' && this.currIndex < this.maxIndex) {
                this.assertNotAborted()

                const stage = this.workflow.stages[this.currIndex]
                const ctx = { ...this.context }
                if (stage.isSkip(state, ctx)) {
                    this.currIndex++
                    continue
                }
                const asyncId = stage.isAsync()
                if (asyncId !== false) {
                    const isStringId = typeof asyncId === 'string'
                    // each asynchronous stages must be abortable
                    const stageAbortController: StageAbortController = {
                        asyncId,
                        abortController: createAbortController()
                    }
                    this.pendingStages.add(stageAbortController)
                    if (isStringId) {
                        this.asyncIds.add(asyncId)
                        this.pendingAsyncIds.add(asyncId)
                    }
                    // trigger abort when run is aborted or the stage is aborted
                    const signal = AbortSignal.any([
                        this.signal,
                        stageAbortController.abortController.signal
                    ])
                    let newError = false
                    stage.doExec(state, {
                        ...ctx,
                        signal
                    }).catch(
                        e => {
                            if (!this.ignoreAborts.has(stageAbortController)) {
                                newError = this.setPendingErrorIfNew(e)
                            }
                        }
                    ).finally(async () => {
                        this.pendingStages.delete(stageAbortController)
                        this.ignoreAborts.delete(stageAbortController)
                        if (isStringId) this.pendingAsyncIds.delete(asyncId)

                        if (newError && !this.abortController.signal.aborted) {
                            this.abortController.abort('Clean-up')
                        }
                    })
                } else {
                    data = await stage.doExec(state, this.context)
                }

                const next = stage.getNext(state, this.context)
                if (typeof next === 'string') {
                    const idx = this.labelToIndex.get(next)
                    if (idx === undefined)
                        throw Error(`No label "${next}" for next target found`)

                    this.currIndex = idx
                } else if (!next) {
                    this.currIndex = this.maxIndex
                } else {
                    this.currIndex++
                }
                await sleep(0) // make sure we are executing microtasks before throwing
                if (this.pendingError) {
                    throw this.pendingError
                }
            }
            await this.setStatus('completed')
            result = data
        } catch (e) {
            this.setPendingErrorIfNew(e)
        } finally {
            if (this.isMainRun()) {
                this.metrics.stopTimer('time-duration')
            }
            for (const stageAbortController of this.pendingStages.values()) {
                stageAbortController.abortController.abort('Clean-up')
            }
            await this.agentRegistry.abort()
            BudgetManager.stopRun(this)
        }
        // async aborts triggered above might not have thrown yet
        await sleep(0)

        if (this.pendingError) {
            const error = this.pendingError
            if (typeof error !== 'object' || !(error instanceof AbortError)) {
                await this.setStatus('error')
            }
            this.pendingError = undefined
            throw error
        }
        return result
    }

    public abort(reason: string): void {
        if (this.abortController.signal.aborted || !this.isProcessing()) {
            return
        }
        runDebug(`${this.debugPrefix} Abort because of reason "${reason}"`)
        this.abortController.abort(reason)
    }

    public async restart(args: Record<string, any>): Promise<any> {
        runDebug(`${this.debugPrefix} Restarting...`)
        this.abort('User requested restart')
        if (this.persistenceHandler) {
            await this.persistenceHandler.deleteRootRunId(this.id)
        }
        return await this.start(args)
    }

    public input(type: InputType, options: any = {}): Promise<string | void> {
        const { from, ...subOptions } = options
        let ac = from ? new AbortController() : undefined
        const signal = ac ? AbortSignal.any([ac.signal, this.signal]) : this.signal
        if (ac) {
            originToInputAbort.set(from, ac)
        }
        const response = this.handlers.input(this, type, { ...subOptions, signal }).finally(
            () => {
                if (ac) originToInputAbort.delete(from)
            }
        )
        if (!response) throw Error(`User input type "${type}" is not supported by this runner`)

        return response
    }

    public async getAbortableUserInput(type: InputType, options: any = {}): Promise<string | void> {
        const ac = createAutoReject(this.abort.bind(this), {m: 5})
        const abortableInput = this.input(type, options)
        const inputPromise = abortableInput.then(async (value) => {
            await this.setStatus('running')
            return value
        }).finally(
            () => {
                ac.abort()
            }
        )
        await this.setStatus('awaiting')
        return inputPromise
    }

    public addRemoteStats(stats: { model?: string, timer: [scope: string, event: 'start' | 'end', timestamp: number], deltas?: Record<string, number>}): void {
        const { model, timer, deltas } = stats
        const metrics = [this.metrics]
        if (model) {
            metrics.push(ModelTracker.getModelMetrics(model), ModelTracker.totalMetrics)
        }
        const [scope, event, timestamp] = timer
        for (const metric of metrics) {
            event === 'start' ? metric.startTimer('time-' + scope, timestamp) : metric.stopTimer('time-' + scope, timestamp)
        }
        if (deltas) {
            for (const metric of metrics) {
                metric.valuesAdd(deltas)
            }
        }
    }

    public getChildRunner(): Runner {
        return new SubRunner({
            registry: this.registry,
            parentRunId: this.id,
            mainRun: this.mainRun,
            rootRunId: this.rootRunId,
            sessionsDir: this.sessionsDir
        })
    }

    protected getRemoteRunnerConfig(): Record<string, any> {
        return {
            showBlocks: this.showBlocks,
            sessionsDir: this.sessionsDir,
            persistence: 'none'
        }
    }

    public async getRemoteWorkflowResult(config: RemoteWorkflowConfig, args: Record<string, any> = {}): Promise<void> {
        const { type, reject, workflow, resolve, run, signal } = config
        const runConfig = this.getRemoteRunnerConfig()
        try {
            switch (type) {

                case 'fork': {
                    const childProcess = fork(
                        getSubRunnerPath('fork'),
                        [
                            workflow,
                            run.id,
                            this.rootRunId,
                            JSON.stringify(runConfig),
                            JSON.stringify(args)
                        ],
                        {
                            signal
                        }
                    )
                    const sendDownLink = (message: DownLinkMessage) => {
                        childProcess.send(message)
                    }
                    const kill = () => {
                        childProcess[Symbol.dispose]()
                    }
                    const controller: RemoteWorkflowController = {
                        sendDownLink,
                        kill,
                        resolve,
                        reject
                    }
                    childProcess.on('message', createUpLinkMessageProcessor(run, controller))
                    childProcess.on('error', (e) => {
                        if (typeof e === 'object' && (e instanceof AbortError || ('code' in e && e.code === 'ABORT_ERR'))) return

                        reject(e)
                    })
                    break
                }

                case 'socket': {
                    // TODO
                    break
                }

                case 'api': {
                    const idx = workflow.indexOf(':')
                    const apiId = workflow.slice(0, idx)
                    const workflowId = workflow.slice(idx + 1)
                    if (!workflowId) {
                        throw Error(`No workflow id given`)
                    }

                    const api = this.connected[apiId]
                    if (!api) {
                        // TODO
                        throw Error(`No connection to API ${api}`)
                    }
                    const body = await api.fetchJsonFromPath(
                        `/workflow/${workflowId}/start/${this.id}/${this.rootRunId}`,
                        {
                            body: JSON.stringify(args),
                            signal
                        }
                    )
                    if (typeof body !== 'object' || body === null || !('runId' in body)) {
                        throw Error(`Invalid response JSON`)
                    }
                    const { runId } = body

                    const sendDownLink = async (message: DownLinkMessage) => {
                        const response = await api.fetchJsonFromPath(
                            `/run/${this.id}/response`,
                            {
                                body: JSON.stringify(message),
                                signal
                            }
                        )
                        if (typeof response !== 'object' || response === null || !('status' in response) || response.status !== 'ok') {
                            reject(`Unexpected response received`)
                        }
                    }
                    const kill = () => {
                        // api.fetchJsonFromPath(`/run/${runId}/abort`)
                    }
                    const controller: RemoteWorkflowController = {
                        sendDownLink,
                        kill,
                        resolve,
                        reject
                    }
                    signal.addEventListener('abort', kill)
                    const processor = createUpLinkMessageProcessor(run, controller)
                    let lastStatus = 'running'
                    let lastResult: any
                    do {
                        await sleepWithSignal(1000, signal)
                        const statusResponse = await api.fetchJsonFromPath(
                            `/run/${runId}/status`,
                            {
                                signal
                            }
                        )
                        const { status, messages, result } = statusResponse as { status: string, messages: UpLinkMessage[], result: any }
                        for (const message of messages) {
                            await processor(message)
                        }
                        lastStatus = status
                        lastResult = result
                    } while (['running', 'awaiting'].includes(lastStatus))

                    signal.removeEventListener('abort', kill)
                    resolve(lastResult)
                    break
                }

                default:
                    reject(`Unsupported remote workflow type "${type}" given`)
            }
        } catch (e) {
            reject(e)
        }
    }

    public getUsedModels(): string[] {
        return this.agentRegistry.getUsedModels()
    }

    public addAgent(config: AgentConfig): void {
        this.agentRegistry.addAgent(config)
        if (this.lastAgent === undefined) this.lastAgent = config.id
    }

    public async updateAgent(id: string | undefined, props: Record<string, any>): Promise<void> {
        if (!id) {
            id = this.lastAgent ?? 'default'
        }
        const agent = this.agentRegistry.getAgent(id)
        await agent.update(props)
    }

    public async getAgentSession(agentId?: string, options: SessionOptions = {}): Promise<AbortableSession> {
        if (!agentId) {
            agentId = this.lastAgent ?? 'default'
        }
        const agent = this.agentRegistry.getAgent(agentId)
        this.lastAgent = agent.id

        return await agent.getAbortableSession(this, options.clean ? undefined : agent.lastSessionId)
    }

    public getAgent(agentId: string = 'default'): Agent {
        return this.agentRegistry.getAgent(agentId)
    }

    public async promptImageGenerator(model: string, prompt: Content, signal?: AbortSignal): Promise<ContentItem[]> {

        const handler = ModelTracker.getModelHandler(model, true)
        if (!handler.isImageModel) {
            throw Error(`Given model "${model}" is no image model`)
        }
        this.lastImageGenerator = model
        const input: ImagesInputContent[] = []
        if (typeof prompt === 'string') prompt = [prompt]
        for (const item of prompt) {
            if (typeof item === 'string') {
                input.push({
                    type: 'text', text: item
                })
            }
        }
        this.handleBlockEvent('prompt', prompt, { subInfo: model, timestamp: Date.now() })
        const { metrics } = handler
        const { provider } = handler.model
        let apiKey: string | undefined = ModelTracker.imageProviderToApiKey.get(provider)
        let result: AssistantImages | undefined
        let timestamp = 0
        const allMetrics = [this.metrics, ModelTracker.totalMetrics]

        while (result === undefined) {
            timestamp = Date.now()
            const sessionId = createRandomId()
            for (const currMetrics of [metrics, ...allMetrics]) {
                currMetrics.startTimer('time-responding', timestamp, sessionId)
            }
            try {
                result = await ModelTracker.imageModels.generateImages(handler.model, { input }, { signal, apiKey })
            } finally {
                timestamp = Date.now()
                for (const currMetrics of [metrics, ...allMetrics]) {
                    currMetrics.stopTimer('time-responding', timestamp, sessionId)
                }
                metrics.stopTimer('time-responding', timestamp, sessionId)
                ModelTracker.totalMetrics.stopTimer('time-responding', timestamp, sessionId)
            }
            if (result && result.stopReason === 'error' && result.errorMessage && result.errorMessage.includes('API key')) {
                result = undefined
                apiKey = (await this.getAbortableUserInput('text', {
                    prompt: `No API key found. Please set it in your environment and restart or enter a valid API key for provider "${provider}"`
                })) ?? ''
                ModelTracker.imageProviderToApiKey.set(provider, apiKey)
            }
        }
        const response: ContentItem[] = []
        if (result.stopReason === 'error') {
            throw Error(`Image generation with model ${model} failed with error: ` + result.errorMessage)
        } else if (result.stopReason === 'aborted') {
            return []
        }
        const { usage, output } = result
        const snapshot = metrics.getFixSnapshot()
        metrics.setValue('prompts', handler.metrics.getSnapshotValue('prompts') + 1)
        if (usage) {
            metrics.setValues({
                const: usage.cost.total,
                'tokens-input': usage.input,
                'tokens-output': usage.output,
                'tokens-total': usage.totalTokens,
                'tokens-cacheRead': usage.cacheRead,
                'tokens-cacheWrite': usage.cacheWrite
            })
        }
        const deltas = metrics.getValuesDelta(snapshot)
        for (const currMetrics of allMetrics) {
            currMetrics.valuesAdd(deltas)
        }
        for (const block of output) {
            if (block.type === 'text') {
                response.push(block.text)
            } else if (block.type === 'image') {
                response.push({
                    mimeType: block.mimeType,
                    content: block.data
                })
            }
        }
        const deltasAndValues = {
            values: metrics.getFixSnapshot(),
            deltas
        }
        this.handleBlockEvent('response', response, { timestamp: Date.now(), subInfo: model, deltasAndValues })
        return response
    }

    public static async buildSessionContext(sessionManager: SessionManager, untilTimestamp: number, systemPrompt = ''): Promise<ContextItem[]> {
        const items: ContextItem[] = []
        if (systemPrompt) {
            items.push({
                role: 'system',
                type: 'prompt',
                content: systemPrompt
            })
        }
        const { messages } =  sessionManager.buildSessionContext()
        for (const message of messages) {
            const { role, timestamp } = message
            if (timestamp > untilTimestamp) break

            let content: string | (TextContent | ImageContent | ThinkingContent | ToolCall)[]
            switch (role) {
                case 'assistant':
                case 'user':
                case 'toolResult':
                    content = message.content
                    break

                default:
                    continue
            }
            for (const entry of content) {
                const item: ContextItem = { role, type: 'text', content: '' }
                if (typeof entry === 'string') {
                    item.content = entry
                    continue
                }
                switch (entry.type) {
                    case 'text':
                        item.content = entry.text
                        break

                    case 'thinking':
                        item.type = 'thinking'
                        item.content = entry.thinking
                        break

                    case 'image':
                        item.type = 'image'
                        // TODO also allow ContentItem without an array
                        item.content = [{content: entry.data, mimeType: entry.mimeType}]
                        break

                    case 'toolCall':
                        item.type = 'tool'
                        item.content = `${entry.name}:\n\n${JSON.stringify(entry.arguments, null, 2)}`
                        break

                    default:
                        continue
                }
                items.push(item)
            }
        }
        return items
    }

    public async getSessionContext(agentId: string, sessionId: string, untilTimestamp = Date.now()): Promise<ContextItem[]> {
        const agent = this.agentRegistry.getAgent(agentId)
        const session = agent.getAgentSession(sessionId)
        const systemPrompt = agent.getSystemPrompt(sessionId, untilTimestamp)
        return await WorkflowRun.buildSessionContext(session.sessionManager, untilTimestamp, systemPrompt)
    }
}

interface RunnerCls {
    new(): Runner
}

function createRunHandlers(handlers: Partial<RunHandlers> = {}): RunHandlers {
    return {
        input: (run: WorkflowRun, type: InputType, options: Record<string, any>): Promise<string | void> => {
            throw Error(`Runner doesn't support user inputs`)
        },
        sendUplinkMessage: () => {
            throw Error(`Runner doesn't support sending uplink messages`)
        },
        renderBlock: () => {},
        renderDelta: () => {},
        restart: () => {},
        ...handlers
    }
}

const runIdToRun = new Map<string, WorkflowRun>()

interface BlockRenderer {
    reset: () => void
    renderDelta: (event: DeltaEvent) => void
    renderBlock: (type: BlockType, content: Content, details: BlockEventDetails) => Promise<void>
}

interface BlockRendererConfig {
    sessionRetrieval?: boolean
}

interface RunnerConfig extends PersistenceConfigProps {
    mainRun?: WorkflowRun
    registry?: WorkflowRegistry
    rootRunId?: string
    parentRunId?: string
    showBlocks?: number
    sessionsDir?: string
}

type BlockRow = [BlockType, Content, BlockEventDetails]

interface RunBindings {
    session?: string
    rootRunId?: string
    parentRunId?: string
}

interface TreeNode {
    id: string
    parent?: string
    level: number
}

const originToInputAbort = new Map<string, AbortController>()

class WorkflowTree {
    protected nodes: TreeNode[] = []
    protected runToLevel = new Map<string, number>()

    registerRun(runner: Runner, run: WorkflowRun) {
        this.addNode(run.id, runner.parentRunId)
        if (runner.parentRunId && !run.mainRun.isKnownRunId(runner.parentRunId)) {
            run.sendToRootRun({
                type: 'register',
                runId: run.id,
                parent: runner.parentRunId
            })
        }
    }

    addNode(id: string, parent?: string) {
        const level = (this.runToLevel.get(parent ?? '') ?? 0) + 1
        this.nodes.push({
            id,
            parent,
            level
        })
        this.runToLevel.set(id, level)
    }

    unregister(runner: Runner, run: WorkflowRun) {
        this.deleteSubtree(run.id)
        if (runner.parentRunId && !run.mainRun.isKnownRunId(runner.parentRunId)) {
            run.sendToRootRun({
                type: 'unregister',
                runId: run.id,
            })
        }
    }

    deleteSubtree(id: string): string[] {
        const index = this.nodes.findIndex(n => n.id === id)
        const node = this.nodes[index]
        if (!node) {
            return []
        }
        const removed = [node.id]
        const stack = [node.id]
        let i = index + 1
        const remaining = index === 0 ? [] : [...this.nodes.slice(0, index)]
        while (i < this.nodes.length) {
            const curr = this.nodes[i]
            if (curr.parent && stack.includes(curr.parent)) {
                stack.push(curr.id)
                removed.push(curr.id)
            } else {
                remaining.push(curr)
            }
            i++
        }
        this.nodes = remaining
        return removed
    }
}

const workflowTree = new WorkflowTree()

/**
 * A runner is used to execute workflows. We are distinguishing the following runner types
 *   - root runner
 *       The first runner which was instantiated which doesn't have a binding to a parent run
 *   - main runner
 *       The first runner in a process which was instantiated
 *   - sub runner
 *       A runner which was instantiated by a run in another runner of the same process
 *   - remote runner
 *       A main runner which does have a binding to a parent run. This can either be a run on another machine
 *       or in another process.
 */
class Runner {

    /**
     * Dependencies which are injected into the get workflow function of file based workflows
     */
    public static dependencies: Record<string, any> | undefined

    /**
     * The count of runners that have been instantiated. This is used to generate unique runner IDs
     */
    protected static count = 0

    public mainRun?: WorkflowRun
    public parentRunId?: string
    public rootRunId?: string
    protected runIndex = 0
    protected readonly runnerId: string
    public readonly registry: WorkflowRegistry
    protected readonly idToRun: Map<string, WorkflowRun> = new Map()
    protected debugPrefix: string
    protected showBlocks: number
    protected runningInit: Promise<void>
    protected _isAborted: boolean | string = false
    protected sessionsDir: string | undefined
    protected storageEngine?: StorageEngine


    // TODO rework these static methods:

    protected static getNewBlockRenderer(): BlockRenderer {
        return {
            renderBlock: async () => {},
            renderDelta: async () => {},
            reset: () => {}
        }
    }

    public static async inspect() {}

    public static async rebuildContext(link: string): Promise<void> {}

    /**
     * Instantiates a new runner of this class and runs the given workflow
     */
    protected static async runStatic(runnerCls: RunnerCls, workflow: string | Workflow | Stage[], args: Record<string, any> = {}): Promise<WorkflowResult> {
        const runner = new runnerCls()
        return await runner.run(workflow, args)
    }


    constructor(config: RunnerConfig = {}) {
        let {
            registry,
            rootRunId,
            parentRunId,
            mainRun,
            showBlocks = 0,
            storageEngine = 'file',
            sessionRetrieval = false,
            sessionsDir
        } = config
        this.runnerId = `${process.pid}-${++Runner.count}`
        this.mainRun = mainRun
        this.parentRunId = parentRunId
        this.rootRunId = rootRunId
        this.debugPrefix = `[Runner ${this.runnerId}]`
        let type = 'sub'
        if (!mainRun) type = parentRunId ? 'remote' : 'root'
        runnerDebug(`${this.debugPrefix} Instantiating new ${type} runner of type ${this.constructor.name}...`)
        if (registry === undefined) {
            registry = new WorkflowRegistry()
        }

        this.showBlocks = showBlocks & this.getSupportedExtraBlocks()
        this.registry = registry
        this.sessionsDir = sessionsDir
        if (type === 'root') {
            BudgetManager.setRootRunner(this)
            if (storageEngine !== 'none') {
                this.storageEngine = StorageEngine.get({ storageEngine, sessionRetrieval })
                if (!this.sessionsDir) {
                    this.sessionsDir = this.storageEngine.getSessionBaseDir()
                }
            }
        }
        this.runningInit = this.init()
    }

    get id(): string {
        return this.runnerId
    }

    /**
     * Initializes the runner after instantiation
     */
    protected async init() {
        if (this.storageEngine) {
            await this.storageEngine.init()
        }
        await this.registry.init(Runner.dependencies)
    }

    /**
     * Returns whether a new run can be started or not
     */
    protected canRun() {
        return true
    }

    /**
     * Returns which extra blocks are supported by this runner
     */
    protected getSupportedExtraBlocks() {
        return EXTRA_BLOCKS.ALL
    }

    /**
     * Returns handler methods for a new run of this runner. These can be overwritten by runner subclasses for
     * custom behavior.
     */
    protected getRunHandlers(runId: string, bindings?: RunBindings) :RunHandlers {
        return createRunHandlers()
    }

    /**
     * Builds a config for a new workflow run and return it
     */
    protected getRunConfig(bindings?: RunBindings): RunConfig {
        const config: RunConfig = {
            showBlocks: this.showBlocks,
            parentRunId: this.parentRunId,
            mainRun: this.mainRun,
            rootRunId: this.rootRunId,
            engine: this.storageEngine,
            sessionsDir: this.sessionsDir,
            registry: this.registry
        }
        if (bindings) {
            const { rootRunId, parentRunId } = bindings
            config.rootRunId = rootRunId
            config.parentRunId = parentRunId
        }
        return config
    }

    /**
     * Returns the run with the given id or throws an exception if it does not exist
     */
    protected getRun(runId: string): WorkflowRun {
        const run = this.idToRun.get(runId)
        if (!run) {
            throw Error(`Unknown run id "${runId}" given`)
        }
        return run
    }

    /**
     * Adds the given error to workflow result
     */
    protected addErrorToResult(result: WorkflowResult, e: any): void {
        result.status = 'error'
        if (typeof e === 'string') {
            result.data = {
                message: e,
                stack: false
            }
        } else if (typeof e === 'object') {
            if (e instanceof AbortError) {
                result.status = 'aborted'
                result.data = {
                    reason: e.message
                }
            } else if (e instanceof Error) {
                result.data = {
                    message: e.message,
                    stack: e.stack
                }
            }
        } else {
            result.data = {
                message: 'Unknown error'
            }
        }
    }

    /**
     * Calls a method of the workflow run with the given args and returns a workflow result
     */
    protected async getWorkflowResult(method: (args: Record<string, any>) => Promise<any>, run: WorkflowRun, args: Record<string, any>): Promise<WorkflowResult> {
        runnerDebug(`${this.debugPrefix} Requesting result from method ${method.name}() of run ${run.id}`)
        runIdToRun.set(run.id, run)
        const result: WorkflowResult = {
            status: 'completed',
            data: null,
            runId: run.id,
            runtime: 0,
            args
        }
        try {
            if (typeof this._isAborted === 'string') {
                throw createAbortError(this._isAborted)
            }
            result.data = await method.apply(run, [args])
        } catch (e) {
            this.addErrorToResult(result, e)
        } finally {
            if (run.isMainRun()) {
                await run.updateLocalChanges()
                result.changes = run.getChanges()
            }
            this._isAborted = false
            result.runtime = run.metrics.getSnapshotValue('time-duration')
            if (this.parentRunId) {
                this.idToRun.delete(run.id)
                // TODO...
                result.runId = null
            } else {
                result.stats = run.metrics.getSnapshot()
            }
        }
        runIdToRun.delete(run.id)
        workflowTree.unregister(this, run)
        runnerDebug(`${this.debugPrefix} Got workflow result in ${getReadableOffset(result.runtime)}:`, result)
        return result
    }

    /**
     * Instantiates a new run of the given workflow and returns it
     */
    protected async createNewRun(workflowOrId: Workflow | string | Stage[], args: Record<string, any>, bindings?: RunBindings): Promise<WorkflowRun> {
        await this.runningInit
        if (Array.isArray(workflowOrId)) {
            workflowOrId = new Workflow(workflowOrId)
        }
        runnerDebug(`${this.debugPrefix} Run worfklow "${typeof workflowOrId === 'string' ? workflowOrId : workflowOrId.id}" with args "${JSON.stringify(args)}"...`)

        if (typeof workflowOrId === 'string') {
            workflowOrId = this.registry.get(workflowOrId)
        }
        if (!this.canRun()) {
            throw Error(`Could not run workflow "${workflowOrId.id}"`)
        }
        const runId = `${this.runnerId}_${++this.runIndex}`
        const run = new WorkflowRun(runId, workflowOrId, this.getRunHandlers(runId, bindings), this.getRunConfig(bindings))

        this.idToRun.set(runId, run)
        workflowTree.registerRun(this, run)
        return run
    }

    protected handleBackgroundResult(result: WorkflowResult): void {}

    /**
     * Runs a new workflow with the given args and return a worfklow result JSON object.
     *
     * The workflow can be
     *   - a string representing an existing workflow id of the workflow registry
     *   - an array of stages for a temporary workflow which doesn't have to exist in the workflow registry
     *   - a workflow instance
     */
    public async run(workflowOrId: Workflow | string | Stage[], args: Record<string, any> = {}): Promise<WorkflowResult> {
        try {
            const run = await this.createNewRun(workflowOrId, args)
            return await this.getWorkflowResult(run.start, run, args)
        } catch (e) {
            const result: WorkflowResult = {
                status: 'error',
                data: undefined,
                runId: null,
                runtime: 0,
                args
            }
            this.addErrorToResult(result, e)
            return result
        } finally {
            this._isAborted = false
        }
    }

    /**
     * Starts a new workflow with the given args in the background and returns the id of the run. The workflow itself
     * can be bound to a session or a root or parent run
     */
    public async runInBackground(workflowOrId: Workflow | string | Stage[], args: Record<string, any> = {}, bindings?: RunBindings): Promise<string> {
        const run = await this.createNewRun(workflowOrId, args, bindings)
        this.getWorkflowResult(run.start, run, args)
            .then(
                this.handleBackgroundResult.bind(this)
            )
            .catch(
                (e) => {
                    console.error(e)
                }
            ).finally(
            () => {
                this._isAborted = false
            }
        )
        return run.id
    }

    /**
     * Restart the workflow from the given workflow result and returns the new workflow result
     */
    public async restart(result: WorkflowResult): Promise<WorkflowResult> {
        runnerDebug(`${this.debugPrefix} Restarting run id ${result.runId}...`)
        if (result.runId === null) {
            throw Error(`No valid run id given, you probably tried to restart a temporary workflow run which is not possible`)
        }
        const run = this.getRun(result.runId)
        return await this.getWorkflowResult(run.restart, run, result.args)
    }

    /**
     * Aborts all running workflows with the given reason
     */
    public abort(reason = 'Runner aborted all workflows'): void {
        runnerDebug(`${this.debugPrefix} Aborting all running workflows`)
        this._isAborted = reason
        for (const run of this.idToRun.values()) {
            run.abort(reason)
        }
    }
}

/**
 * A sub runner is a runner that is used to execute sub workflows in the current workflow and runs in the same
 * process. Each sub runner has a reference to the main runner of the current process
 */
class SubRunner extends Runner {

    public constructor(config: RunnerConfig) {
        super(config)
        if (!this.mainRun) {
            throw Error(`Cannot instantiate a sub runner without a main run`)
        }
    }

    /**
     * @inheritDoc
     */
    protected getRunHandlers(): RunHandlers {
        const messenger = this.mainRun!.messenger
        return createRunHandlers({
            messenger,
            sendUplinkMessage: messenger ? messenger.sendUplink : undefined,
            input: (run: WorkflowRun, type: InputType, options: Record<string, any> = {}): Promise<string> => {
                return this.mainRun!.handlers.input(run, type, options).then(
                    response => {
                        if (typeof response !== 'string') {
                            throw Error(`Expected a response of type "string" but got "${typeof response}"`)
                        }
                        return response
                    }
                )
            }
        })
    }
}

export {
    ValueOrFunc,
    AbortError,
    createAbortError,
    runOnce,
    runIdToRun,
    Abortable,
    BlockType,
    InputType,
    DeltaEvent,
    DeltaBlock,
    BlockEventDetails,
    Stage,
    StageConfig,
    createRunHandlers,
    Workflow,
    WorkflowNode,
    WorkflowRegistry,
    WorkflowResult,
    WorkflowStatus,
    WorkflowRun,
    RunBindings,
    Runner,
    RunnerConfig,
    RunHandlers,
    RunContext,
    ContextItem,
    Content,
    BlockRenderer,
    BlockRendererConfig,
    BlockRow,
    State,
    EXTRA_BLOCKS
}