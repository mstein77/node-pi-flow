import './../core/stages.ts'
import {
    InputType,
    RunHandlers,
    Runner,
    Stage,
    createRunHandlers,
    Workflow,
    WorkflowResult,
    WorkflowRun
} from "../core/workflow.ts"
import {
    Messenger, createDownLinkMessageProcessor, AwaitMessage, UpLinkMessage, MessageWithoutTo,
    awaitNewResponse
} from "../core/messages.ts"

interface IpcMessenger extends Messenger {
    disconnect: () => void
}

class ForkRunner extends Runner {

    protected static _messenger: IpcMessenger | undefined

    public static get messenger(): IpcMessenger {
        if (ForkRunner._messenger === undefined) {
            throw Error(`No messenger created`)
        }
        return ForkRunner._messenger
    }

    public static createMessenger(runner: Runner, parentRunId: string, rootRunId: string): IpcMessenger {
        if (!process.on) {
            throw Error(`No IPC channel to create messenger`)
        }

        const sendUplink = (message: UpLinkMessage) => {
            if (process.connected && process.send) {
                process.send(message)
            }
        }

        const sendToRootRun = (message: MessageWithoutTo) => {
            sendUplink({
                ...message,
                to: rootRunId
            })
        }

        const getResponseFromRootRun = async (run: WorkflowRun, message: AwaitMessage): Promise<string> => {
            return awaitNewResponse(message, sendToRootRun, run)
        }
        const messenger = {
            sendToParentRun: (message: MessageWithoutTo) => {
                sendUplink({
                    ...message,
                    to: parentRunId
                })
            },
            sendToRootRun,
            getResponseFromRootRun,
            sendUplink,
            disconnect: () => {
                if (process.disconnect && process.connected) process.disconnect()
            }
        }
        process.on('message', createDownLinkMessageProcessor(messenger, runner))
        process.on('SIGTERM', () => {
            messenger.disconnect()
            runner.abort()
        })
        ForkRunner._messenger = messenger
        return messenger
    }

    public static async run(workflow: string | Workflow | Stage[], args: Record<string, any> = {}): Promise<WorkflowResult> {
        return await ForkRunner.runStatic(ForkRunner, workflow, args)
    }

    protected getRunHandlers(): RunHandlers {
        return createRunHandlers({
            messenger: ForkRunner.messenger,
            sendUplinkMessage: ForkRunner.messenger.sendUplink,
            input: (run: WorkflowRun, type: InputType, options: Record<string, any> = {}): Promise<string> => {
                return ForkRunner.messenger.getResponseFromRootRun(
                    run,
                    {
                        from: run.id,
                        type: 'input',
                        inputType: type,
                        options
                    }
                )
            }
        })
    }
}

export default ForkRunner