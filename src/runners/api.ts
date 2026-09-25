import './../core/stages.ts'
import {
    BlockEventDetails,
    BlockType, Content,
    EXTRA_BLOCKS,
    RunHandlers,
    Runner,
    RunnerConfig,
    Stage,
    Workflow,
    WorkflowResult,
    WorkflowRun,
    RunBindings, InputType
} from "../core/workflow.ts"
import express from "express"
import http from "node:http"
import { Request, Response, NextFunction } from 'express'
import { createRandomId } from "../core/helper.ts"
import bodyParser from "body-parser"
import { AwaitMessage, idToResolve, MessageWithoutTo, Messenger, UpLinkMessage } from "../core/messages.ts"

const DEFAULT_PORT = 8080
const SESSION_HEADER_NAME = 'X-ReqToken'

const parseJsonBody = bodyParser.json()

type OutputType = 'none' | 'text' | 'content' | 'blocks'

interface SessionDetails {
    id: string
    output: OutputType
    lastSeen: number
    runToOutput: Map<string, any[]>
    runToMessages: Map<string, UpLinkMessage[]>
}

interface ApiRunnerConfig extends RunnerConfig {
    port?: number
}

class ApiRunner extends Runner {

    protected readonly port: number

    protected idToResult = new Map<string, WorkflowResult>()
    protected sessionToDetails = new Map<string, SessionDetails>

    public static async run(workflow: Workflow | Stage[] | string, args: Record<string, any> = {}): Promise<WorkflowResult> {
        return await ApiRunner.runStatic(ApiRunner, workflow, args)
    }

    public constructor(config: ApiRunnerConfig = {}) {
        super(config)
        const { port = DEFAULT_PORT } = config
        this.port = port
    }

    protected handleBackgroundResult(result: WorkflowResult) {
        if (result.runId === null) return

        this.idToResult.set(result.runId, result)
    }

    protected async createAndStartServer(): Promise<void> {
        const app = express()
        const server = http.createServer(app)

        const assertValidSession = (req: Request<{ session: SessionDetails}>, res: Response, next: NextFunction): void | Response => {
            const sessionId = req.header(SESSION_HEADER_NAME)
            if (!sessionId) return res.sendStatus(401)

            const session = this.sessionToDetails.get(sessionId)
            if (!session) return res.sendStatus(401)

            session.lastSeen = Date.now()
            req.params.session = session
            next()
        }

        const loadAndAddRun = async (req: Request<{ run: string | WorkflowRun }>, res: Response, next: NextFunction): Promise<void> => {
            const run = typeof req.params.run === 'string' ? this.idToRun.get(req.params.run) : ''
            if (!run) {
                next(new Error(`Unknown run id "${run}" given`))
                return
            }
            req.params.run = run
            next()
        }

        app.post('/connect', parseJsonBody, (req: Request, res: Response) => {
            if (!req.body) return res.sendStatus(400)

            const sessionId = 'de5rgay-1789640184848' // createRandomId()
            this.sessionToDetails.set(
                sessionId,
                {
                    id: sessionId,
                    output: 'blocks',
                    lastSeen: Date.now(),
                    runToOutput: new Map<string, any[]>(),
                    runToMessages: new Map<string, UpLinkMessage[]>()
                }
            )
            res
                .setHeader(SESSION_HEADER_NAME, sessionId)
                .status(200)
                .json({
                    sessionId
                })
        })
        app.post('/run/:run/response', assertValidSession, parseJsonBody, (req: Request<{ session: SessionDetails }>, res: Response) => {
            if (typeof req.body !== 'object') {
                throw Error(`Expected message object in body but got ${typeof req.body}`)
            }
            const { type, awaitId, response } = req.body
            if (type !== 'awaitResponse' || !awaitId) {
                throw Error(``)
            }
            const resolve = idToResolve.get(awaitId)
            if (!resolve) {
                throw Error(`No resolve found for awaitid "${awaitId}"`)
            }
            idToResolve.delete(awaitId)
            resolve(response)
            res.status(200).json({status: 'ok'})
        })
        app.get('/workflows', assertValidSession, (req: Request<{ session: SessionDetails }>, res: Response) => {
            const workflows = this.registry.getAvailable()
            res.status(200).json({
                workflows
            })
        })
        app.post('/workflow/:workflow/start', assertValidSession, parseJsonBody, async (req: Request<{ workflow: string, session: SessionDetails }>, res: Response, next) => {
            const workflow = this.registry.get(req.params.workflow)
            if (!workflow) {
                next(new Error(`Unknown workflow`))
            }
            const { session } = req.params

            const id = await this.runInBackground(workflow, req.body ?? {}, {session: session.id})
            res.status(200).json({
                runId: id
            })
        })
        app.post('/workflow/:workflow/start/:root/:parent', assertValidSession, parseJsonBody, async (req: Request<{ workflow: string, root: string, parent: string, session: SessionDetails }>, res: Response, next) => {
            const { root, parent } = req.params
            const workflow = this.registry.get(req.params.workflow)
            if (!workflow) {
                next(new Error(`Unknown workflow`))
            }
            const { session } = req.params

            const id = await this.runInBackground(workflow, req.body ?? {}, {
                session: session.id,
                rootRunId: root,
                parentRunId: parent
            })
            res.status(200).json({
                runId: id
            })
        })
        app.get('/run/:run/status', assertValidSession, loadAndAddRun, (req: Request<{ run: WorkflowRun, session: SessionDetails }>, res: Response) => {
            const { run, session } = req.params
            const response: { id: string, status: string, result?: WorkflowResult, output?: any[], messages: UpLinkMessage[] } = {
                id: run.id,
                status: run.status,
                messages: []
            }
            if (session.output !== 'none') {
                const output: any[] = []
                const outputQueue = session.runToOutput.get(run.id)
                if (outputQueue) {
                    while (outputQueue.length) {
                        output.push(outputQueue.shift()!)
                    }
                }
                response.output = output
            }
            if (run.parentRunId && run.rootRunId) {
                const rootMessages = session.runToMessages.get(run.rootRunId)
                if (rootMessages) {
                    while (rootMessages.length) {
                        response.messages.push(rootMessages.shift()!)
                    }
                }
                const parentMessages = session.runToMessages.get(run.parentRunId)
                if (parentMessages) {
                    while (parentMessages.length) {
                        response.messages.push(parentMessages.shift()!)
                    }
                }
            }
            if (!run.isProcessing()) {
                response.result = this.idToResult.get(run.id)
            }
            res.status(200).json(response)
        })
        app.get('/run/:run/restart', assertValidSession, loadAndAddRun, (req: Request<{ run: WorkflowRun, session: SessionDetails }>, res: Response) => {
            const { run } = req.params
            run.restart({})
            res.status(200)
        })
        app.get('/run/:run/abort', assertValidSession, loadAndAddRun, (req: Request<{ run: WorkflowRun, session: SessionDetails }>, res: Response) => {
            const { run } = req.params
            run.abort('Aborted by request')
            res.status(200)
        })
        return new Promise<void>((resolve: () => void): void => {
            server.listen(this.port, () => {
                console.log(`Web server listening on port ${this.port}`)
                resolve()
            })
        })
    }

    protected async init(): Promise<void> {
        await super.init()

        if (!this.parentRunId) {
            return this.createAndStartServer()
        }
    }

    protected getSupportedExtraBlocks() {
        return EXTRA_BLOCKS.THINKING | EXTRA_BLOCKS.TOOLS | EXTRA_BLOCKS.INOUT
    }

    protected getRunHandlers(runId: string, bindings?: RunBindings): RunHandlers {
        let messenger: Messenger | undefined

        let renderBlock: (type: BlockType, content: Content, details: BlockEventDetails) => void = () => {}
        if (bindings) {
            const { session, parentRunId, rootRunId } = bindings
            if (!session) {
                throw Error(`No session id in binding given`)
            }
            const sessionDetails = this.sessionToDetails.get(session)
            if (!sessionDetails) throw Error(`No session found for session id "${session}"`)

            if (parentRunId && rootRunId) {
                const sendUplink = (message: UpLinkMessage): void => {
                    let messages = sessionDetails.runToMessages.get(message.to)
                    if (!messages) {
                        messages = []
                        sessionDetails.runToMessages.set(message.to, messages)
                    }
                    messages.push(message)
                }
                messenger = {
                    sendUplink,
                    sendToRootRun: (message: MessageWithoutTo): void => {
                        sendUplink({ ...message, to: rootRunId })
                    },
                    sendToParentRun: (message: MessageWithoutTo): void => {
                        sendUplink({ ...message, to: parentRunId })
                    },
                    getResponseFromRootRun: async (message: AwaitMessage): Promise<string> => {
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
                }
            }

            let output: any[] | undefined
            const getOutput = (): any[] => {
                if (output) return output

                output = []
                sessionDetails.runToOutput.set(runId, output)
                return output
            }
            switch (sessionDetails.output) {
                case 'text': {
                    renderBlock = (type: BlockType, content: Content, details: BlockEventDetails) => {
                        getOutput().push(type)
                    }
                    break
                }

                case 'content': {
                    renderBlock = (type: BlockType, content: Content, details: BlockEventDetails) => {
                        getOutput().push(content)
                    }
                    break
                }

                case 'blocks': {
                    renderBlock = (type: BlockType, content: Content, details: BlockEventDetails) => {
                        getOutput().push({ type, content, details })
                    }
                    break
                }
            }
        }
        return {
            ...super.getRunHandlers(runId, bindings),
            messenger,
            input: async (run: WorkflowRun, type: InputType, options: Record<string, any> = {}): Promise<string | void> => {
                if (!bindings) {
                    throw Error('Not supported!')
                }
                if (messenger) {
                    return messenger.getResponseFromRootRun({
                        from: run.id,
                        type: 'input',
                        inputType: type,
                        options
                    })
                }
                const { session } = bindings
                if (!session) {
                    throw Error(`xy`)
                }
                const sessionDetails = this.sessionToDetails.get(session)
                d('EXPECT SESSION', session)
            },
            renderBlock,
            sendUplinkMessage: (message: UpLinkMessage) => {
                if (messenger) messenger.sendUplink(message)
            }
        }
    }
}

export default ApiRunner