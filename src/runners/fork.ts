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
import { idToResolve, Messenger, createDownLinkMessageProcessor, AwaitMessage, UpLinkMessage, MessageWithoutTo } from "../core/messages.ts"
import { createRandomId } from "../core/helper.ts"

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
            if (process.send) {
                process.send(message)
            }
        }

        const sendToRootRun = (message: MessageWithoutTo) => {
            sendUplink({
                ...message,
                to: rootRunId
            })
        }

        const getResponseFromRootRun = async (message: AwaitMessage): Promise<string> => {
            const awaitId = message.awaitId ?? createRandomId()
            return new Promise<string>((resolve, reject) => {
                if (!rootRunId) return reject('XXX No active root run given')

                try {
                    idToResolve.set(awaitId, resolve)
                    sendUplink({
                        ...message,
                        awaitId,
                        to: rootRunId
                    })
                } catch (e) {
                    reject(e)
                }
            }).finally(
                () => {
                    idToResolve.delete(awaitId)
                }
            )
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
                return ForkRunner.messenger.getResponseFromRootRun({
                    from: run.id,
                    type: 'input',
                    inputType: type,
                    options
                })
            }
        })
    }
}

export default ForkRunner