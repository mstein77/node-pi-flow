import crypto from "node:crypto"
import {
    AgentSession, AgentSessionEvent, BeforeAgentStartEvent,
    createAgentSession,
    DefaultResourceLoader, ExtensionFactory, getAgentDir, LoadExtensionsResult, PromptOptions,
    PromptTemplate, ResourceDiagnostic,
    SessionManager, SessionStats, SettingsManager, Skill, ToolDefinition
} from "@earendil-works/pi-coding-agent"
import type { Usage, AssistantMessage, TextContent, ImageContent, ThinkingContent, ToolCall, StopReason } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts"
import type { ThinkingLevel } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts"
import { ModelTracker, ModelHandler } from "./model.ts"
import { createMetrics, DeltasAndValues, Metrics, getReadableBlockStats } from "./metrics.ts"
import { Content, Abortable, WorkflowRun, DeltaBlock, EXTRA_BLOCKS, AbortError, InputType, createAbortError, runOnce } from "./workflow.ts"
import { getMatchingTransformer } from "./mime.ts"
import Debug from "debug"
const agentDebug = Debug('tyrolite:worfklow:agent')
const eventDebug = Debug('tyrolite:worfklow:agent:event')
const statsDebug = Debug("tyrolite:workflow:stats")

interface AbortableSession extends Abortable {
    id: string,
    agent: string,
    prompt: (msg: Content, signal: AbortSignal) => Promise<Content>
}

interface AgentConfig {
    id: string
    name?: string
    agentDir?: string
    model?: string
    systemPrompt?: string
    systemPromptOverride?: (base: string | undefined) => string | undefined
    appendSystemPrompt?: string[]
    appendSystemPromptOverride?: ((base: string[]) => string[]) | undefined
    thinkingLevel?: ThinkingLevel
    tools?: string[]
    noTools?: "all" | "builtin"
    customTools?: ToolDefinition[]
    skills?: string[]
    autoRetry?: boolean
    autoCompaction?: boolean
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

interface SystemPromptHash {
    timestamp: number
    hash: string
}

const globalAgentDir = getAgentDir()

const getStatsFromSessionStats = (stats: SessionStats, usage?: Usage): Record<string, number> => {
    const ctx = stats.contextUsage ?? {tokens: 0, percent: 0, contextWindow: 0}
    const result: Record<string, number> = {
        cost: stats.cost,
        'prompts': stats.userMessages,
        'tool-calls': stats.toolCalls,
        'context-window': ctx.contextWindow,
        'tokens-input': stats.tokens.input,
        'tokens-output': stats.tokens.output,
        'tokens-total': stats.tokens.total,
        'tokens-cacheRead': stats.tokens.cacheRead,
        'tokens-cacheWrite': stats.tokens.cacheWrite
    }
    if (ctx.tokens !== null) result['context-tokens'] = ctx.tokens
    if (ctx.percent !== null) result['context-usage'] = ctx.percent

    if (usage) {
        result['const'] += usage.cost.total
        result['tokens-input'] += usage.input
        result['tokens-output'] += usage.output
        result['tokens-total'] += usage.totalTokens
        result['tokens-cacheRead'] += usage.cacheRead
        result['tokens-cacheWrite'] += usage.cacheWrite
    }
    return result
}

interface FileItem {
    content: string | null
    mimeType: string
    filePath?: string
}

type ContentItem = string | FileItem

interface AgentSessionContext {
    run: WorkflowRun,
    agent: Agent,
    get model(): string
    metrics: Metrics,
    session: AgentSession,
    showBlocks: number
}

interface SessionEventController extends Abortable {
    id: string,
    agent: string,
    prompt: (content: Content, signal: AbortSignal) => Promise<Content>
}

const buildPrompt = async (items: Content, options: PromptOptions): Promise<string> => {
    if (typeof items === 'string') return items

    let parts: string[] = []
    for (const item of items) {
        if (typeof item === 'string') {
            parts.push(item)
            continue
        }
        const transformer = getMatchingTransformer(item.mimeType)
        if (!transformer) continue

        const transformed = await transformer.transform(item, options)
        if (transformed) parts.push(transformed)
    }
    return parts.join(`\n\n`)
}

interface RunningPrompt {
    lastError: any
    stopReason: StopReason
    rawStopReason: string
    responses: (string | ContentItem)[]
    reject: (e: any) => void
}

function createSessionEventController(session: AgentSession, ctx: AgentSessionContext): SessionEventController {

    let runningPrompt: RunningPrompt | undefined
    const debugPrefix = '[EventController]'
    const sessionId = session.sessionId

    const updateDeltas = async (): Promise<void> => {
        await ctx.run.handleDeltaEvent({session: sessionId ?? '', deltas: deltaBlocks})
    }

    let lastBlockStats: Record<string, number> | undefined

    const getAndUpdateValueDeltas = (allMetrics: Metrics[], isStart = false, usage?: Usage) => {
        const metrics = ctx.metrics
        const sessionStats = ctx.session.getSessionStats()
        const valueStats = getStatsFromSessionStats(sessionStats, usage)
        metrics.setValues(valueStats)
        const valueDeltas = metrics.getValuesDelta(lastBlockStats)
        // check for empty and skip in this case
        for (const currMetrics of allMetrics) {
            currMetrics.valuesAdd(valueDeltas)
        }
        lastBlockStats = { ...valueStats, ...metrics.getFixTimerValues() }

        if (isStart) {
            return {
                deltas: { ...valueDeltas, ...metrics.getTimersDelta(lastBlockStats) },
                values: lastBlockStats,
                blockValueDeltas: valueDeltas
            }
        }
        return {
            deltas: {
                ...metrics.getValuesDelta(startSnapshot),
                ...metrics.getTimersDelta(startSnapshot)
            },
            values: lastBlockStats,
            blockValueDeltas: valueDeltas
        }
    }

    let startSnapshot: Record<string, number> | undefined
    const isRemoteRun = ctx.run.isRemoteRun()

    const updateStats = (scope: string, event: 'start' | 'end', timestamp: number, usage?: Usage): DeltasAndValues | undefined => {
        const metrics = ctx.metrics
        const allMetrics = [ctx.agent.metrics, ctx.run.metrics, ModelTracker.getModelMetrics(ctx.model), ModelTracker.totalMetrics]
        const isStart = event === 'start'
        for (const currMetrics of [metrics, ...allMetrics]) {
            isStart ?
                currMetrics.startTimer('time-' + scope, timestamp, sessionId) :
                currMetrics.stopTimer('time-' + scope, timestamp, sessionId)
        }

        if (scope === 'thinking' || scope === 'responding') {
            if (isRemoteRun) {
                ctx.run.sendToRootRun({
                    type: 'stats',
                    model: ctx.model,
                    timer: [scope, event, timestamp]
                })
            }
            return
        }
        const { values, deltas, blockValueDeltas } = getAndUpdateValueDeltas(allMetrics, isStart, usage)
        if (isRemoteRun) {
            ctx.run.sendToRootRun({
                type: 'stats',
                model: ctx.model,
                timer: [scope, event, timestamp],
                deltas: blockValueDeltas
            })
        }
        if (isStart) {
            startSnapshot = values
            return
        }
        if (statsDebug.enabled) {
            statsDebug(`[${ctx.model}] ${getReadableBlockStats(values, deltas)}`)
        }
        return {
            values,
            deltas
        }
    }

    const hasError = (message: AssistantMessage): boolean => {
        if (message.stopReason === 'stop' || message.stopReason === 'toolUse' || message.stopReason === 'pending') return false

        if (runningPrompt) {
            let error: any = ``
            switch (message.stopReason) {
                case "error":
                    error = message.errorMessage
                    break

                case "aborted":
                    error = new AbortError()
                    break

                default:
                    error = `Assistant stopped because of reason "${message.stopReason}"`
                    break
            }
            runningPrompt.lastError = error
        }
        return true
    }

    const showInout = (ctx.showBlocks & EXTRA_BLOCKS.INOUT) > 0
    const showThinking = (ctx.showBlocks & EXTRA_BLOCKS.THINKING) > 0
    const showTools = (ctx.showBlocks & EXTRA_BLOCKS.TOOLS) > 0
    const showPreview = (ctx.showBlocks & EXTRA_BLOCKS.PREVIEW) > 0

    const textDelta = showInout && showPreview
    const thinkingDelta = showThinking && showPreview
    const toolsDelta = showTools && showPreview

    let deltaBlocks: Record<number, DeltaBlock> = {}

    const startDelta = async (message: {contentIndex: number}, scope: "response" | "thinking" | "toolCall", model?: string) => {
        deltaBlocks[message.contentIndex] =
             {scope, text: '', updates: 0, last: false, consumed: false, model}
        await updateDeltas()
    }

    const addDelta = async (message: {contentIndex: number, delta: string}) => {
        const { contentIndex, delta } = message
        const block = deltaBlocks[contentIndex]
        if (!block) return

        block.text += delta
        block.updates++
        block.last = delta

        await updateDeltas()
    }

    const endDelta = async (message: {contentIndex: number}) => {
        const block = deltaBlocks[message.contentIndex]
        if (!block) return

        block.last = true
        await updateDeltas()
        delete deltaBlocks[message.contentIndex]
    }

    const toolCallIdToArgs = new Map<string, any>()

    const getNormalizedContent = (content: (TextContent | ThinkingContent | ToolCall | ImageContent)[] | string): Content => {
        if (typeof content === 'string') return content

        let found: ContentItem[] = []
        for (const item of content) {
            let trimmed = ''
            switch (item.type) {
                case 'text':
                    trimmed = item.text.trim()
                    if (trimmed.length) found.push(trimmed)
                    break

                case 'image':
                    const { mimeType, data } = item
                    found.push({ mimeType, content: data })
                    break
            }
        }
        if (!found.length) return ''

        if (found.some(item => typeof item !== 'string')) {
            const textParts = []
            const results: ContentItem[] = []
            for (const item of found) {
                if (typeof item === 'string') {
                    textParts.push(item)
                    continue
                }
                results.push(item)
            }
            results.unshift(textParts.join('\n\n'))

            return results
        }
        return found.join('\n\n')
    }

    const eventListener = async (event: AgentSessionEvent) => {
        try {
            const timestamp = Date.now()
            const getContextRef = () =>  ctx.session.sessionId
            switch (event.type) {
                // message streaming
                case 'message_update':
                    const { assistantMessageEvent } = event
                    switch (assistantMessageEvent.type) {

                        case 'text_start':
                            eventDebug('message_update:text_start')
                            updateStats('responding', 'start', timestamp)
                            if (textDelta) {
                                await startDelta(assistantMessageEvent, 'response', ctx.model)
                            }
                            break

                        case 'text_delta':
                            if (textDelta) {
                                await addDelta(assistantMessageEvent)
                            }
                            break

                        case 'text_end': {
                            eventDebug('message_update:text_end')
                            updateStats('responding', 'end', timestamp)
                            if (textDelta) {
                                await endDelta(assistantMessageEvent)
                            }
                            ctx.run.handleBlockEvent(
                                'response',
                                getNormalizedContent(assistantMessageEvent.content),
                                {
                                    session: getContextRef(),
                                    timestamp,
                                    subInfo: ctx.model
                                }
                            )
                            break
                        }

                        case 'thinking_delta':
                            if (thinkingDelta) {
                                await addDelta(assistantMessageEvent)
                            }
                            break

                        case "thinking_start":
                            eventDebug('message_update:thinking_start')
                            updateStats('thinking', 'start', timestamp)
                            if (thinkingDelta) {
                                await startDelta(assistantMessageEvent, 'thinking', ctx.model)
                            }
                            break

                        case "thinking_end":
                            eventDebug('message_update:thinking_end')
                            updateStats('thinking', 'end', timestamp)
                            if (thinkingDelta) {
                                await endDelta(assistantMessageEvent)
                            }
                            ctx.run.handleBlockEvent(
                                'thinking',
                                getNormalizedContent(assistantMessageEvent.content),
                                {
                                    session: getContextRef(),
                                    timestamp,
                                    subInfo: ctx.model
                                }
                            )
                            break

                        case "toolcall_start":
                            eventDebug('message_update:toolcall_start', event)
                            break

                        case "toolcall_end":
                            eventDebug('message_update:toolcall_end', assistantMessageEvent.toolCall)
                            break

                        case "toolcall_delta":
                            break

                        case "error":
                            eventDebug('message_update:error')
                            hasError(assistantMessageEvent.error)
                            break

                        default:
                            eventDebug(`message_update:${assistantMessageEvent.type}`)
                            break
                    }
                    break

                // tool execution
                case 'tool_execution_start':
                    eventDebug('tool_execution_start', event)
                    ctx.run.metrics.startTimer('time-tool-execution', timestamp, event.toolCallId)
                    await ctx.run.handleMessageInRootRun({
                        type: 'stats',
                        timer: ['tool-execution', 'start', timestamp]
                    }, true)
                    toolCallIdToArgs.set(event.toolCallId, event.args)
                    break

                case 'tool_execution_update':
                    break

                case 'tool_execution_end':
                    eventDebug('tool_execution_end', event)
                    const delta = ctx.run.metrics.stopTimer('time-tool-execution', timestamp, event.toolCallId)
                    await ctx.run.handleMessageInRootRun({
                            type: 'stats',
                            timer: ['tool-execution', 'end', timestamp]
                    }, true)
                    const deltasAndValues: undefined | DeltasAndValues = !delta ? undefined : {
                        values: ctx.run.metrics.getFixSnapshot(),
                        deltas: {
                            tools: delta
                        }
                    }
                    ctx.run.handleBlockEvent(
                        'tool-execution',
                        `${event.toolName}: ${JSON.stringify(toolCallIdToArgs.get(event.toolCallId), null, 4)}`,
                        {
                            timestamp,
                            isError: event.isError,
                            deltasAndValues: deltasAndValues
                        }
                    )
                    break

                // message lifecycle
                case 'message_start': {
                    const { message } = event
                    switch (message.role) {
                        case "assistant":
                            eventDebug('message_start:assistant')
                            startSnapshot = undefined
                            if (runningPrompt) {
                                runningPrompt.stopReason = message.stopReason
                                runningPrompt.rawStopReason = message.rawStopReason ?? ''
                            }
                            updateStats('session', 'start', timestamp)
                            break

                        case "user":
                            eventDebug('message_start:user')
                            updateStats('user', 'start', timestamp)
                            break

                        case "toolResult":
                            eventDebug('message_start:toolResult')
                            updateStats('user', 'start', timestamp)
                            break


                        default:
                            eventDebug(`message_start:${message.role}`)
                            break
                    }
                    break
                }

                case 'message_end': {
                    const { message } = event

                    switch (message.role) {
                        case "user":
                            eventDebug('message_end:user')
                            const deltasAndValues = updateStats('user', 'end', timestamp)
                            ctx.run.handleBlockEvent(
                                'prompt',
                                getNormalizedContent(message.content),
                                {
                                    session: getContextRef(),
                                    timestamp,
                                    subInfo: ctx.model,
                                    deltasAndValues
                                }
                            )
                            break

                        case "assistant": {
                            eventDebug('message_end:assistant')
                            const deltasAndValues = updateStats('session', 'end', timestamp, message.usage)
                            ctx.run.handleBlockEvent(
                                'session',
                                '',
                                {
                                    timestamp,
                                    subInfo: ctx.model,
                                    deltasAndValues
                                }
                            )
                            deltaBlocks = {}
                            if (hasError(message) || !runningPrompt) {
                                if (runningPrompt) runningPrompt.stopReason = message.stopReason
                                return
                            }
                            const normalized = getNormalizedContent(message.content)
                            if (typeof normalized === 'string') {
                                runningPrompt.responses.push(normalized)
                            } else {
                                runningPrompt.responses.push(...normalized)
                            }
                            break
                        }

                        case "toolResult": {
                            eventDebug('message_end:toolResult', message.toolName, toolCallIdToArgs.get(message.toolCallId), message.isError ? 'Error' : 'OK', getNormalizedContent(message.content))
                            const deltasAndValues = updateStats('user', 'end', timestamp, message.usage)
                            ctx.run.handleBlockEvent(
                                'tool-result',
                                getNormalizedContent(message.content),
                                {
                                    session: getContextRef(),
                                    timestamp,
                                    subInfo: ctx.model,
                                    deltasAndValues
                                }
                            )
                            break
                        }

                        default:
                            eventDebug(`message_end:${message.role}`)
                            break
                    }
                    break
                }

                case "compaction_start": {
                    eventDebug(event.type)
                    updateStats('compaction', 'start', timestamp)
                    break
                }

                case "compaction_end": {
                    eventDebug(event.type)
                    const deltasAndValues = updateStats('compaction', 'end', timestamp)
                    if (!event.aborted) {
                        ctx.run.handleBlockEvent(
                            'compaction',
                            event.result?.summary ?? (event.errorMessage ?? 'Unknown compaction error'),
                            {
                                timestamp,
                                subInfo: ctx.model,
                                deltasAndValues,
                                isError: event.result === undefined
                            }
                        )
                    }
                }

                default:
                    eventDebug(event.type)
                    return
            }
        } catch (e) {
            if (runningPrompt) {
                runningPrompt.reject(e)
            } else {
                throw e
            }
        }
    }

    const getAuthenticated = async (): Promise<boolean> => {
        const [provider] = ctx.model.split("/")

        const options: string[] = []
        if (ModelTracker.supportsSubscription(provider)) {
            options.push('subscription')
        }
        if (ModelTracker.supportsOAuth(provider)) {
            options.push('oauth')
        }
        if (!options.length) return false

        const using: string[] = []
        if (ModelTracker.isUsingSubscription(provider)) {
            using.push('subscription')
        }
        if (ModelTracker.isUsingOAuth(provider)) {
            using.push('oauth')
        }
        let option = options[0]
        if (using.length === 1 && options.includes(using[0])) {
            option = using[0]
        } else {
            if (options.length > 1) {
                // TODO: let the user decide
                console.log('PLEASE DECIDE....')
            }
        }
        switch (option) {
            case 'oauth':
                const currProvider = ModelTracker.getProvider(provider)
                if (!currProvider.auth.oauth) throw Error(`No oauth method found for provider "${provider}"`)

                const credentials = await currProvider.auth.oauth.login({
                    signal: new AbortController().signal,
                    prompt: async (authPrompt): Promise<string> => {
                        const msg = `Model "${ctx.model}" requires authentication. ${authPrompt.message}`
                        let inputType: InputType = 'text'
                        const options: Record<string, any> = {
                            prompt: msg
                        }
                        switch (authPrompt.type) {
                            // TODO check first 2 type
                            case "secret":
                            case "manual_code":
                            case "text":
                                break

                            case "select":
                                inputType = "select"
                                options.options = authPrompt.options.map(x => ({id: x.id, name: x.label }))
                                break
                        }
                        return (await ctx.run.getAbortableUserInput(inputType, options)) ?? ''
                    },
                    notify: (event) => {
                        const msgs = []
                        switch (event.type) {
                            case "auth_url":
                                msgs.push(`\nOpen this URL in your browser:\n${event.url}`)
                                if (event.instructions) msgs.push(event.instructions)
                                break

                            case "device_code":
                                msgs.push(`\nOpen this URL in your browser:\n${event.verificationUri}`)
                                msgs.push(`Enter code: ${event.userCode}`)
                                break;
                            case "info":
                            case "progress":
                                msgs.push(event.message)
                                break;
                        }
                        if (msgs.length) {
                            ctx.run.handleBlockEvent(
                                'assistant',
                                msgs.join('\n'),
                                {timestamp: Date.now()}
                            )
                        }
                    },
                })
                // TODO: validate that this is really working
                return true

            case 'subscription':
                const apiKey = (await ctx.run.getAbortableUserInput('text', {prompt: `Model "${ctx.model}" requires authentication. Please enter a valid API key`})) ?? ''
                await session.modelRuntime.setRuntimeApiKey(provider, apiKey)
                return true
        }
        return false
    }

    return {
        id: sessionId,
        agent: ctx.agent.id,
        abort: async (): Promise<void> => {
            try {
                session.abortBash()
                session.abortCompaction()
                session.abortBranchSummary()
                await session.abort()
            } catch (e) {}
        },
        prompt: async (msgOrArray: Content, signal: AbortSignal): Promise<Content> => {
            let abortHandler: undefined | (() => void)

            return new Promise<Content>(async (resolve, reject) => {
                let unsubscribe: undefined | (() => void)
                abortHandler = () => {
                    if (unsubscribe) unsubscribe()
                    reject(createAbortError(signal.reason))
                }
                try {
                    signal.addEventListener('abort', abortHandler, runOnce)
                    runningPrompt = {
                        lastError: undefined,
                        stopReason: 'pending',
                        rawStopReason: '',
                        responses: [],
                        reject
                    }
                    unsubscribe = session.subscribe(eventListener)
                    const options: PromptOptions = {}
                    const prompt = await buildPrompt(msgOrArray, options)

                    const modelId = ctx.model
                    if (ctx.agent.markModelAsUsed(modelId)) {
                        await ctx.run.handleMessageInRootRun({
                            type: 'model',
                            model: modelId
                        })
                    }
                    agentDebug(`${debugPrefix}[${modelId}] Prompting model:`, prompt, Array.isArray(options.images) ? options.images.map((x: ImageContent): string => x.mimeType) : [])
                    try {
                        await session.prompt(prompt, options)
                    } catch (e) {
                        let isAuthenticated = false
                        if (typeof e === 'object' && e instanceof Error && e.message.includes('/login')) {
                            isAuthenticated = await getAuthenticated()
                        }
                        if (isAuthenticated) {
                            await session.prompt(prompt)
                        } else {
                            throw e
                        }
                    }

                    let normalizedText = ''
                    const normalizedItems: ContentItem[] = []
                    for (const item of runningPrompt.responses) {
                        if (typeof item === 'string') {
                            normalizedText += item
                        } else {
                            normalizedItems.push(item)
                        }
                    }
                    switch (runningPrompt.stopReason) {
                        case "aborted":
                            reject(new AbortError())
                            return

                        case "length":
                        case "error":
                            reject(runningPrompt.lastError)
                            return

                        case "stop":
                            // TODO check what to do here...
                            break
                    }
                    const response = normalizedItems.length ? [normalizedText, ...normalizedItems] : normalizedText
                    agentDebug(`${debugPrefix}[${ctx.model}] Response from model:"`, response)
                    resolve(response)
                } catch (e) {
                    reject(e)
                } finally {
                    runningPrompt = undefined
                    unsubscribe!()
                    signal.removeEventListener('abort', abortHandler, runOnce)
                }
            })
        }
    }
}

class Agent {

    public static hashToSystemPrompt = new Map<string, string>()
    public static idToSystemPromptHashes = new Map<string, SystemPromptHash[]>()

    protected static settingsManager?: SettingsManager

    public static getSettingsManager(): SettingsManager {
        if (!Agent.settingsManager) {
            Agent.settingsManager = SettingsManager.create(process.cwd(), globalAgentDir)
        }
        return Agent.settingsManager
    }

    public readonly id: string
    public name: string
    public metrics: Metrics
    public lastSessionId?: string

    protected agentDir: string
    protected model: string
    protected systemPrompt?: string
    protected systemPromptOverride?: (base: string | undefined) => string | undefined
    protected appendSystemPrompt?: string[]
    protected appendSystemPromptOverride?: (base: string[]) => string[]
    protected additionalExtensionPaths: string[]
    protected additionalSkillPaths: string[]
    protected additionalPromptTemplatePaths: string[]
    protected extensionFactories: ExtensionFactory[]
    protected noExtensions
    protected noSkills
    protected noPromptTemplates
    protected noContextFiles
    protected extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult
    protected skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
        skills: Skill[]
        diagnostics: ResourceDiagnostic[]
    }
    protected promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
        prompts: PromptTemplate[]
        diagnostics: ResourceDiagnostic[]
    }
    protected agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
        agentsFiles: Array<{ path: string; content: string }>
    }
    protected thinkingLevel?: ThinkingLevel
    protected tools?: string[]
    protected noTools?: "all" | "builtin"
    protected customTools?: ToolDefinition[]
    protected skills: string[]
    protected autoRetry: boolean
    protected autoCompaction: boolean

    protected usedModels = new Set<string>()
    protected settingsManager: SettingsManager
    protected idToSession = new Map<string, AgentSession>()
    protected abortableSessions = new Map<string, AbortableSession>()
    protected config: AgentConfig

    public constructor(config: AgentConfig) {
        this.id = config.id
        this.name = config.name ?? config.id
        this.agentDir = config.agentDir ?? globalAgentDir
        this.settingsManager = this.agentDir === globalAgentDir ? Agent.getSettingsManager() : SettingsManager.create(process.cwd(), this.agentDir)
        this.model = config.model ?? 'default'
        this.systemPrompt = config.systemPrompt
        this.appendSystemPrompt = config.appendSystemPrompt
        this.tools = config.tools
        this.noTools = config.noTools
        this.customTools = config.customTools
        this.skills = config.skills ?? []
        this.thinkingLevel = config.thinkingLevel
        this.autoRetry = config.autoRetry ?? true
        this.autoCompaction = config.autoCompaction ?? true
        this.additionalExtensionPaths = config.additionalExtensionPaths ?? []
        this.additionalSkillPaths = config.additionalSkillPaths ?? []
        this.additionalPromptTemplatePaths = config.additionalPromptTemplatePaths ?? []
        this.extensionFactories = config.extensionFactories ?? []
        this.noExtensions = config.noExtensions === true
        this.noSkills = config.noSkills === true
        this.noPromptTemplates = config.noPromptTemplates === true
        this.noContextFiles = config.noContextFiles === true
        this.systemPromptOverride = config.systemPromptOverride
        this.appendSystemPromptOverride = config.appendSystemPromptOverride
        this.extensionsOverride = config.extensionsOverride
        this.skillsOverride = config.skillsOverride
        this.promptsOverride = config.promptsOverride
        this.agentsFilesOverride = config.agentsFilesOverride
        this.config = config

        this.metrics = createMetrics('agent', `Agent "${this.name}"`)
    }

    public getConfig(): AgentConfig {
        return this.config
    }

    public getUsedModels(): string[] {
        return [ ...this.usedModels.values() ]
    }

    public async update(props: Record<string, any>): Promise<void> {
        agentDebug(`[Agent: ${this.id}] Update properties`, props)
        const { model, thinkingLevel, tools, noTools, customTools, autoRetry, autoCompaction } = props
        if (this.lastSessionId) {
            //
            const session = this.getAgentSession(this.lastSessionId)
            if (model && model !== this.model) {
                const handler = this.getModelHandler(model)
                if (handler.isImageModel) {
                    throw Error(`Image model "${handler.id}" is not allowed as agent model`)
                }
                await session.setModel(handler.model)
            }
            if (thinkingLevel && thinkingLevel !== this.thinkingLevel) {
                session.setThinkingLevel(thinkingLevel)
            }
            // if tools is undefined we cannot set it via setActiveToolsByName()
            if (tools) {
                session.setActiveToolsByName(tools)
            }
            if (autoRetry !== undefined && autoRetry !== this.autoRetry) {
                session.setAutoRetryEnabled(autoRetry)
            }
            if (autoCompaction !== undefined && autoCompaction !== this.autoCompaction) {
                session.setAutoCompactionEnabled(autoCompaction)
            }
        }
        if (model) this.model = model
        if (thinkingLevel) this.thinkingLevel = thinkingLevel
        if ("tools" in props) {
            this.tools = tools
        }
        // the following 2 props cannot be changed on the current session, but will be used for new sessions
        if ("noTools" in props) this.noTools = noTools
        if ("customTools" in props) this.customTools = customTools

        if (autoRetry !== undefined) this.autoRetry = autoRetry
        if (autoCompaction !== undefined) this.autoCompaction = autoCompaction
    }

    public getSystemPrompt(sessionId: string, timestamp: number): string {
        const hashes = Agent.idToSystemPromptHashes.get(sessionId)
        if (!hashes) return ''

        let i = 0
        while (i < hashes.length && hashes[i].timestamp > timestamp) i++

        if (i === hashes.length) return ''

        return Agent.hashToSystemPrompt.get(hashes[i].hash) ?? ''
    }

    public getAgentSession(id: string): AgentSession {
        const session = this.idToSession.get(id)
        if (!session) throw Error(`Unknown session id "${id}" given for agent ${this.id}`)

        return session
    }

    public markModelAsUsed(model: string): boolean {
        this.usedModels.add(model)
        return ModelTracker.markAsUsed(model)
    }

    protected getModelHandler(model?: string): ModelHandler {
        let modelId = model ?? this.model
        if (modelId === 'default') {
            modelId = ModelTracker.getDefaultModelIdFromSettings(this.settingsManager)
            if (!modelId) {
                throw Error(`Couldn't find default model for agent "${this.id}. Please specify a model or set a default model and provider"`)
            }
        }
        return ModelTracker.getModelHandler(modelId)
    }

    protected async getNewAgentSession(run: WorkflowRun): Promise<AgentSession> {
        const extensionFactories: ExtensionFactory[] = [
            ...this.extensionFactories,
            (pi) => {
                pi.on('before_agent_start', (event: BeforeAgentStartEvent) => {
                    const hash = crypto.createHash('md5').update(event.systemPrompt).digest('hex')
                    run.handleMessageInRootRun({
                        type: 'systemPrompt',
                        hash,
                        session: session.sessionId,
                        timestamp: Date.now(),
                        prompt: event.systemPrompt
                    })
                })
            }
        ]
        const loader = new DefaultResourceLoader({
            cwd: process.cwd(),
            agentDir: this.agentDir,
            systemPrompt: this.systemPrompt,
            systemPromptOverride: this.systemPromptOverride,
            appendSystemPrompt: this.appendSystemPrompt,
            appendSystemPromptOverride: this.appendSystemPromptOverride,
            settingsManager: this.settingsManager,
            additionalExtensionPaths: this.additionalExtensionPaths,
            additionalSkillPaths: this.additionalSkillPaths,
            additionalPromptTemplatePaths: this.additionalPromptTemplatePaths,
            extensionFactories,
            noExtensions: this.noExtensions,
            noSkills: this.noSkills,
            noPromptTemplates: this.noPromptTemplates,
            noContextFiles: this.noContextFiles,
            extensionsOverride: this.extensionsOverride,
            skillsOverride: this.skillsOverride,
            promptsOverride: this.promptsOverride,
            agentsFilesOverride: this.agentsFilesOverride
        })
        await loader.reload()
        const handler = this.getModelHandler()
        if (handler.isImageModel) {
            throw Error(`Image model "${handler.id}" is not allowed as agent model`)
        }
        let sessionManager: SessionManager | undefined
        if (run.sessionsDir) {
            sessionManager = SessionManager.create(process.cwd(), run.sessionsDir)
        } else {
            sessionManager = SessionManager.inMemory()
        }
        const sessionResult = await createAgentSession({
            model: handler.model,
            sessionManager,
            tools: this.tools,
            noTools: this.noTools,
            customTools: this.customTools,
            thinkingLevel: this.thinkingLevel,
            resourceLoader: loader,
            modelRuntime: ModelTracker.modelRegistry,
//            authStorage: ModelTracker.authStorage,
//            modelRegistry: ModelTracker.modelRegistry
        })
        const { session } = sessionResult
        this.idToSession.set(session.sessionId, session)
        await run.handleMessageInRootRun({
            type: 'session',
            sessionId: session.sessionId,
            source: run.sessionsDir ? 'file' : 'memory',
            path: sessionResult.session.sessionFile ?? null
        })
        return session
    }

    public async getAbortableSession(run: WorkflowRun, sessionId?: string): Promise<AbortableSession> {
        if (sessionId) {
            const abortable = this.abortableSessions.get(sessionId)
            if (!abortable) throw Error(`Unknown agent session id "${sessionId}" requested`)

            return abortable
        }
        const session = await this.getNewAgentSession(run)

        sessionId = session.sessionId
        if (this.lastSessionId && true) {
            // TODO implement auto-dispose if we run in temp-mode
            const lastAbortable = this.abortableSessions.get(this.lastSessionId)
            // lastAbortable.dispose()
        }
        this.lastSessionId = sessionId

        const ctx: AgentSessionContext = {
            run,
            agent: this,
            get model(): string {
                return session.model?.provider + `/` + session.model?.id
            },
            metrics: createMetrics('session', sessionId),
            session,
            showBlocks: run.showBlocks
        }

        const abortable = createSessionEventController(session, ctx)

        this.abortableSessions.set(sessionId, abortable)
        return abortable
    }

    public async abort() {
        const sessions = [ ...this.idToSession.keys() ]
        try {
            const handler = this.getModelHandler()
            if (sessions.length) handler.abort(sessions)
        } catch (e) {}
        for (const session of this.idToSession.values()) {
            try {
                await session.abort()
                session.dispose()
            } catch (e) {
                console.error(e)
            }
        }
        this.idToSession.clear()
    }
}

class AgentRegistry {

    protected idToAgent: Map<string, Agent> = new Map()

    public addAgent(config: AgentConfig): Agent {
        if (this.idToAgent.has(config.id)) {
            throw Error(`Agent with id "${config.id}" does already exist`)
        }
        agentDebug(`Create new agent "${config.id}"`)
        const agent = new Agent(config)
        this.idToAgent.set(config.id, agent)
        return agent
    }

    public getAgent(agentId: string): Agent {
        const agent = this.idToAgent.get(agentId)
        if (agent === undefined) {
            if (agentId === 'default') {
                return this.addAgent({id: 'default'})
            }
            throw Error(`Unknown agent id "${agentId}" given`)
        }
        return agent
    }

    public async abort(): Promise<void> {
        for (const agent of this.idToAgent.values()) {
            await agent.abort()
        }
        this.idToAgent.clear()
    }

    public getUsedModels(): string[] {
        const used = new Set<string>()
        for (const agent of this.idToAgent.values()) {
            const models = agent.getUsedModels()
            for (const model of models) {
                used.add(model)
            }
        }
        return [ ...used.values() ]
    }

    public clear(): void {
        this.idToAgent.clear()
    }
}

export {
    FileItem,
    SystemPromptHash,
    ContentItem,
    Agent,
    AgentConfig,
    AgentRegistry,
    AgentSessionContext,
    AbortableSession
}