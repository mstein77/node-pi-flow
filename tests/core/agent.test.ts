import TestRunner from "../test-runner.ts"
import { afterEach, describe, expect, test } from "vitest"
import { ModelTracker } from "./../../src/core/model.ts"
import { RegisterFauxProviderOptions, fauxAssistantMessage, FauxProviderHandle, FauxResponseStep, fauxProvider, createModels, Model, registerApiProvider, unregisterApiProviders } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js"
import {
    doReturn,
    doNoop,
    doWait,
    doError,
    doAskUser,
    doWorkflow,
    doText,
    doAskAgent,
    doNewAgent,
    doCustom, doUpdateAgent, doAwait
} from '../../src/core/stages.ts'
import { RunContext } from "../../src/core/workflow.ts";
import { sleep } from "../../src/core/helper.ts";

const models = createModels()
let fauxCount = 0

interface FauxHandle {
    faux: FauxProviderHandle
    apiKey: string
    model: Model<string>
    unregister: () => void
}

function createFauxModel(reasoning: boolean, options: Partial<RegisterFauxProviderOptions> = {}): FauxHandle {

    const faux = fauxProvider({
        provider: `faux-${++fauxCount}`,
        models: [
            {
                id: reasoning ? "reasoning-model" : "non-reasoning-model",
                reasoning,
                contextWindow: 200000,
                maxTokens: 1000
            },
        ],
        ...options
    })
    models.setProvider(faux.provider)
    const apiKey = `faux-provider-${Math.random().toString(36).slice(2, 10)}`
    registerApiProvider({ api: faux.api, stream: faux.provider.streamSimple, streamSimple: faux.provider.streamSimple }, apiKey)
    return {
        faux,
        apiKey,
        model: faux.getModel(),
        unregister: () => {
            unregisterApiProviders(apiKey)
        }
    }
}

describe("", () => {
    const cleanups: Array<() => Promise<void> | void> = []

    afterEach(async () => {
        while (cleanups.length > 0) {
            await cleanups.pop()?.()
        }
    })


    const registerFauxProviderFromHandle = (handle: FauxHandle, responses: FauxResponseStep[] = [] ) => {
        const { faux, apiKey } = handle
        handle.faux.setResponses(responses)
        const model = handle.faux.getModel()
        ModelTracker.registerProvider(model.provider, {
            baseUrl: model.baseUrl,
            apiKey,
            api:  faux.api,
            models: faux.models.map((registeredModel) => ({
                id: registeredModel.id,
                name: registeredModel.name,
                api: registeredModel.api,
                reasoning: registeredModel.reasoning,
                input: registeredModel.input,
                cost: registeredModel.cost,
                contextWindow: registeredModel.contextWindow,
                maxTokens: registeredModel.maxTokens,
            }))
        })
        cleanups.push(() => {
            ModelTracker.unregisterProvider(model.provider)
            handle.unregister()
        })
    }

    test('Asking for unknown agent should return an error', async () => {
        // test agent
        const runner = new TestRunner()
        const result = await runner.run([
            doAskAgent({agent: 'faux', prompt: 'test prompt'}),
        ])
        expect(typeof result).toBe('object')
        expect(result.status).toBe('error')
        expect(typeof result.data).toBe('object')
        expect(result.data.message).toContain('faux')
    })

    test('Creating an already existing agent return an error', async () => {
        const handle1 = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle1, [
                (_context, options) => {
                    return fauxAssistantMessage("test-1")
                }
            ]
        )
        const handle2 = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle2, [
                (_context, options) => {
                    return fauxAssistantMessage("test-2")
                }
            ]
        )
        const runner = new TestRunner()
        const result = await runner.run([
            doNewAgent({
                id: 'faux',
                model: handle1.faux.getModel()
            }),
            doNewAgent({
                id: 'faux',
                model: handle2.faux.getModel()
            })
        ])
        expect(typeof result).toBe('object')
        expect(result.status).toBe('error')
        expect(typeof result.data).toBe('object')
        expect(result.data.message).toContain('faux')
    })

    test('Create agent and prompt it', async () => {
        // test agent
        const handle = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    return fauxAssistantMessage("test response")
                }
            ]
        )


        let usedModels: string[] = []
        const runner = new TestRunner()
        const result = await runner.run([
            doNewAgent({
                id: 'faux',
                systemPrompt: 'Test',
                model: handle.model.provider + '/' + handle.model.id
            }),
            doAskAgent({agent: 'faux', prompt: 'test prompt'}),
            doCustom((state: any, ctx: RunContext) => usedModels = ctx.run.getUsedModels()),
            doReturn((state: any) => state.lastResponse)
        ])
        expect(typeof result).toBe('object')
        expect(result.data).toBe('test response')
        expect(result.status).toBe('completed')

        expect(usedModels.length).toBe(1)
        const model = usedModels[0]
        expect(model).toContain('/non-reasoning-model')

        const stats = ModelTracker.getModelStats()
        expect([model]).toEqual(usedModels)
        expect(typeof stats[model]).toBe('object')
        expect(stats[model].prompts).toBe(1)
    })

    test('Create agent in subworkflow and prompt it', async () => {
        // test agent
        const handle = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    return fauxAssistantMessage("test-response")
                }
            ]
        )
        const runner = new TestRunner()
        const result = await runner.run([
            doWorkflow([
                doNewAgent({
                    id: 'faux',
                    systemPrompt: 'Test',
                    model: handle.faux.getModel()
                }),
                doAskAgent({agent: 'faux', prompt: 'test prompt'}),
                doReturn((state: any) => state.lastResponse)
            ]),
            doReturn((state: any) => state.lastSubResult)
        ])
        expect(typeof result).toBe('object')
        expect(result.data).toBe('test-response')
        expect(result.status).toBe('completed')
    })

    test('Create agent in async subworkflow and prompt it', async () => {
        // test agent
        const handle = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    return fauxAssistantMessage("test-response")
                }
            ]
        )
        const runner = new TestRunner()
        const result = await runner.run([
            doWorkflow({
                workflow: [
                    doNewAgent({
                        id: 'faux',
                        systemPrompt: 'Test',
                        model: handle.faux.getModel()
                    }),
                    doAskAgent({agent: 'faux', prompt: 'test prompt'}),
                    doReturn((state: any) => state.lastResponse)
                ],
                async: 'sub'
            }),
            doAwait('sub'),
            doReturn((state: any) => state.lastSubResult)
        ])
        expect(typeof result).toBe('object')
        expect(result.data).toBe('test-response')
        expect(result.status).toBe('completed')
    })

    test('Create agent and switch model', async () => {
        const handle1 = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle1, [
                (_context, options) => {
                    return fauxAssistantMessage("test-1")
                }
            ]
        )
        const handle2 = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle2, [
                (_context, options) => {
                    return fauxAssistantMessage("test-2")
                }
            ]
        )
        let usedModels: string[] = []
        const runner = new TestRunner()
        const result = await runner.run([
            doNewAgent({
                id: 'faux',
                systemPrompt: 'Test',
                model: handle1.faux.getModel()
            }),
            doAskAgent({agent: 'faux', prompt: 'test prompt'}),
            doUpdateAgent({
                id: 'faux',
                model: handle2.faux.getModel()
            }),
            doAskAgent({agent: 'faux', prompt: 'test prompt2'}),
            doCustom((state: any, ctx: RunContext) => usedModels = ctx.run.getUsedModels()),
            doReturn((state: any) => state.lastResponse)
        ])
        expect(typeof result).toBe('object')
        expect(result.status).toBe('completed')
        expect(result.data).toBe('test-2')

        expect(usedModels.length).toBe(2)
        expect(usedModels[0]).toContain('faux')
        expect(usedModels[1]).toContain('faux')
        expect(usedModels[0]).not.toBe(usedModels[1])
    })

    test('Updating the default model should work', async () => {
        const handle = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    return fauxAssistantMessage("test")
                }
            ]
        )
        const runner = new TestRunner()
        const result = await runner.run([
            doUpdateAgent({
                id: 'default',
                model: handle.faux.getModel(),
                thinkingLevel: 'off',
                tools: ['read'],
                autoRetry: true,
                autoCompaction: false
            }),
            doAskAgent({prompt: 'test prompt'}),
            doUpdateAgent({
                id: 'default',
                thinkingLevel: 'low',
                tools: [],
                autoRetry: false,
                autoCompaction: true,
                noTools: undefined,
                customTools: undefined
            }),
            doReturn((state: any) => state.lastResponse)
        ])
        expect(typeof result).toBe('object')
        expect(result.status).toBe('completed')
        expect(result.data).toBe('test')
    })

    test('An error while streaming should result in an error', async () => {
        const handle = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    throw Error('Test error')
                }
            ]
        )
        const runner = new TestRunner()
        const result = await runner.run([
            doNewAgent({
                id: 'faux',
                systemPrompt: 'Test',
                model: handle.model
            }),
            doAskAgent({agent: 'faux', prompt: 'test prompt'}),
        ])
        expect(typeof result).toBe('object')
        expect(result.status).toBe('error')
        expect(typeof result.data).toBe('object')
        expect(result.data.message).toBe('Test error')
    })

    test('Context retrieval for unknown session should result in error', async () => {
        const handle = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    return fauxAssistantMessage("test response")
                }
            ]
        )
        const runner = new TestRunner()
        const result = await runner.run([
            doNewAgent({
                id: 'faux',
                systemPromptOverride: () => 'Test system prompt',
                noContextFiles: true,
                noTools: 'all',
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                model: handle.faux.getModel()
            }),
            doCustom(async (state, ctx) => {
                await ctx.run.getSessionContext('faux', 'xy')
            })
        ])
        expect(typeof result).toBe('object')
        expect(result.status).toBe('error')
        expect(typeof result.data).toBe('object')
        expect(result.data.message).toContain('xy')
    })

    test('Context retrieval for an agent session should work', async () => {
        const handle = createFauxModel(false)
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    return fauxAssistantMessage("test response")
                },
                (_context, options) => {
                    return fauxAssistantMessage("test response 2")
                },
            ]
        )
        let context1: any = []
        let context2: any = []
        let context3: any = []
        const runner = new TestRunner()
        const result = await runner.run([
            doNewAgent({
                id: 'faux',
                systemPromptOverride: () => 'Test system prompt',
                noContextFiles: true,
                noTools: 'all',
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                model: handle.faux.getModel()
            }),
            doAskAgent({agent: 'faux', prompt: 'test prompt'}),
            doCustom(async (state, ctx) => {
                context1 = await ctx.run.getSessionContext('faux', ctx.run.getAgent('faux').lastSessionId ?? '')
                state.lastTime = Date.now()
            }),
            doAskAgent({agent: 'faux', prompt: 'next prompt'}),
            doCustom(async (state, ctx) => {
                context2 = await ctx.run.getSessionContext('faux', ctx.run.getAgent('faux').lastSessionId ?? '')
                context3 = await ctx.run.getSessionContext('faux', ctx.run.getAgent('faux').lastSessionId ?? '', state.lastTime)
            }),
        ])
        expect(typeof result).toBe('object')
        expect(result.status).toBe('completed')

        expect(Array.isArray(context1)).toBe(true)
        expect(context1.length).toBe(3)
        const firstSystemPrompt = context1.shift()
        expect(firstSystemPrompt.role).toBe('system')
        expect(firstSystemPrompt.content.startsWith('Test system prompt')).toBe(true)
        expect(context1).toEqual([
            {role: 'user', content: 'test prompt', type: 'text'},
            {role: 'assistant', content: 'test response', type: 'text'}
        ])

        expect(Array.isArray(context2)).toBe(true)
        expect(context2.length).toBe(5)
        const secondSystemPrompt = context2.shift()
        expect(secondSystemPrompt).toEqual(firstSystemPrompt)
        expect(context2).toEqual([
            {role: 'user', content: 'test prompt', type: 'text'},
            {role: 'assistant', content: 'test response', type: 'text'},
            {role: 'user', content: 'next prompt', type: 'text'},
            {role: 'assistant', content: 'test response 2', type: 'text'}
        ])

        expect(Array.isArray(context3)).toBe(true)
        expect(context3.length).toBe(3)
        const thirdSystemPrompt = context3.shift()
        expect(thirdSystemPrompt).toEqual(firstSystemPrompt)
        expect(context3).toEqual([
            {role: 'user', content: 'test prompt', type: 'text'},
            {role: 'assistant', content: 'test response', type: 'text'}
        ])
    })

    test('Abort running agent session', async () => {
        const handle = createFauxModel(false, {tokensPerSecond: 4})
        registerFauxProviderFromHandle(
            handle, [
                (_context, options) => {
                    return fauxAssistantMessage("test response")
                }
            ]
        )
        const runner = new TestRunner()
        const results = await Promise.all([
            runner.run([
                doUpdateAgent({
                    id: 'default',
                    model: handle.faux.getModel()
                }),
                doAskAgent({prompt: 'test prompt'}),
                doReturn((state: any) => state.lastResponse)
            ]),
            sleep(200, () => runner.abort())
        ])
        const result = results[0]

        expect(typeof result).toBe('object')
        expect(result.status).toBe('aborted')
        expect(typeof result.data).toBe('object')
        expect(result.data.reason).toContain('aborted')
    })
})