import { performance }  from "node:perf_hooks"
import { describe, expect, test } from 'vitest'
import {
    Workflow,
    WorkflowRegistry,
    Runner,
    Stage,
    StageConfig
} from '../src/core/workflow.ts'
import {
    doNoop,
    doWait,
    doError,
    doAskUser,
    doWorkflow,
    doAwait,
    doText,
    doReturn
} from '../src/core/stages.ts'
import { sleep } from '../src/core/helper.ts'
import TestRunner from "./test-runner.ts"

interface HistoryStageConfig extends StageConfig {
    history: Stage[]
}

class HistoryStage extends Stage {

    protected config: HistoryStageConfig

    constructor(config: HistoryStageConfig) {
        super('history', config)
        this.config = config
    }

    public async exec(state: any): Promise<any> {
        this.config.history.push(this)
        return this.config.history
    }
}

function doHistory(config: HistoryStageConfig): HistoryStage {
    return new HistoryStage(config)
}

describe('runner', () => {

    test('constructor()', () => {
        {
            const runner = new TestRunner()
            expect(runner).toBeInstanceOf(Runner)
            expect(runner.id).not.toBeUndefined()
        }
        {
            const registry = new WorkflowRegistry()
            registry.add(new Workflow())
            const runner = new TestRunner({ registry })
            expect(runner).toBeInstanceOf(Runner)
            expect(runner.id).not.toBeUndefined()
        }
    })

    test('run()', async () => {
        {
            const runner = new TestRunner()
            const result = await runner.run(new Workflow())
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
        }
        {
            const runner = new TestRunner()
            const result = await runner.run([
                doNoop()
            ])
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
        }
        {
            const runner = new TestRunner()
            const result = await runner.run([
                doError()
            ])
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
        }
        {
            // invalid label
            const runner = new TestRunner()
            const result = await runner.run(new Workflow([doNoop({label: 'test'}), doNoop({next: 'test2'})]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toContain('test2')
        }
        {
            // label already exists
            const runner = new TestRunner()
            const result = await runner.run(new Workflow([doNoop({label: 'test'}), doNoop({label: 'test'})]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toContain('test')
        }
        {
            const runner = new TestRunner()
            const firstStage = doHistory({history: []})
            const result = await runner.run(new Workflow([firstStage]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(Array.isArray(result.data)).toBe(true)
            expect(result.data.length).toBe(1)
            expect(result.data[0]).toBe(firstStage)
        }
        {
            // skip
            const runner = new TestRunner()
            const history: Stage[] = []
            const firstStage = doHistory({skip: true, history })
            const secondStage = doHistory({history})
            const result = await runner.run(new Workflow([firstStage, secondStage]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(Array.isArray(result.data)).toBe(true)
            expect(result.data.length).toBe(1)
            expect(result.data[0]).toBe(secondStage)
        }
        {
            // next
            const runner = new TestRunner()
            const history: Stage[] = []
            const firstStage = doHistory({next: 'test', history})
            const secondStage = doHistory({history})
            const thirdStage = doHistory({label: 'test', history})
            const result = await runner.run(new Workflow([firstStage, secondStage, thirdStage]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(Array.isArray(result.data)).toBe(true)
            expect(result.data.length).toBe(2)
            expect(result.data[0]).toBe(firstStage)
            expect(result.data[1]).toBe(thirdStage)
        }
        {
            // pending async stages should be aborted on complete
            const runner = new TestRunner()
            const start = performance.now()
            const result = await runner.run([
                doWait({async: true, ms: 1000}),
                doWait({async: true, ms: 1000})
            ])
            const duration = performance.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
            expect(duration < 200).toBe(true)
        }
        {
            // pending async stages should be aborted on sync error
            const runner = new TestRunner()
            const start = performance.now()
            const result = await runner.run([
                doWait({async: true, ms: 1000}),
                doWait({async: true, ms: 1000}),
                doError('test error')
            ])
            const duration = performance.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toContain('test error')
            expect(duration < 200).toBe(true)
        }
        {
            // error in async stage should result in error response
            const runner = new TestRunner()
            const start = performance.now()
            const result = await runner.run([
                doError({async: true}),
                doWait({ms: 1000})
            ])
            const duration = performance.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
            expect(duration < 200).toBe(true)
        }
        {
            // auto-abort of sync-stage and pending-wait-stages on async-error
            const runner = new TestRunner()
            const start = performance.now()
            const result = await runner.run([
                doWait({async: true, ms: 200, cb: () => {
                        throw Error('test error')
                    }}),
                doWait({async: true, s: 10}),
                doWait({s: 5})
            ])
            const duration = performance.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
            expect(duration < 220).toBe(true)
        }
        {
            // parallel workflows
            const runner = new TestRunner()
            const results = await Promise.all([
                runner.run(new Workflow([
                    doWait({ms: 200}),
                    doReturn(1)
                ])),
                runner.run(new Workflow([
                    doWait({ms: 200}),
                    doReturn(2)
                ])),
            ])
            const [result1, result2] = results
            expect(typeof result1).toBe('object')
            expect(result1.status).toBe('completed')
            expect(result1.data).toBe(1)

            expect(typeof result2).toBe('object')
            expect(result2.status).toBe('completed')
            expect(result2.data).toBe(2)

            expect(result1.runId).not.toBe(result2.runId)
        }
        {
            // empty sub-workflow stages
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({workflow: 'test'})]}),
                new Workflow({id: 'test', stages: []})
            ])
            const runner = new TestRunner({ registry })
            const result = await runner.run('main')
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
        }
        {
            // sync sub-workflow stages
            const history: Stage[] = []
            const stage1 = doHistory({history})
            const stage2 = doHistory({history})
            const stage3 = doHistory({history})
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [stage1, doWorkflow({workflow: 'test'}), stage3]}),
                new Workflow({id: 'test', stages: [stage2]})
            ])
            const runner = new TestRunner({ registry })
            const result = await runner.run('main')
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(Array.isArray(result.data)).toBe(true)
            expect(result.data.length).toBe(3)
            expect(result.data[0]).toBe(stage1)
            expect(result.data[1]).toBe(stage2)
            expect(result.data[2]).toBe(stage3)
        }
        {
            // async sub-workflow stages
            const history: Stage[] = []
            const stage1 = doHistory({history})
            const stage2 = doHistory({history})
            const stage3 = doHistory({history})
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({async: true, workflow: 'test'}), stage1, doWait({ms: 250}), stage3 ]}),
                new Workflow({id: 'test', stages: [doWait({ms: 100}), stage2]})
            ])
            const runner = new TestRunner({ registry })
            const result = await runner.run('main')
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(Array.isArray(result.data)).toBe(true)
            expect(result.data.length).toBe(3)
            expect(result.data[0]).toBe(stage1)
            expect(result.data[1]).toBe(stage2)
            expect(result.data[2]).toBe(stage3)
        }
        {
            // invalid sync sub-workflow error
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({workflow: 'test2'})]})
            ])
            const runner = new TestRunner({ registry })
            const result = await runner.run('main')
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).contains('test2')
        }
        {
            // invalid async sub-workflow error
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({async: true, workflow: 'test2'}), doWait({ms: 500})]})
            ])
            const runner = new TestRunner({ registry })
            const result = await runner.run('main')
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).contains('test2')
        }
        {
            // sync sub-workflow error
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({workflow: 'test'})]}),
                new Workflow({id: 'test', stages: [doError()]})
            ])
            const runner = new TestRunner({ registry })
            const result = await runner.run('main')
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
        }
        {
            // async sub-workflow with sync error
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({async: true, workflow: 'test'}), doWait({ms: 500})]}),
                new Workflow({id: 'test', stages: [doWait({ms: 100}), doError()]})
            ])
            const runner = new TestRunner({ registry })
            const start = performance.now()
            const result = await runner.run('main')
            const duration = performance.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
            expect(duration < 120).toBe(true)
        }
        {
            // async sub-workflow with async error
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({async: true, workflow: 'test'}), doWait({ms: 500})]}),
                new Workflow({id: 'test', stages: [doWait({ms: 100, cb: () => {
                    throw Error('test error')
                }}), doAwait()]})
            ])
            const runner = new TestRunner({ registry })
            const start = performance.now()
            const result = await runner.run('main')
            const duration = performance.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
            expect(duration < 120).toBe(true)
        }
        {
            // auto abort pending subworkflow on completed
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({async: true, workflow: 'test'}), doWait({ms: 100})]}),
                new Workflow({id: 'test', stages: [doWait({ms: 500})]})
            ])
            const runner = new TestRunner({ registry })
            const start = performance.now()
            const result = await runner.run('main')
            const duration = performance.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
            expect(duration < 125).toBe(true)
        }
        {
            // ouput test
            const runner = new TestRunner()
            await runner.run(new Workflow([
                doText({text: 'test'})
            ]))
            expect(runner.outputs.length).toBe(1)
            expect(runner.outputs[0]).toBe('test')
        }
        {
            // await all without async stages should continue
            const runner = new TestRunner()
            const result = await runner.run(new Workflow([
                doAwait(),
                doReturn('done')
            ]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBe('done')
        }
        {
            // await for unknown async id should return an error
            const runner = new TestRunner()
            const result = await runner.run(new Workflow([
                doAwait('none'),
            ]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toContain('none')
        }
        {
            // await all for a single result should work
            const runner = new TestRunner()
            const start = Date.now()
            const result = await runner.run(new Workflow([
                doWait({ms: 200, async: true}),
                doAwait(),
                doReturn('done')
            ]))
            const duration = Date.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBe('done')
            expect(duration >= 200).toBe(true)
        }
        {
            // await all for multiple results should work
            const runner = new TestRunner()
            const start = Date.now()
            const result = await runner.run(new Workflow([
                doWait({ms: 200, async: 'test'}),
                doWait({ms: 100, async: true}),
                doAwait(),
                doReturn('done')
            ]))
            const duration = Date.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBe('done')
            expect(duration >= 200).toBe(true)
        }
        {
            // await for a specific result should work
            const runner = new TestRunner()
            const start = Date.now()
            const result = await runner.run(new Workflow([
                doWait({ms: 100, async: 'test'}),
                doWait({ms: 1000, async: true}),
                doAwait('test'),
                doReturn('done')
            ]))
            const duration = Date.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBe('done')
            expect(duration < 1000 - 20).toBe(true)
        }
        {
            // await for a specific result should work
            const runner = new TestRunner()
            const start = Date.now()
            const result = await runner.run(new Workflow([
                doWait({ms: 100, async: 'test'}),
                doWait({ms: 250, async: 'test2'}),
                doAwait(['test', 'test2']),
                doReturn('done')
            ]))
            const duration = Date.now() - start
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBe('done')
            expect(duration >= 240).toBe(true)
        }
    })

    test('restart()', async () => {
        {
            const runner = new TestRunner()
            const result = await runner.run(new Workflow([doNoop()]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
            expect(typeof result.runId).toBe('string')
            const runId = result.runId

            const result2 = await runner.restart(result)
            expect(typeof result2).toBe('object')
            expect(result2.status).toBe('completed')
            expect(result2.data).toBeUndefined()
            expect(typeof result2.runId).toBe('string')
            expect(result2.runId).toBe(runId)
        }
        {
            const runner = new TestRunner()
            const result = await runner.run(new Workflow([doError()]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
            const runId = result.runId

            const result2 = await runner.restart(result)
            expect(typeof result2).toBe('object')
            expect(result2.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result2.data.message).toBe('test error')
            expect(result2.runId).toBe(runId)
        }
        {
            let nextSkip = false
            const runner = new TestRunner()
            const result = await runner.run(new Workflow([
                doError({
                    skip: () => {
                        if (nextSkip) return true

                        nextSkip = true
                        return false
                    }
                })
            ]))
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
            const runId = result.runId

            const result2 = await runner.restart(result)
            expect(typeof result2).toBe('object')
            expect(result2.status).toBe('completed')
            expect(result2.data).toBeUndefined()
            expect(result2.runId).toBe(runId)
        }
        {
            const runner = new TestRunner()
            const results = await Promise.all([
                runner.run(new Workflow([doWait({ms: 500})])),
                sleep(0, () => runner.abort())
            ])
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(typeof result.runId).toBe('string')
            const runId = result.runId

            const result2 = await runner.restart(result)
            expect(typeof result2).toBe('object')
            expect(result2.status).toBe('completed')
            expect(result2.data).toBeUndefined()
            expect(typeof result2.runId).toBe('string')
            expect(result2.runId).toBe(runId)
        }
    })

    test('abort()', async () => {
        {
            const runner = new TestRunner()
            expect(() => runner.abort()).not.toThrow()
        }
        {
            const runner = new TestRunner()
            await runner.run(new Workflow([]))
            expect(() => runner.abort()).not.toThrow()
        }
        {
            const runner = new TestRunner()
            await runner.run(new Workflow([doError()]))
            runner.abort()
            expect(() => runner.abort()).not.toThrow()
        }
        {
            const runner = new TestRunner()
            await runner.run(new Workflow([doNoop()]))
            expect(() => runner.abort()).not.toThrow()
            expect(() => runner.abort()).not.toThrow()
        }
        {
            // abort before starting
            const runner = new TestRunner()
            const results = await Promise.all([
                runner.run([
                    doNoop({label: 'test'}),
                    doNoop({next: 'test'})
                ]),
                sleep(0, () => runner.abort())
            ])
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
        }
        {
            // abort sync-processing (infinite loop)
            const runner = new TestRunner()

            const start = performance.now()
            const results = await Promise.all([
                runner.run([
                    doNoop({label: 'test'}),
                    doNoop({next: 'test'})
                ]),
                sleep(100, () => runner.abort())
            ])
            const duration = performance.now() - start
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
            expect(duration < 120).toBe(true)
        }
        {
            // abort of sync wait stage
            const runner = new TestRunner()
            const start = performance.now()
            const results = await Promise.all([
                runner.run([
                    doWait({ms: 500})
                ]),
                sleep(200, () => runner.abort())
            ])
            const duration = performance.now() - start
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
            expect(duration < 220).toBe(true)
        }
        {
            // abort pending sync input
            const runner = new TestRunner()
            const start = performance.now()
            const results = await Promise.all([
                runner.run([
                    doAskUser("")
                ]),
                sleep(100, () => runner.abort())
            ])
            const duration = performance.now() - start
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
            expect(duration < 120).toBe(true)
        }
        {
            // abort pending async input
            const runner = new TestRunner()
            const start = performance.now()
            const results = await Promise.all([
                runner.run([
                    doWorkflow({ async: true, workflow: [
                        doAskUser()
                    ]}),
                    doWait({ms: 500})
                ]),
                sleep(100, () => runner.abort())
            ])
            const duration = performance.now() - start
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
            expect(duration < 120).toBe(true)
        }
        {
            // pending input error
            const runner = new TestRunner()
            runner.setInputError(new Error('test error'))
            const results = await Promise.all([
                runner.run([
                    doAskUser({})
                ])
            ])
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toContain('test error')
        }
        {
            // abort sync subworkflow
            const runner = new TestRunner()
            const start = performance.now()
            const results = await Promise.all([
                runner.run([
                    doWorkflow(
                        {
                            workflow: [
                                doWait({s: 5}),
                            ]
                        }
                    )
                ]),
                sleep(100, () => runner.abort())
            ])
            const duration = performance.now() - start
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
            expect(duration < 120).toBe(true)
        }
        {
            // abort async subworkflow
            const runner = new TestRunner()
            const start = performance.now()
            const results = await Promise.all([
                runner.run([
                    doWorkflow(
                        {
                            async: true,
                            workflow: [
                                doWait({s: 5}),
                            ]
                        }
                    ),
                    doAwait()
                ]),
                sleep(100, () => runner.abort())
            ])
            const duration = performance.now() - start
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
            expect(duration < 120).toBe(true)
        }
        {
            // async sub-workflow stages
            const history: Stage[] = []
            const stage1 = doHistory({history})
            const stage2 = doHistory({history})
            const stage3 = doHistory({history})
            const registry = new WorkflowRegistry([
                new Workflow({id: 'main', stages: [doWorkflow({async: true, workflow: 'test'}), stage1, doWait({ms: 300}), stage3 ]}),
                new Workflow({id: 'test', stages: [doWait({ms: 100}), stage2]})
            ])
            const runner = new TestRunner({ registry })
            const start = performance.now()
            const results = await Promise.all([
                runner.run('main'),
                sleep(200, () => runner.abort())
            ])
            const duration = performance.now() - start
            const result = results[0]
            expect(typeof result).toBe('object')
            expect(result.status).toBe('aborted')
            expect(typeof result.data).toBe('object')
            expect(result.data.reason).toContain('aborted')
            expect(duration < 220).toBe(true)
        }
    })

    test('::run()', async () => {
        {
            const result = await TestRunner.run([])
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
        }
        {
            const result = await TestRunner.run(new Workflow())
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
        }
        {
            const result = await TestRunner.run([doNoop()])
            expect(typeof result).toBe('object')
            expect(result.status).toBe('completed')
            expect(result.data).toBeUndefined()
        }
        {
            const result = await TestRunner.run([doError()])
            expect(typeof result).toBe('object')
            expect(result.status).toBe('error')
            expect(typeof result.data).toBe('object')
            expect(result.data.message).toBe('test error')
        }
    })
})
