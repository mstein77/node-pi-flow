import {
    ValueOrFunc,
    RunContext,
    Stage,
    StageConfig,
    createAbortError,
    Content,
    State,
    runOnce, WorkflowResult,
    Runner
} from './workflow.ts'
import { AgentConfig } from "./agent.ts"
import { toTime, TimeConfig, sleepWithSignal } from './helper.ts'
import type { ThinkingLevel } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts"
import type { Model, Api } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts"
import {
    ExtensionFactory,
    LoadExtensionsResult,
    PromptTemplate,
    ResourceDiagnostic,
    Skill, ToolDefinition
} from "@earendil-works/pi-coding-agent"

// Noop Stage

class NoopStage extends Stage {

    constructor(config: StageConfig = {}) {
        super('noop', config)
    }

    public async exec(): Promise<void> {}
}

function doNoop(config: StageConfig = {}) {
    return new NoopStage(config)
}

// Return Stage

interface ReturnStageConfig extends StageConfig {
    value?: ValueOrFunc<any>
}

class ReturnStage extends Stage {

    protected config: ReturnStageConfig

    public constructor(config: ReturnStageConfig = {}) {
        super('return', config)
        this.config = config
    }

    getNext(state: State, ctx: RunContext): string | boolean {
        return false
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        let { value } = this.config
        if (typeof value === 'function') value = value(state, ctx)

        return value
    }
}

function doReturn(value: any) {
    return new ReturnStage({ value })
}

// Await Stage

interface AwaitStageConfig extends StageConfig {
    keys?: ValueOrFunc<string[]>
}

class AwaitStage extends Stage {

    protected config: AwaitStageConfig

    public constructor(config: AwaitStageConfig = {}) {
        super('await', config)
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        let { keys } = this.config
        if (typeof keys === 'function') keys = keys(state, ctx)

        while (ctx.run.hasPendingStages(keys)) {
            await sleepWithSignal(250, ctx.signal)
        }
    }
}

function doAwait(configOrKeys: AwaitStageConfig | ValueOrFunc<string | string[]> = {}) {
    if (Array.isArray(configOrKeys) || typeof configOrKeys === 'function' || typeof configOrKeys === 'string') {
        configOrKeys = {keys: configOrKeys} as AwaitStageConfig
    }
    return new AwaitStage(configOrKeys)
}

// Error Stage

interface ErrorStageConfig extends StageConfig {
    async?: boolean | string,
    msg?: string
}

class ErrorStage extends Stage {

    protected config: ErrorStageConfig

    constructor(config: ErrorStageConfig = {}) {
        super('error', config)
        this.config = config
    }

    public isAsync(): boolean | string {
        return this.config.async ?? false
    }

    public async exec(state: State): Promise<void> {
        throw Error(this.config.msg ?? 'test error')
    }
}

function doError(configOrMsg: ErrorStageConfig | string = {}): ErrorStage {
    if (typeof configOrMsg === 'string') configOrMsg = {msg:  configOrMsg}
    return new ErrorStage(configOrMsg)
}

// Text Stage

interface TextStageConfig extends StageConfig {
    text?: ValueOrFunc<Content>
    context?: ValueOrFunc<string>
}

class TextStage extends Stage {

    protected config: TextStageConfig

    public constructor(config: TextStageConfig) {
        super('text', config)
        this.config = config
    }

    async exec(state: State, ctx: RunContext): Promise<any> {
        let { text, context } = this.config
        if (typeof text === 'function') text = text(state, ctx)
        if (typeof context === 'function') context = context(state, ctx)

        if (text === undefined) {
            text = state.lastResponse ?? ''
        }
        ctx.run.handleBlockEvent(
            'assistant',
            text,
            {timestamp: Date.now()}
        )
    }
}

function doText(configOrText: TextStageConfig | ValueOrFunc<Content> = {}) {
    if (typeof configOrText === 'string' || typeof configOrText === 'function' || Array.isArray(configOrText)) {
        configOrText = {text: configOrText}
    }
    return new TextStage(configOrText)
}

// Wait Stage

interface WaitStageConfig extends StageConfig, TimeConfig {
    async?: boolean | string,
    cb?: (() => void) | (() => Promise<void>)
}

class WaitStage extends Stage {

    protected config: WaitStageConfig

    public constructor(config: WaitStageConfig) {
        super('wait', config)
        this.config = config
    }

    public isAsync(): boolean | string {
        return this.config.async ?? false
    }

    async exec(state: State, ctx: RunContext): Promise<any> {
        await sleepWithSignal(toTime(this.config), ctx.signal)
        if (this.config.cb) await this.config.cb()
    }
}

function doWait(config: WaitStageConfig): WaitStage {
    return new WaitStage(config)
}

// Ask User Stage

interface AskUserStageConfig extends StageConfig {
    prompt?: ValueOrFunc<string>,
    saveAs?: ValueOrFunc<string>
}

class AskUserStage extends Stage {
    protected config: AskUserStageConfig

    public constructor(config: AskUserStageConfig) {
        super('askUser', config)
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        let { prompt, saveAs } = this.config
        if (prompt && typeof prompt === 'function') prompt = prompt(state, ctx)
        if (typeof saveAs === 'function') {
            saveAs = saveAs(state, ctx)
        }
        state[saveAs ?? 'lastResponse'] = await ctx.run.getAbortableUserInput('text', { prompt })
    }
}

function doAskUser(configOrPrompt: AskUserStageConfig | ValueOrFunc<string> = {}): AskUserStage {
    if (typeof configOrPrompt === 'string' || typeof configOrPrompt === 'function') {
        configOrPrompt = {prompt: configOrPrompt}
    }
    return new AskUserStage(configOrPrompt)
}

// Workflow Stage

interface WorkflowStageConfig extends StageConfig {
    workflow: ValueOrFunc<string | Stage[]>
    args?: ValueOrFunc<Record<string, any>>
    saveAs?: ValueOrFunc<string>
    async?: boolean | string
}

class WorkflowStage extends Stage {
    protected config: WorkflowStageConfig

    public constructor(config: WorkflowStageConfig) {
        super('workflow', config)
        this.config = config
    }

    public isAsync(): boolean | string {
        return this.config.async ?? false
    }

    async exec(state: State, ctx: RunContext): Promise<any> {
        let { saveAs = 'lastSubResult', workflow, args = {} } = this.config

        if (typeof workflow === 'function') workflow = workflow(state, ctx)
        if (typeof saveAs === 'function') saveAs = saveAs(state, ctx)
        if (typeof args === 'function') args = args(state, ctx)

        let abortHandler: undefined | (() => void)
        const result = await new Promise<WorkflowResult>(async (resolve, reject) => {
            try {
                const runner = ctx.run.getChildRunner()
                abortHandler = () => {
                    runner.abort(ctx.signal.reason)
                    reject(createAbortError(ctx.signal.reason))
                }
                ctx.signal.addEventListener('abort', abortHandler, runOnce)
                resolve(await runner.run(workflow, args ?? {}))
            } catch (e) {
                reject(e)
            }
        }).finally(
            () => {
                if (abortHandler) ctx.signal.removeEventListener('abort', abortHandler, runOnce)
            }
        )
        if (result.status === 'completed') {
            state[saveAs] = result.data
            return // result.data
        }
        if (result.status === 'error') {
            throw Error(result.data.message)
        }
    }
}

function doWorkflow(config: WorkflowStageConfig | string | Stage[]): WorkflowStage {
    if (typeof config === 'string' || Array.isArray(config)) {
        config = {workflow: config}
    }
    return new WorkflowStage(config)
}

// New Agent Stage

interface AgentEditableProps {
    model?: ValueOrFunc<string | Model<Api>>,
    thinkingLevel?: ValueOrFunc<ThinkingLevel>
    autoRetry?: ValueOrFunc<boolean>
    autoCompaction?: ValueOrFunc<boolean>
    tools?: ValueOrFunc<string[]>
    noTools?: ValueOrFunc<"all" | "builtin">
    customTools?: ValueOrFunc<ToolDefinition[]>
}

interface NewAgentStageConfig extends StageConfig, AgentEditableProps {
    id: string
    name?: string
    from?: ValueOrFunc<string>
    agentDir?: string
    systemPrompt?: ValueOrFunc<string>
    systemPromptOverride?: (base: string | undefined) => string | undefined
    appendSystemPrompt?: ValueOrFunc<string[]>
    appendSystemPromptOverride?: ((base: string[]) => string[]) | undefined
    skills?: ValueOrFunc<string[]>
    additionalExtensionPaths?: string[]
    additionalSkillPaths?: string[]
    additionalPromptTemplatePaths?: string[]
    extensionFactories?: ExtensionFactory[]
    noExtensions?: boolean
    noSkills?: boolean
    noPromptTemplates?: boolean
    noContextFiles?: boolean
    extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult
    skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
        skills: Skill[]
        diagnostics: ResourceDiagnostic[]
    }
    promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
        prompts: PromptTemplate[]
        diagnostics: ResourceDiagnostic[]
    }
    agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
        agentsFiles: Array<{ path: string; content: string }>
    }
}

function mergeConfigs<T extends Record<string, any>>(
    base: T,
    partial: Partial<T>
): T {
    const result: any = { ...base }
    for (const key in partial) {
        if (Object.prototype.hasOwnProperty.call(partial, key)) {
            const value = partial[key]

            if (value !== undefined) {
                result[key] = value;
            }
        }
    }
    return result as T;
}

class NewAgentStage extends Stage {

    protected config: NewAgentStageConfig

    public constructor(config: NewAgentStageConfig) {
        super('newAgent', config)
        if (!config.name) config.name = config.id
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        let {
            id,
            name,
            from,
            agentDir,
            model,
            thinkingLevel,
            systemPrompt,
            appendSystemPrompt,
            systemPromptOverride,
            appendSystemPromptOverride,
            tools,
            noTools,
            customTools,
            skills,
            autoRetry,
            autoCompaction,
            additionalExtensionPaths,
            additionalSkillPaths,
            additionalPromptTemplatePaths,
            extensionFactories,
            noExtensions,
            noSkills,
            noPromptTemplates,
            noContextFiles,
            extensionsOverride,
            skillsOverride,
            promptsOverride,
            agentsFilesOverride
        } = this.config
        if (from && typeof from === 'function') from = from(state, ctx)
        if (model && typeof model === 'function') model = model(state, ctx)
        if (systemPrompt && typeof systemPrompt === 'function') systemPrompt = systemPrompt(state, ctx)
        if (appendSystemPrompt && typeof appendSystemPrompt === 'function') appendSystemPrompt = appendSystemPrompt(state, ctx)
        if (tools && typeof tools === 'function') tools = tools(state, ctx)
        if (noTools && typeof noTools === 'function') noTools = noTools(state, ctx)
        if (customTools && typeof customTools === 'function') customTools = customTools(state, ctx)
        if (skills && typeof skills === 'function') skills = skills(state, ctx)
        if (thinkingLevel && typeof thinkingLevel === 'function') thinkingLevel = thinkingLevel(state, ctx)
        if (autoRetry !== undefined && typeof autoRetry === 'function') autoRetry = autoRetry(state, ctx)
        if (autoCompaction !== undefined && typeof autoCompaction === 'function') autoCompaction = autoCompaction(state, ctx)
        if (model && typeof model !== 'string') {
            model = `${model.provider}/${model.id}`
        }
        let config: AgentConfig = {
            id,
            name,
            agentDir,
            model,
            systemPrompt,
            systemPromptOverride,
            appendSystemPrompt,
            appendSystemPromptOverride,
            thinkingLevel,
            tools,
            noTools,
            customTools,
            skills,
            autoRetry,
            autoCompaction,
            additionalExtensionPaths,
            additionalSkillPaths,
            additionalPromptTemplatePaths,
            extensionFactories,
            noExtensions,
            noSkills,
            noPromptTemplates,
            noContextFiles,
            extensionsOverride,
            skillsOverride,
            promptsOverride,
            agentsFilesOverride
        }
        if (from) {
            config = mergeConfigs<AgentConfig>(ctx.run.getAgent(from).getConfig(), config)
        }
        ctx.run.addAgent(config)
    }
}

function doNewAgent(config: NewAgentStageConfig): NewAgentStage {
    return new NewAgentStage(config)
}

// Update Agent Stage

interface UpdateAgentStageConfig extends StageConfig, AgentEditableProps {
    id?: string
}

class UpdateAgentStage extends Stage {
    protected config: UpdateAgentStageConfig

    public constructor(config: UpdateAgentStageConfig) {
        super('changeAgent', config)
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        let { id, model, thinkingLevel, tools, noTools, customTools, autoRetry, autoCompaction } = this.config

        if (model && typeof model === 'function') model = model(state, ctx)
        if (thinkingLevel && typeof thinkingLevel === 'function') thinkingLevel = thinkingLevel(state, ctx)
        if (tools && typeof tools === 'function') tools = tools(state, ctx)
        if (noTools && typeof noTools === 'function') noTools = noTools(state, ctx)
        if (customTools && typeof customTools === 'function') customTools = customTools(state, ctx)
        if (autoRetry !== undefined && typeof autoRetry === 'function') autoRetry = autoRetry(state, ctx)
        if (autoCompaction !== undefined && typeof autoCompaction === 'function') autoCompaction = autoCompaction(state, ctx)
        if (model && typeof model !== 'string') {
            model = `${model.provider}/${model.id}`
        }

        const updates: Record<string, any> = {
            model, thinkingLevel, autoRetry, autoCompaction
        }
        if ("tools" in this.config) updates.tools = tools
        if ("noTools" in this.config) updates.noTools = noTools
        if ("customTools" in this.config) updates.customTools = customTools

        // TODO abortable?
        await ctx.run.updateAgent(id, updates)
    }
}

function doUpdateAgent(config: UpdateAgentStageConfig) {
    return new UpdateAgentStage(config)
}

// Ask Agent Stage

interface ResponseValidator {
    id: string,
    getValidationResult: (response: Content) => void | string | string[]
    getMaxRetries: () => number
}

const getJsonResponseValidator = ({retries = 2 } = {}): ResponseValidator => {
    return {
        id: 'JsonResponse',
        getValidationResult: (response: Content) => {
            try {
                if (typeof response !== 'string') {
                    throw Error(`Multi item response`)
                }
                JSON.parse(response)
            } catch (e) {
                return `The response should only be a JSON, don't write anything else into your response`
            }
        },
        getMaxRetries: () => retries
    }
}

interface AskAgentStageConfig extends StageConfig {
    agent?: ValueOrFunc<string>
    prompt: ValueOrFunc<Content>
    saveAs?: ValueOrFunc<string>
    clean?: ValueOrFunc<boolean>
    validators?: ResponseValidator[] | ResponseValidator
}

class AskAgentStage extends Stage {

    protected config: AskAgentStageConfig

    public constructor(config: AskAgentStageConfig) {
        super('askAgent', config)
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        let { agent, prompt, saveAs, clean, validators } = this.config
        if (agent && typeof agent === 'function') agent = agent(state, ctx)
        if (prompt && typeof prompt === 'function') prompt = prompt(state, ctx)
        if (saveAs && typeof saveAs === 'function') saveAs = saveAs(state, ctx)
        if (clean !== undefined && typeof clean === 'function') clean = clean(state, ctx)

        const options = {
            clean
        }
        const session = await ctx.run.getAgentSession(agent, options)
        let response = await session.prompt(prompt, ctx.signal)

        if (validators) {
            if (!Array.isArray(validators)) {
                validators = [validators]
            }
            if (validators.length) {
                let allFailures = []
                const idToRetries = new Map<string, number>()
                do {
                    if (allFailures.length) {
                        const retryPrompt = `Your last response was not what I expected, please check the following points and answer me again:` + allFailures.map(x => `\n - ${x}`).join()
                        response = await session.prompt(retryPrompt, ctx.signal)
                    }
                    allFailures = []
                    for (const validator of validators) {
                        let failures = validator.getValidationResult(response)
                        if (failures) {
                            let retries = idToRetries.get(validator.id) ?? 0
                            retries++
                            const maxRetries = validator.getMaxRetries()
                            if (maxRetries >= 0 && retries > validator.getMaxRetries()) {
                                throw Error(`Response validator ${validator.id} retried ${maxRetries} times but could not validate the response`)
                            }
                            idToRetries.set(validator.id, retries)
                            if (!Array.isArray(failures)) failures = [failures]

                            if (failures.length) {
                                allFailures.push(...failures)
                            }
                        }
                    }
                } while (allFailures.length)
            }
        }

        state[saveAs ?? 'lastResponse'] = response
        state.lastSession = session.id
        state.lastAgent = session.agent
    }
}

function doAskAgent(configOrPrompt: AskAgentStageConfig | ValueOrFunc<Content>): AskAgentStage {
    if (typeof configOrPrompt === 'string' || typeof configOrPrompt === 'function' || Array.isArray(configOrPrompt)) {
        configOrPrompt = {prompt: configOrPrompt}
    }
    return new AskAgentStage(configOrPrompt)
}

// Custom

interface CustomStageConfig extends StageConfig {
    cb: (state: State, ctx: RunContext) => any
}

class CustomStage extends Stage {

    protected config: CustomStageConfig

    public constructor(config: CustomStageConfig) {
        super('custom', config)
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        return await this.config.cb(state, ctx)
    }
}

function doCustom(config: CustomStageConfig | ((state: State, ctx: RunContext) => Promise<any> | any)): CustomStage {
    if (typeof config === 'function') {
        config = {cb: config}
    }
    return new CustomStage(config)
}

// Fork Workflow Stage

interface ForkWorkflowStageConfig extends StageConfig {
    workflow: ValueOrFunc<string>,
    args?: ValueOrFunc<Record<string, any>>
    saveAs?: ValueOrFunc<string>
    async?: boolean | string
}

class ForkWorkflowStage extends Stage {
    protected config: ForkWorkflowStageConfig

    public constructor(config: ForkWorkflowStageConfig) {
        super('ForkWorkflow', config)
        this.config = config
    }

    public isAsync(): boolean | string {
        return this.config.async ?? false
    }

    async exec(state: State, ctx: RunContext): Promise<any> {
        let { saveAs = 'lastSubResult', workflow, args } = this.config

        if (typeof workflow === 'function') workflow = workflow(state, ctx)
        if (typeof args === 'function') args = args(state, ctx)
        if (typeof saveAs === 'function') saveAs = saveAs(state, ctx)

        let abortHandler: undefined | (() => void)
        const result = await new Promise<WorkflowResult>(async (resolve, reject) => {
            try {
                abortHandler = () => {
                    reject(createAbortError(ctx.signal.reason))
                }
                ctx.signal.addEventListener('abort', abortHandler, runOnce)
                ctx.run.getRemoteWorkflowResult({
                    type: 'fork',
                    workflow,
                    run: ctx.run,
                    signal: ctx.signal,
                    resolve,
                    reject
                }, args)
            } catch (e) {
                reject(e)
            }
        })
        .catch(
            e => {
                throw e
            }
        )
        .finally(
            () => {
                if (abortHandler) ctx.signal.removeEventListener('abort', abortHandler, runOnce)
            }
        )
        if (result.status === 'completed') {
            state[saveAs] = result.data
            return // result.data
        }
        if (result.status === 'error') {
            throw Error(result.data.message)
        }
    }
}

function doForkWorkflow(config: ForkWorkflowStageConfig | string): ForkWorkflowStage {
    if (typeof config === 'string') {
        config = {workflow: config}
    }
    return new ForkWorkflowStage(config)
}

// Connect Stage

interface ConnectStateConfig extends StageConfig {
    apis: Record<string, Record<string, any>>
}

class ConnectStage extends Stage {

    protected config: ConnectStateConfig

    constructor(config: ConnectStateConfig) {
        super('connect', config)
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        for (const [ apiId, apiConfig ] of Object.entries(this.config.apis)) {
            const { type, url } = apiConfig
            let sessionId: string | null = null
            switch (type) {
                case 'rest':
                    const response = await fetch(
                        url + '/connect',
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({foo: 'bares'})
                        }
                    )
                    if (!response.ok || response.status !== 200) {
                        throw Error(`Could not connect to rest API ${apiId}`)
                    }
                    const body = await response.json()
                    if (typeof body !== 'object' || body === null) {
                        throw Error(`Unexpected JSON response`)
                    }
                    sessionId = response.headers.get('x-reqtoken')
                    break

                case 'socket':
                    break

                default:
                    throw Error(`Unknown API given!`)
            }
            if (sessionId) {
                ctx.run.markApiAsConnected(apiId, {
                    url: url,
                    type: 'rest',
                    session: sessionId
                })
            }
        }
    }
}

function doConnect(config: ConnectStateConfig) {
    return new ConnectStage(config)
}

// Api Workflow Stage

interface ApiWorkflowConfig extends StageConfig {
    workflow: ValueOrFunc<string>
    saveAs?: ValueOrFunc<string>
    args?: ValueOrFunc<Record<string, any>>
    async?: boolean | string
}

class ApiWorkflowStage extends Stage {

    protected config: ApiWorkflowConfig

    public constructor(config: ApiWorkflowConfig) {
        super('apiWorkflow', config)
        this.config = config
    }

    public async exec(state: State, ctx: RunContext): Promise<any> {
        let { workflow, saveAs = '', args } = this.config

        if (typeof workflow === 'function') workflow = workflow(state, ctx)
        if (typeof args === 'function') args = args(state, ctx)
        if (typeof saveAs === 'function') saveAs = saveAs(state, ctx)

        let abortHandler: undefined | (() => void)
        const result = await new Promise<WorkflowResult>(async (resolve, reject) => {
            try {
                abortHandler = () => {
                    reject(createAbortError(ctx.signal.reason))
                }
                ctx.signal.addEventListener('abort', abortHandler, runOnce)
                ctx.run.getRemoteWorkflowResult({
                    type: 'api',
                    workflow,
                    run: ctx.run,
                    signal: ctx.signal,
                    resolve,
                    reject
                }, args)
            } catch (e) {
                reject(e)
            }
        })
        .catch(
            e => {
                throw e
            }
        )
        .finally(
            () => {
                if (abortHandler) ctx.signal.removeEventListener('abort', abortHandler, runOnce)
            }
        )
        if (result.status === 'completed') {
            state[saveAs] = result.data
            return // result.data
        }
        if (result.status === 'error') {
            throw Error(result.data.message)
        }
    }
}

function doApiWorkflow(configOrWorkflowId: string | ApiWorkflowConfig): ApiWorkflowStage {
    if (typeof configOrWorkflowId === 'string') {
        configOrWorkflowId = {workflow: configOrWorkflowId}
    }
    return new ApiWorkflowStage(configOrWorkflowId)
}

// Ask Image Generator

interface AskImageGeneratorConfig extends StageConfig {
    prompt: ValueOrFunc<Content>
    model?: ValueOrFunc<string>
    saveAs?: ValueOrFunc<string>
    async?: boolean | string
}

class AskImageGeneratorStage extends Stage {
    protected config: AskImageGeneratorConfig

    constructor(config: AskImageGeneratorConfig) {
        super('askImageGenerator', config)
        this.config = config
    }

    public isAsync(): boolean | string {
        return this.config.async ?? false
    }

    async exec(state: State, ctx: RunContext): Promise<any> {
        let { prompt, model, saveAs = 'lastResponse' } = this.config
        if (!model) {
            if (!ctx.run.lastImageGenerator) {
                throw Error(`You must specify a model when you are using an image generator for the first time`)
            }
            model = ctx.run.lastImageGenerator
        }
        if (typeof model === 'function') model = model(state, ctx)
        if (typeof saveAs === 'function') saveAs = saveAs(state, ctx)
        if (typeof prompt === 'function') prompt = prompt(state, ctx)

        // TODO transform to content??
        state[saveAs] = await ctx.run.promptImageGenerator(model, prompt, ctx.signal)
    }
}

function doAskImageGenerator(configOrPrompt: string | AskImageGeneratorConfig) {
    if (typeof configOrPrompt === 'string' || Array.isArray(configOrPrompt)) {
        configOrPrompt = {prompt: configOrPrompt}
    }
    return new AskImageGeneratorStage(configOrPrompt)
}

Runner.dependencies = {
    NoopStage,
    doNoop,
    ReturnStage,
    doReturn,
    TextStage,
    doText,
    AwaitStage,
    doAwait,
    WaitStage,
    doWait,
    ErrorStage,
    doError,
    CustomStage,
    doCustom,
    AskUserStage,
    doAskUser,
    NewAgentStage,
    doNewAgent,
    UpdateAgentStage,
    doUpdateAgent,
    AskAgentStage,
    doAskAgent,
    AskImageGeneratorStage,
    doAskImageGenerator,
    WorkflowStage,
    doWorkflow,
    ForkWorkflowStage,
    doForkWorkflow,
    ConnectStage,
    doConnect,
    ApiWorkflowStage,
    doApiWorkflow,
    getJsonResponseValidator
}

export {
    NoopStage,
    doNoop,
    ReturnStage,
    doReturn,
    TextStage,
    doText,
    AwaitStage,
    doAwait,
    WaitStage,
    doWait,
    ErrorStage,
    doError,
    CustomStage,
    doCustom,
    AskUserStage,
    doAskUser,
    NewAgentStage,
    doNewAgent,
    UpdateAgentStage,
    doUpdateAgent,
    AskAgentStage,
    doAskAgent,
    AskImageGeneratorStage,
    doAskImageGenerator,
    WorkflowStage,
    doWorkflow,
    ForkWorkflowStage,
    doForkWorkflow,
    ConnectStage,
    doConnect,
    ApiWorkflowStage,
    doApiWorkflow,
    ResponseValidator,
    getJsonResponseValidator
}