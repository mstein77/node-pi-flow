import './../core/stages.ts'
import {
    ContextItem,
    BlockRendererConfig,
    BlockRenderer,
    RunnerConfig,
    BlockEventDetails,
    DeltaBlock,
    DeltaEvent,
    InputType,
    RunHandlers,
    Runner,
    EXTRA_BLOCKS,
    Stage,
    Workflow,
    WorkflowResult,
    WorkflowRun,
    BlockType,
    createRunHandlers, RunBindings
} from '../core/workflow.ts'
import { getReadableOffset, ucFirst } from "../core/helper.ts"
import { getReadableBlockStats } from "../core/metrics.ts"
import { ContentItem } from "../core/agent.ts"
import { getAbortableUserInput } from "../core/cli.ts"
import { restorePersistenceHandler } from "../core/persistence.ts"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import os from "node:os"

interface BlockStyle {
    colors?: string,
    innerLeft?: string
    innerRight?: string
    outerLeft?: string
    outerRight?: string
    trim?: boolean
}

const styles: BlockStyle[] = [
    { colors: 'assistant-tab', innerLeft: ' ', innerRight: ' ' },
    { colors: 'model-tab', innerLeft: ' ', innerRight: ' ' },
    { colors: 'user-tab', innerLeft: ' ', innerRight: ' ' },
    { colors: 'info-tab', innerLeft: ' ', innerRight: ' ' },
    { colors: 'tool-tab', innerLeft: ' ', innerRight: ' ' },
    { colors: 'error', innerLeft: ' ', innerRight: ' ' },
    { colors: 'meta' }
]

const STYLE_TAB_ASSISTANT = 0
const STYLE_TAB_MODEL = 1
const STYLE_TAB_USER = 2
const STYLE_TAB_INFO = 3
const STYLE_TAB_TOOL = 4
const STYLE_TAB_ERROR = 5
const STYLE_META = 6

const ANSI = '\x1b['

const colorSets: Record<string, number[]> = {
    'assistant-tab': [ 42 ],
    'user-tab': [ 44, 8 ],
    'info-tab': [ 7 ],
    'tool-tab': [ 46 ],
    'model-tab': [ 43, 30 ],
    'error': [ 41, 37 ],
    'meta': [ 90 ]
}

function getTerminalWidth() {
    const [width] = process.stdout.getWindowSize()
    return width ? width : 80
}

function getColoredString(text: string, colorSet: string) {
    const codes = colorSets[colorSet] ?? []
    let colored = ''
    let doReset = false
    for (const code of codes) {
        colored += ANSI + code + 'm'
        doReset = true
    }
    colored += text
    if (doReset) {
        colored += ANSI + 0 + 'm'
    }
    return colored
}

function getReadableStats(deltas: Record<string, number>): string {
    const parts = []
    for (const [name, delta] of Object.entries(deltas)) {
        const readable = getReadableOffset(delta)
        if (!readable) continue

        parts.push(
            `${ucFirst(name)}: +${readable}`
        )
    }
    return parts.join(' | ')
}


function getBlocks(items: string | (string | number)[]) {
    if (typeof items === 'string') items = [items]

    const parts = []
    let style: BlockStyle = {}
    for (let item of items) {
        if (typeof item === 'number') {
            style = styles[item]
            if (!style) throw Error(`Invalid style index ${item} given`)
        } else {
            let block = ''
            const { colors, innerLeft = '', innerRight = '', outerLeft = '', outerRight = '', trim = true } = style
            let codes: number[] = []
            if (colors !== undefined) {
                codes = colorSets[colors] ?? []
            }
            let doReset = false
            for (const code of codes) {
                block += ANSI + code + 'm'
                doReset = true
            }
            if (trim) item = item.trim()
            block += `${innerLeft}${item}${innerRight}`
            if (doReset) {
                block += ANSI + 0 + 'm'
            }
            parts.push(`${outerLeft}${block}${outerRight}`)
        }
    }
    return parts.join('')
}

function getPrintableContent(content: string | ContentItem[]) {
    if (typeof content === 'string') content = [content]

    let result = ''
    for (let item of content) {
        if (typeof item !== 'string') {
            item = getColoredString(`[File of type "${item.mimeType}"]`, 'meta')
        }
        result += `\n${item}\n`
    }
    return result
}

interface CliRunnerConfig extends RunnerConfig {

}


interface HeaderProps {
    timestamp?: number,
    left?: (string | number)[] | string
    right?: (string | number)[] | string
}

class CliRunner extends Runner {

    public static async run(workflow: Workflow | Stage[] | string, args: Record<string, any> = {}): Promise<WorkflowResult> {
        return await CliRunner.runStatic(CliRunner, workflow, args)
    }

    public static async inspect() {

        console.log('-------------------------------------')
        console.log(' INSPECTOR...')
        console.log('-------------------------------------')

        const handler = await restorePersistenceHandler()
        if (!handler) return

        const rootRuns = await handler.getRootRunIds()
        if (rootRuns.length === 1) {
            const mainRunId = rootRuns[0]

            const blocks = await handler.getSubtreeBlocks(mainRunId)
            const renderer = CliRunner.getNewBlockRenderer({
                sessionRetrieval: handler.sessionRetrieval
            })
            for (const block of blocks) {
                await renderer.renderBlock(...block)
            }
        }
    }

    public static async rebuildContext(link: string): Promise<void> {
        console.log('-------------------------------------')
        console.log(' REBUILD... ' + link)
        console.log('-------------------------------------')

        const handler = await restorePersistenceHandler()
        if (!handler) return

        await handler.deleteRootRunId('39081-1#1')

        let [sessionId, timestampString] = link.split('#')
        const timestamp = Number.parseInt(timestampString, 10)

        const session = await handler.getSession(sessionId)
        if (!session) throw Error(`Session id "${sessionId}" is not available`)

        const [, id, source, filePath] = session
        const systemPrompt = await handler.getSystemPrompt(id, timestamp)
        if (source === 'file') {
            const manager = SessionManager.open(filePath)
            const contextItems = await WorkflowRun.buildSessionContext(manager, timestamp, systemPrompt)
            await CliRunner.renderContextItems(contextItems)
        }
    }

    public static async renderContextItems(items: ContextItem[]): Promise<void> {
        for (const item of items) {
            let style = STYLE_TAB_INFO
            switch (item.role) {
                case "system":
                    break

                case "assistant":
                    style = STYLE_TAB_ASSISTANT
                    break

                case "user":
                    style = STYLE_TAB_USER
                    break

                case "toolResult":
                    style = STYLE_TAB_TOOL
                    break
            }
            const lines = [
                getBlocks([style, ucFirst(item.role)]),
                getPrintableContent(item.content)
            ]
            process.stdout.write(os.EOL + lines.join(os.EOL))
        }
    }

    protected static getNewBlockRenderer(config: BlockRendererConfig = {}): BlockRenderer {
        const { sessionRetrieval = false } = config

        let showHeader = true
        let lastHeaderTimestamp: number | undefined
        let lastDelta: DeltaBlock | undefined
        let lastUpdate = 0

        const getHeaderLine = (props: HeaderProps): string => {
            if (!showHeader) return ''

            let { left = [], right = [], timestamp = Date.now() } = props
            let line = '\n'

            if (lastHeaderTimestamp) {
                const duration = timestamp - lastHeaderTimestamp
                const readable = getReadableOffset(duration)
                if (readable !== '') {
                    if (!Array.isArray(right)) {
                        right = [right]
                    }
                    right.push(STYLE_META, readable)
                }
            }
            lastHeaderTimestamp = timestamp

            const rightBlocks = getBlocks(right)
            line += (' '.repeat(getTerminalWidth() - rightBlocks.length)) + rightBlocks
            line += '\r' + getBlocks(left) + '\n'

            return line
        }

        return {
            reset: () => {
                lastHeaderTimestamp = undefined
                lastDelta = undefined
                lastUpdate = 0
                lastUpdate = 0
            },
            renderDelta: (event: DeltaEvent): void => {
                let isFirst = true
                for (const block of Object.values(event.deltas)) {
                    if (block.consumed) continue

                    if (isFirst) {
                        if (block === lastDelta) {
                            if (block.last === true) {
                                block.consumed = true
                                lastUpdate = 0
                                lastDelta = undefined
                                if (block.scope !== 'response') {
                                    process.stdout.write('\n\n')
                                }
                            } else if (block.last && lastUpdate !== block.updates) {
                                if (block.updates === 1) {
                                    const left: (number | string)[]  = [
                                        STYLE_TAB_INFO, block.scope
                                    ]
                                    const { model } = block
                                    if (model) {
                                        left.push(STYLE_TAB_MODEL, model)
                                    }
                                    process.stdout.write(getHeaderLine({ left }))
                                }
                                process.stdout.write(block.last)
                                lastUpdate = block.updates
                            }
                        }
                    }
                    if (!block.consumed && lastDelta === undefined) {
                        lastDelta = block
                        if (block.updates > 0) {
                            const left: (number | string)[]  = [
                                STYLE_TAB_INFO, ucFirst(block.scope)
                            ]
                            const { model } = block
                            if (model) {
                                left.push(STYLE_TAB_MODEL, model)
                            }
                            process.stdout.write(getHeaderLine({ left }) + `\n${block.text}\n\n`)
                            if (block.last === true) {
                                block.consumed = true
                                lastDelta = undefined
                                lastUpdate = 0
                            }
                        }
                    }
                    isFirst = false
                }
            },
            renderBlock: async (blockType: BlockType, content: string | ContentItem[], details: BlockEventDetails) => {
                const { deltasAndValues, subInfo, isError = false } = details

                let print = true
                let showDeltas = deltasAndValues !== undefined
                let style = STYLE_TAB_INFO
                let subStyle = STYLE_TAB_MODEL
                let blockStats = true
                let contextRef = sessionRetrieval && details.session ? `${details.session}#${details.timestamp}` : undefined
                switch (blockType) {
                    case 'user':
                        blockStats = false
                        style = STYLE_TAB_USER
                        break

                    case 'assistant':
                        blockStats = false
                        style = STYLE_TAB_ASSISTANT
                        break

                    case 'prompt':
                    case 'session':
                    case 'tool-result':
                    case 'compaction':
                        // print = true // (this.show & SHOW.INOUT) > 0
                        break

                    case 'response':
                        // print = true // (this.show & SHOW.PREVIEW) === 0 && (this.show & SHOW.INOUT) > 0
                        break

                    case 'thinking':
                        // print = true // (this.show & SHOW.PREVIEW) === 0 && (this.show & SHOW.THINKING) > 0
                        break

                    case 'tool-execution':
                        style = STYLE_TAB_TOOL
                        blockStats = false
                        // print = true // (this.show & SHOW.PREVIEW) === 0 && (this.show & SHOW.TOOLS) > 0
                        break

                    case 'tool-call':
                        // print = true // (this.show & SHOW.TOOLS) > 0
                        break

                    default:
                        return
                }
                if (print) {
                    const left: (number | string)[] = [style, ucFirst(blockType)]
                    if (subInfo) {
                        left.push(subStyle, subInfo)
                    }
                    if (isError) {
                        left.push(STYLE_TAB_ERROR, 'Error')
                    }
                    process.stdout.write(getHeaderLine({ left, timestamp: details.timestamp }))
                    const printableContent = getPrintableContent(content)
                    if (printableContent.trim()) process.stdout.write(printableContent)
                    const metas = []
                    if (showDeltas && deltasAndValues) {
                        const readable =
                            blockStats ?
                                getReadableBlockStats(deltasAndValues.values, deltasAndValues.deltas) :
                                getReadableStats(deltasAndValues.deltas)

                        if (readable) {
                            metas.push(readable)
                        }
                    }
                    if (metas.length) {
                        process.stdout.write(`${getHeaderLine({ left: [STYLE_META, ...metas], timestamp: details.timestamp })}\n`)
                    }
                    if (contextRef) {
                        process.stdout.write(`${getHeaderLine({ left: [STYLE_META, `Link: ${contextRef}`], timestamp: details.timestamp })}\n`)
                    }
                }
            }
        }
    }

    constructor(config: CliRunnerConfig = {}) {
        super(config)
    }

    protected getSupportedExtraBlocks() {
        return /* SHOW.PREVIEW | */ EXTRA_BLOCKS.THINKING | EXTRA_BLOCKS.TOOLS | EXTRA_BLOCKS.INOUT
    }

    protected getRunHandlers(runId: string, bindings?: RunBindings) :RunHandlers {
        const renderer = CliRunner.getNewBlockRenderer({sessionRetrieval: (this.storageEngine?.config?.sessionRetrieval) ?? false})
        return createRunHandlers({
            restart: () => {
                renderer.reset()
            },
            renderDelta: renderer.renderDelta,
            renderBlock: renderer.renderBlock,
            input: async (run: WorkflowRun, type: InputType, options: Record<string, any> = {}): Promise<string | void> => {
                const { prompt } = options
                const parts = []
                const details = {timestamp: Date.now()}
                if (prompt) {
                    parts.push(prompt)
                }
                switch (type) {
                    case 'text': {
                        const msg = parts.join('\n')
                        if (msg) {
                            run.handleBlockEvent('assistant', prompt, details)
                        }
                        run.handleBlockEvent('user', '', details)
                        return getAbortableUserInput('', {signal: run.signal})
                    }

                    case 'select': {
                        let index = 0
                        const selectOptions = options.options
                        if (!selectOptions || !selectOptions.length) {
                            return Promise.reject("No options given for a user select")
                        }
                        parts.push('')
                        for (const { name } of selectOptions) {
                            index++
                            parts.push(`  ${index}: ${name}`)
                        }
                        parts.push('')
                        parts.push(`Enter number (1-${selectOptions.length}): `)

                        if (selectOptions.length === 1) {
                            return Promise.resolve(selectOptions[0].id)
                        }
                        const msg = parts.join('\n')
                        if (msg) {
                            run.handleBlockEvent('assistant', prompt, details)
                        }
                        run.handleBlockEvent('user', '', details)
                        return getAbortableUserInput(
                            parts.join('\n') + '\n',
                            {
                                signal: run.signal,
                                validate: (response: string) => {
                                    const parsed = Number.parseInt(response, 10)
                                    if (isNaN(parsed)) return false

                                    const option = selectOptions[parsed - 1]
                                    if (!option) return false

                                    return option.id
                                }
                            }
                        )
                    }
                }
            }
        })
    }
}

export default CliRunner