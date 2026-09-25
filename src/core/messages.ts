import {
    runIdToRun,
    Runner,
    WorkflowResult,
    WorkflowRun,
    WorkflowStatus,
    InputType,
    Content,
    BlockEventDetails, DeltaEvent, BlockType
} from "./workflow.ts"
import Debug from "debug"
import { createRandomId } from "./helper.ts"
import { getErrorMessage } from "./helper.ts"

const debug = Debug('tyrolite:workflow:message')

interface BaseMessage {
    to: string
    from: string
}

interface MessageRegister extends BaseMessage {
    type: 'register'
    runId: string
}

interface MessageSession extends BaseMessage {
    type: 'session',
    sessionId: string,
    source: string,
    path: string | null
}

interface MessageError extends BaseMessage {
    type: 'error'
    error: string
}

interface MessageResult extends BaseMessage {
    type: 'result'
    result: WorkflowResult
}

interface MessageStatus extends BaseMessage {
    type: 'status',
    runId: string
    status: WorkflowStatus
}

interface MessageInput extends BaseMessage {
    type: 'input'
    awaitId?: string
    inputType: InputType
    options: Record<string, any>
}

interface MessageModel extends BaseMessage {
    type: 'model'
    model: string
}

interface MessageStats extends BaseMessage {
    type: 'stats'
    model?: string
    timer: [scope: string, event: 'start' | 'end', timestamp: number]
    deltas?: Record<string, number>
}

interface MessageSystemPrompt extends BaseMessage {
    type: 'systemPrompt',
    hash: string
    session: string
    timestamp: number
    prompt: string
}

interface MessageBlock extends BaseMessage {
    type: 'block'
    blockType: BlockType
    content: Content
    details: BlockEventDetails
}

interface MessageDelta extends BaseMessage {
    type: 'delta'
    event: DeltaEvent
}

interface MessageWorkflow extends BaseMessage {
    type: 'workflow',
    name: string
    runId: string
    parentRunId?: string
}

type UpLinkMessage = MessageRegister | MessageResult | MessageStatus | Required<MessageInput> | MessageModel | MessageStats | MessageSystemPrompt | MessageBlock | MessageDelta | MessageError | MessageWorkflow | MessageSession

type DistributiveOmit<T, K extends PropertyKey> =
    T extends unknown ? Omit<T, K> : never

type MessageWithoutFromTo = DistributiveOmit<UpLinkMessage, 'from' | 'to'>
type MessageWithoutTo = DistributiveOmit<UpLinkMessage, 'to'>
type AwaitMessage = DistributiveOmit<MessageInput, 'to'>

function isUpLinkMessage(message: any): message is UpLinkMessage {
    return typeof message === 'object'
        && ('type' in message)
        && ['register', 'status', 'result', 'input', 'model', 'stats', 'systemPrompt', 'block', 'delta', 'error', 'workflow', 'session'].includes(message.type)
}

function isAwaitMessage(message: Record<string, any>): message is AwaitMessage {
    return ('type' in message && ['input'].includes(message.type) && message.awaitId)
}

function isDownLinkMessage(message: any): message is DownLinkMessage {
    return typeof message === 'object'
        && ('type' in message)
        && ['awaitResponse'].includes(message.type)
}

interface MessageAwaitResponse {
    type: 'awaitResponse'
    awaitId: string
    response: any
}

type DownLinkMessage = MessageAwaitResponse

const idToResolve = new Map<string, ((result: any) => void)>()

function createDownLinkMessageProcessor(messenger: Messenger, runner: Runner) {
    return (message: any) => {
        debug(`Received downlink message"`, message)
        try {
            if (!isDownLinkMessage(message)) {
                throw Error(`Expected DownLinkMessage but got invalid "${typeof message}"`)
            }
            switch (message.type) {

                case 'awaitResponse':
                    const { awaitId, response } = message
                    const resolve = idToResolve.get(awaitId)
                    if (!resolve) {
                        throw Error(`Unknown awaitId "${awaitId}" given`)
                    }
                    resolve(response)
                    break

                default:
                    const _exhaust: never = message.type
                    return _exhaust
            }
        } catch (e) {
            const runnerId = runner.id
            messenger.sendToRootRun({
                type: 'error',
                from: runner.id,
                error: `DownLinkMessage-Processor of runner "${runnerId}" failed with: ${getErrorMessage(e)}`
            })
        }
    }
}

interface RemoteWorkflowController {
    sendDownLink: (message: DownLinkMessage) => void
    kill: () => void
    resolve: (result: WorkflowResult) => void
    reject: (error: any) => void
}

function createUpLinkMessageProcessor(run: WorkflowRun, controller: RemoteWorkflowController) {
    const { resolve, reject, sendDownLink, kill } = controller

    return async (message: UpLinkMessage): Promise<void> => {
        debug(`[${run.id}] Received uplink message for "${message.to}"`, message)
        try {
            if (!isUpLinkMessage(message)) {
                throw Error(`Expected UpLinkMessage but got invalid ${typeof message}`)
            }
            if (!run.mainRun.isKnownRunId(message.to)) {
                if (isAwaitMessage(message)) {
                    if (!run.messenger) {
                        throw Error(`No messenger available`)
                    }
                    const { awaitId } = message
                    const response = await run.messenger.getResponseFromRootRun(message)
                    sendDownLink({
                        type: 'awaitResponse',
                        awaitId,
                        response
                    })
                    return
                }
                run.mainRun.sendUplinkMessage(message)
                // Messenger.sendUplink(message)
                return
            }
            let targetRun: WorkflowRun | undefined = run
            if (message.to !== run.id) {
                targetRun = runIdToRun.get(message.to)!
            }
            if (!targetRun) {
                throw Error(`Unknown run id "${message.to}" given`)
            }
            switch (message.type) {
                case 'result': {
                    resolve(message.result)
                    break
                }

                case 'input': {
                    const { inputType, options, awaitId } = message
                    const response = await targetRun.input(inputType, options)
                    sendDownLink({
                        type: 'awaitResponse',
                        awaitId,
                        response
                    })
                    break
                }

                case 'error': {
                    const { error } = message
                    throw error
                }

                case 'register':
                case 'status':
                case 'stats':
                case 'model':
                case 'block':
                case 'delta':
                case 'workflow':
                case 'session':
                case 'systemPrompt': {
                    await targetRun.handleMessage(targetRun, message)
                    break
                }

                default:
                    const _exhaust: UpLinkMessage = message
                    return _exhaust
            }
        } catch (e) {
            kill()
            reject(e)
        }
    }
}

interface Messenger {
    sendToParentRun: (message: MessageWithoutTo) => void
    sendToRootRun: (message: MessageWithoutTo) => void
    getResponseFromRootRun: (message: AwaitMessage) => Promise<string>
    sendUplink: (message: UpLinkMessage) => void
}

export {
    idToResolve,
    Messenger,
    AwaitMessage,
    createUpLinkMessageProcessor,
    createDownLinkMessageProcessor,
    RemoteWorkflowController,
    UpLinkMessage,
    DownLinkMessage,
    MessageWithoutTo,
    MessageWithoutFromTo,
    MessageStatus,
    MessageResult,
    MessageSession,
    MessageRegister,
    MessageSystemPrompt,
    MessageWorkflow,
    MessageBlock,
    MessageModel,
    MessageDelta,
    MessageStats,
}