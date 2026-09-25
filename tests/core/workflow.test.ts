import { describe, expect, test } from 'vitest'
import {
    Workflow,
    WorkflowRegistry,
    Stage,
    RunContext,
    WorkflowRun,
    createRunHandlers
} from '../../src/core/workflow.ts'
import { Agent } from '../../src/core/agent.ts'
import { NoopStage } from '../../src/core/stages.ts'
import { ModelTracker } from "../../src/core/model.ts"

const runContext: RunContext = {
    get signal(): AbortSignal { return new AbortSignal() },
    get agent(): Agent { return new Agent({id: 'default'}) },

    run: new WorkflowRun('1', new Workflow([]), createRunHandlers(), {
        showBlocks: 0,
        registry: new WorkflowRegistry([], { autoLoad: false })
    }),
    modelRegistry: ModelTracker.modelRegistry
}

describe('Stage', () => {
    test('constructor()', () => {
        {
            const stage = new NoopStage()
            expect(stage).toBeInstanceOf(Stage)
            expect(stage.id).toBe('noop')
        }
    })

    test('get label()', () => {
        {
            const stage = new NoopStage()
            expect(stage.label).toBeUndefined()
        }
        {
            const stage = new NoopStage({label: undefined})
            expect(stage.label).toBeUndefined()
        }
        {
            const stage = new NoopStage({label: 'test'})
            expect(stage.label).toBe('test')
        }
    })

    test('getNext()', () => {
        /*
        const runContext: RunContext = {
            get signal(): AbortSignal { return new AbortSignal() },
            get agent(): Agent { return new Agent({id: 'default'}) },

            run: new WorkflowRun('1', new Workflow([]), createRunHandlers(), {
                showBlocks: 0,
                registry: new WorkflowRegistry([], { autoLoad: false })
            }),
            modelRegistry: ModelTracker.modelRegistry
        }

         */
        {
            const stage = new NoopStage()
            expect(stage.getNext({}, runContext)).toBe(true)
        }
        {
            const stage = new NoopStage({next: undefined})
            expect(stage.getNext({}, runContext)).toBe(true)
        }
        {
            const stage = new NoopStage({next: true})
            expect(stage.getNext({}, runContext)).toBe(true)
        }
        {
            const stage = new NoopStage({next: false})
            expect(stage.getNext({}, runContext)).toBe(false)
        }
        {
            const stage = new NoopStage({next: 'test'})
            expect(stage.getNext({}, runContext)).toBe('test')
        }
        {
            const stage = new NoopStage({next: () => true})
            expect(stage.getNext({}, runContext)).toBe(true)
        }
        {
            const stage = new NoopStage({next: () => 'test'})
            expect(stage.getNext({}, runContext)).toBe('test')
        }
        {
            const stage = new NoopStage({next: (state) => state.value})
            expect(stage.getNext({value: 'test'}, runContext)).toBe('test')
        }
    })

    test('isSkip()', () => {
        {
            const stage = new NoopStage()
            expect(stage.isSkip({}, runContext)).toBe(false)
        }
        {
            const stage = new NoopStage({skip: undefined})
            expect(stage.isSkip({}, runContext)).toBe(false)
        }
        {
            const stage = new NoopStage({skip: true})
            expect(stage.isSkip({}, runContext)).toBe(true)
        }
        {
            const stage = new NoopStage({skip: () => true})
            expect(stage.isSkip({}, runContext)).toBe(true)
        }
        {
            const stage = new NoopStage({skip: (state) => state.value})
            expect(stage.isSkip({value: true}, runContext)).toBe(true)
        }
    })
})

describe('Workflow', () => {
    test('constructor()', () => {
        {
            const workflow = new Workflow()
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.id).not.toBeFalsy()
            expect(workflow.name).not.toBeFalsy()
            expect(workflow.id).toEqual(workflow.name)
            expect(workflow.stages.length).toBe(0)
        }
        {
            const workflow = new Workflow([])
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.id).not.toBeFalsy()
            expect(workflow.name).not.toBeFalsy()
            expect(workflow.id).toEqual(workflow.name)
            expect(workflow.stages.length).toBe(0)
        }
        {
            const workflow = new Workflow({})
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.id).not.toBeFalsy()
            expect(workflow.name).not.toBeFalsy()
            expect(workflow.id).toEqual(workflow.name)
            expect(workflow.stages.length).toBe(0)
        }
        {
            const workflow = new Workflow({stages: []})
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.id).not.toBeFalsy()
            expect(workflow.name).not.toBeFalsy()
            expect(workflow.id).toEqual(workflow.name)
            expect(workflow.stages.length).toBe(0)
        }
        {
            const workflow = new Workflow({id: 'test'})
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.id).toBe('test')
            expect(workflow.name).toBe('test')
            expect(workflow.stages.length).toBe(0)
        }
        {
            const workflow = new Workflow({id: 'test', name: 'name'})
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.id).toBe('test')
            expect(workflow.name).toBe('name')
            expect(workflow.stages.length).toBe(0)
        }
        {
            const workflow = new Workflow({name: 'test'})
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.id).not.toBe('test')
            expect(workflow.name).toBe('test')
            expect(workflow.stages.length).toBe(0)
        }
        {
            const testStage = new NoopStage()
            const workflow = new Workflow({stages: [testStage]})
            expect(workflow).toBeInstanceOf(Workflow)
            expect(workflow.stages.length).toBe(1)
        }
    })

    test('add()', () => {
        {
            const workflow = new Workflow()
            expect(workflow.add([])).toBeInstanceOf(Workflow)
            expect(workflow.stages.length).toBe(0)

            const testStage = new NoopStage()
            expect(workflow.add(testStage)).toBeInstanceOf(Workflow)
            expect(workflow.stages.length).toBe(1)

            expect(workflow.add([testStage, testStage])).toBeInstanceOf(Workflow)
            expect(workflow.stages.length).toBe(3)
        }
    })
})

describe('WorkflowRegistry', () => {

    test('constructor()', () => {
        {
            const registry = new WorkflowRegistry()
            expect(registry).toBeInstanceOf(WorkflowRegistry)
        }
        {
            const registry = new WorkflowRegistry([])
            expect(registry).toBeInstanceOf(WorkflowRegistry)
        }
        {
            const registry = new WorkflowRegistry(new Workflow())
            expect(registry).toBeInstanceOf(WorkflowRegistry)
        }
        {
            const registry = new WorkflowRegistry([new Workflow()])
            expect(registry).toBeInstanceOf(WorkflowRegistry)
        }
        {
            const registry = new WorkflowRegistry([new Workflow(), new Workflow()])
            expect(registry).toBeInstanceOf(WorkflowRegistry)
        }
        {
            const workflow = new Workflow()
            const registry = new WorkflowRegistry([workflow, workflow])
            expect(registry).toBeInstanceOf(WorkflowRegistry)
        }
    })

    test('add()', () => {
        {
            const registry = new WorkflowRegistry()
            expect(registry.add([])).toBeInstanceOf(WorkflowRegistry)

            const workflow = new Workflow()
            expect(registry.add(workflow)).toBeInstanceOf(WorkflowRegistry)
            expect(registry.add([new Workflow(), new Workflow()])).toBeInstanceOf(WorkflowRegistry)
        }
        {
            const registry = new WorkflowRegistry()
            const workflow1 = new Workflow({id: 'id1'})
            expect(registry.add(workflow1)).toBeInstanceOf(WorkflowRegistry)

            expect(registry.add(new Workflow({id: 'id1'}))).toBeInstanceOf(WorkflowRegistry)

            expect(registry.add(new Workflow({id: 'id2', name: 'Test'}))).toBeInstanceOf(WorkflowRegistry)

            expect(registry.add([
                new Workflow({id: 'id3', name: 'Test2'}),
                new Workflow({id: 'id4', name: 'Test3'}),
            ])).toBeInstanceOf(WorkflowRegistry)

            expect(registry.add([new Workflow({id: 'id5'}), workflow1])).toBeInstanceOf(WorkflowRegistry)
        }
    })

    test('get()', () => {
        const registry = new WorkflowRegistry()
        expect(() => {
            registry.get('id1')
        }).toThrow('id1')

        const workflow1 = new Workflow({id: 'id1'})
        registry.add(workflow1)
        expect(registry.get('id1')).toBe(workflow1)

        const workflow2 = new Workflow({id: 'id1'})
        registry.add(workflow2)
        expect(registry.get('id1')).toBe(workflow2)
    })

    test('getAvailable()', async () => {
        {
            const registry = new WorkflowRegistry()
            const available = registry.getAvailable()
            expect(available).toEqual({})

            registry.add(new Workflow({id: 'id1'}))
            expect(registry.getAvailable()).toEqual({id1: 'id1'})

            registry.add(new Workflow({id: 'id2', name: 'Test 2'}))
            expect(registry.getAvailable()).toEqual({id1: 'id1', id2: 'Test 2'})
        }

        {
            const registry = new WorkflowRegistry(new Workflow(), {autoLoad: false})
            let available = registry.getAvailable()
            expect(Object.keys(available).length).toBe(0)

            await registry.init({})

            available = registry.getAvailable()
            const firstKey = Object.keys(available)[0]
            expect(firstKey).not.toEqual('')
            expect(available[firstKey]).toEqual(firstKey)
        }
    })
})
