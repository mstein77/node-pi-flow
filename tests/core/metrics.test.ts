import { describe, expect, test } from "vitest"
import { createTimeTracker, createMetrics, createBudgets } from "../../src/core/metrics.ts"

describe('Metrics', () => {
    test('createTimeTracker()', () => {
        const tracker = createTimeTracker()
        expect(typeof tracker).toBe('object')

        expect(tracker.value()).toBe(0)
        expect(tracker.value(100)).toBe(0)

        tracker.add(1)
        expect(tracker.value()).toBe(1)
        expect(tracker.value(100)).toBe(1)

        expect(tracker.start('', 100)).toBe(100)
        expect(tracker.start('', 110)).toBe(100)
        expect(tracker.stop('', 150)).toBe(50)
        expect(tracker.value()).toBe(51)

        tracker.start('a', 200)
        expect(tracker.value(250)).toBe(101)

        // value should sum-up all running timers
        tracker.start('b', 300)
        expect(tracker.value(350)).toBe((350 - 300) + (350 - 200) + 51)

        tracker.stop('b', 350)
        expect(tracker.value(360)).toBe((350 - 200) + 111)

        tracker.abort('a', 400)
        expect(tracker.value(500)).toBe(200 + 50 + 51)

        tracker.reset()
        expect(tracker.value(550)).toBe(0)

        tracker.abort(['a', 'c'])
        expect(tracker.value(550)).toBe(0)
    })

    test('createMetrics()', () => {
        {
            const metrics = createMetrics('total', 'test')
            const snapshot = metrics.getSnapshot()
            expect(Object.keys(snapshot).sort()).toEqual([
                "cost",
                "prompts",
                "time-compaction",
                "time-responding",
                "time-thinking",
                "tokens-cacheRead",
                "tokens-cacheWrite",
                "tokens-input",
                "tokens-output",
                "tokens-total",
            ])
            expect(snapshot.cost).toBe(0)
            expect(snapshot['time-responding']).toBe(0)
            expect(snapshot.prompts).toBe(0)
            expect(snapshot['time-thinking']).toBe(0)
            expect(snapshot['tokens-input']).toBe(0)
            expect(snapshot['tokens-output']).toBe(0)
            expect(snapshot['tokens-total']).toBe(0)

            expect(metrics.isTimer('time-responding')).toBe(true)
            expect(metrics.isTimer('time-thinking')).toBe(true)
            expect(metrics.isTimer('cost')).toBe(false)
            expect(metrics.isTimer('prompts')).toBe(false)
            expect(metrics.isTimer('tokens-context')).toBe(false)
            expect(metrics.isTimer('tokens-input')).toBe(false)
            expect(metrics.isTimer('tokens-output')).toBe(false)
            expect(metrics.isTimer('tokens-total')).toBe(false)

            expect(metrics.isValue('time-responding')).toBe(false)
            expect(metrics.isValue('time-thinking')).toBe(false)
            expect(metrics.isValue('cost')).toBe(true)
            expect(metrics.isValue('prompts')).toBe(true)
            expect(metrics.isValue('tokens-context')).toBe(false)
            expect(metrics.isValue('tokens-input')).toBe(true)
            expect(metrics.isValue('tokens-output')).toBe(true)
            expect(metrics.isValue('tokens-total')).toBe(true)

            expect(metrics.isTokenValue('time-responding')).toBe(false)
            expect(metrics.isTokenValue('time-thinking')).toBe(false)
            expect(metrics.isTokenValue('cost')).toBe(false)
            expect(metrics.isTokenValue('prompts')).toBe(false)
            expect(metrics.isTokenValue('tokens-context')).toBe(false)
            expect(metrics.isTokenValue('tokens-input')).toBe(true)
            expect(metrics.isTokenValue('tokens-output')).toBe(true)
            expect(metrics.isTokenValue('tokens-total')).toBe(true)

            expect(metrics.valuesAdd({'prompts': 1, 'cost': 5, 'foo': 3})).toEqual({ 'prompts': 1, 'cost': 5 })
            expect(metrics.getSnapshotValue('prompts', 100)).toBe(1)
            expect(metrics.getSnapshotValue('cost', 100)).toBe(5)

            /*
             TODO: interface changed

            metrics.setValues({prompts: 2, cost: 6, foo: 7})
            expect(metrics.getSnapshotValue('prompts', 100)).toBe(1)
            expect(metrics.getSnapshotValue('cost', 100)).toBe(5)

            expect(metrics.valuesStop({prompts: 4, cost: 10, foo: 8}, 'a')).toEqual({prompts: 2, cost: 4})
            expect(metrics.getSnapshotValue('prompts', 100)).toBe(3)
            expect(metrics.getSnapshotValue('cost', 100)).toBe(9

             */
            expect(metrics.startTimer('time-responding', 150)).toBe(150)
            expect(metrics.getSnapshotValue('time-responding', 200)).toBe(50)
            expect(metrics.stopTimer('time-responding', 250)).toBe(100)
            expect(metrics.getSnapshotValue('time-responding', 300)).toBe(100)

            expect(metrics.startTimer('foo', 150)).toBeUndefined()
            expect(metrics.stopTimer('foo', 150)).toBeUndefined()
            expect(() => {
                metrics.getSnapshotValue('foo')
            }).toThrow('foo')

            metrics.startTimer('time-thinking', 200, 'a')
            metrics.abort(['a', 'b'], 250)
            expect(metrics.getSnapshotValue('time-thinking', 500)).toBe(50)

            metrics.reset()
            expect(snapshot.cost).toBe(0)
            expect(snapshot['time-responding']).toBe(0)
            expect(snapshot.prompts).toBe(0)
            expect(snapshot['time-thinking']).toBe(0)
            expect(snapshot['tokens-context']).toBeUndefined()
            expect(snapshot['tokens-input']).toBe(0)
            expect(snapshot['tokens-output']).toBe(0)
            expect(snapshot['tokens-total']).toBe(0)
        }
        {
            const metrics = createMetrics('model', 'test')
            const snapshot = metrics.getSnapshot()
            expect(Object.keys(snapshot).sort()).toEqual([
                "cost",
                "prompts",
                "time-compaction",
                "time-responding",
                "time-thinking",
                "tokens-cacheRead",
                "tokens-cacheWrite",
                "tokens-input",
                "tokens-output",
                "tokens-total",
            ])
        }
        {
            const metrics = createMetrics('run', 'test')
            const snapshot = metrics.getSnapshot()
            expect(Object.keys(snapshot).sort()).toEqual([
                "cost",
                "prompts",
                "time-awaiting",
                "time-compaction",
                "time-duration",
                "time-responding",
                "time-thinking",
                "time-tool-execution",
                "tokens-cacheRead",
                "tokens-cacheWrite",
                "tokens-input",
                "tokens-output",
                "tokens-total",
                "tool-calls"
            ])
            expect(snapshot['time-awaiting']).toBe(0)
            expect(snapshot['time-duration']).toBe(0)
            expect(snapshot['tool-calls']).toBe(0)
            expect(snapshot['time-tool-execution']).toBe(0)

            expect(metrics.isTimer('time-awaiting')).toBe(true)
            expect(metrics.isTimer('time-duration')).toBe(true)
            expect(metrics.isTimer('tool-calls')).toBe(false)
            expect(metrics.isTimer('time-tool-execution')).toBe(true)

            expect(metrics.isValue('time-awaiting')).toBe(false)
            expect(metrics.isValue('time-duration')).toBe(false)
            expect(metrics.isValue('tool-calls')).toBe(true)
            expect(metrics.isValue('time-tool-execution')).toBe(false)

            expect(metrics.isTokenValue('time-awaiting')).toBe(false)
            expect(metrics.isTokenValue('time-duration')).toBe(false)
            expect(metrics.isTokenValue('tool-calls')).toBe(false)
            expect(metrics.isTokenValue('time-toole-execution')).toBe(false)
        }

        {
            const metrics = createMetrics('agent', 'test')
            const snapshot = metrics.getSnapshot()
            expect(Object.keys(snapshot).sort()).toEqual([
                "cost",
                "prompts",
                "time-compaction",
                "time-responding",
                "time-thinking",
                "tokens-cacheRead",
                "tokens-cacheWrite",
                "tokens-input",
                "tokens-output",
                "tokens-total",
                "tool-calls",
            ])
        }

        {
            const metrics = createMetrics('session', 'test')
            const snapshot = metrics.getSnapshot()
            expect(Object.keys(snapshot).sort()).toEqual([
                "context-tokens",
                "context-usage",
                "context-window",
                "cost",
                "prompts",
                "time-compaction",
                "time-responding",
                "time-thinking",
                "tokens-cacheRead",
                "tokens-cacheWrite",
                "tokens-input",
                "tokens-output",
                "tokens-total",
                "tool-calls"
            ])
        }
    })

    test('createBudgets', () => {
        {
            const budgets = createBudgets()
            expect(budgets.addValueBudget('run', 'cost', 100)).toBe(budgets)
            expect(budgets.addTimeBudget('run', 'duration', 250))
            expect(budgets.addTimeBudget('run', 'time-thinking', {s: 5}))

            expect(budgets.checkScopeSnapshot('total', {})).toBeUndefined()
            expect(budgets.checkScopeSnapshot('run', {cost: 50, duration: 250})).toBeUndefined()

            expect(budgets.checkScopeSnapshot('run', {cost: 105})).toEqual({scope: 'run', key: 'cost', max: 100})
        }
    })
})