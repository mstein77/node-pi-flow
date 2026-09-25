import { getReadableOffset, TimeConfig, toTime, ucFirst, withSign } from "./helper.ts"
import { WorkflowRun, Runner } from "./workflow.ts"
import { clearInterval } from "node:timers"
import { ModelTracker } from "./model.ts"

interface TimeTracker {
    value: (now?: number) => number
    fixValue: () => number
    reset: () => void,
    add: (delta: number) => void,
    start: (id?: string, timestamp?: number) => number
    stop: (id?: string, timestamp?: number) => number
    abort: (ids: string | string[], timestamp?: number) => void
}

const createTimeTracker = (): TimeTracker => {
    let duration = 0
    const idToStarted: Map<string, number> = new Map()
    const tracker: TimeTracker = {
        value: (now: number = Date.now()): number => {
            let running = 0
            for (const started of idToStarted.values()) {
                running += now - started
            }
            return duration + running
        },
        fixValue: (): number => {
            return duration
        },
        reset: () => {
            idToStarted.clear()
            duration = 0
        },
        abort: (ids: string | string[], timestamp = Date.now()) => {
            if (!Array.isArray(ids)) ids = [ids]

            for (const id of ids) {
                tracker.stop(id, timestamp)
            }
        },
        add: (delta: number): void => {
            duration += delta
        },
        start: (id: string = '', timestamp: number = Date.now()): number => {
            const started = idToStarted.get(id)
            if (started !== undefined) return started

            idToStarted.set(id, timestamp)
            return timestamp
        },
        stop: (id: string = '', timestamp: number = Date.now()): number => {
            const started = idToStarted.get(id)
            if (started === undefined) {
                return 0
            }

            const delta = timestamp - started
            duration += delta
            idToStarted.delete(id)

            return delta
        }
    }
    return tracker
}

const createTimeTrackers = (names: string[]): Map<string, TimeTracker> => {
    const map: Map<string, TimeTracker> = new Map()
    for (const name of names) {
        map.set(name, createTimeTracker())
    }
    return map
}

const modelTimeTrackers = ['time-responding', 'time-thinking', 'time-compaction']
const modelValueTrackers = [
    'tokens-input', 'tokens-output', 'tokens-total', 'tokens-cacheRead', 'tokens-cacheWrite',
    'cost', 'prompts'
]
const agentTimeTrackers = [...modelTimeTrackers]
const agentValueTrackers = [...modelValueTrackers, 'tool-calls']
const runTimeTrackers = [...agentTimeTrackers, 'time-tool-execution', 'time-awaiting', 'time-duration']
const runValueTrackers = agentValueTrackers
const sessionTimeTrackers = [...agentTimeTrackers]
const sessionValueTrackers = [
    ...agentValueTrackers, 'context-tokens', 'context-window', 'context-usage'
]

interface Metrics {
    startTimer: (name: string, timestamp?: number, id?: string) => number | undefined
    stopTimer: (name: string, timestamp?: number, id?: string) => number | undefined
    setValue: (name: string, value: number) => void
    setValues: (nameToValue: Record<string, number>) => void
    getValuesDelta: (nameToValue: undefined | Record<string, number>) => Record<string, number>
    getTimersDelta: (nameToValue: undefined | Record<string, number>) => Record<string, number>
    valueAdd: (name: string, value: number) => number | undefined
    valuesAdd: (nameToValue: Record<string, number>) => Record<string, number>
    getSnapshot: (timestamp?: number) => Record<string, number>
    getFixSnapshot: () => Record<string, number>
    getFixTimerValues: () => Record<string, number>
    getSnapshotValue: (key: string, timestamp?: number) => number
    isValue: (name: string) => boolean
    isTimer: (name: string) => boolean
    isTokenValue: (name: string) => boolean
    isContextValue: (name: string) => boolean
    reset: () => void
    abort: (ids: string[], timestamp?: number) => void
}

type MetricsScope = 'total' | 'model' | 'agent' | 'session' | 'run'
const scopeToTimerNames: Record<MetricsScope, string[]> = {
    total: modelTimeTrackers,
    model: modelTimeTrackers,
    agent: agentTimeTrackers,
    session: sessionTimeTrackers,
    run: runTimeTrackers
}
const scopeToValueNames: Record<MetricsScope, string[]> = {
    total: modelValueTrackers,
    model: modelValueTrackers,
    agent: agentValueTrackers,
    session: sessionValueTrackers,
    run: runValueTrackers
}

interface DeltasAndValues {
    values: Record<string, number>
    deltas: Record<string, number>
}

const createMetrics = (scope: MetricsScope, name: string): Metrics => {
    const timers = createTimeTrackers(scopeToTimerNames[scope])
    const values: Record<string, number> = {}

    const resetValues = () => {
        for (const name of scopeToValueNames[scope]) {
            values[name] = 0
        }
    }
    resetValues()

    const startTimer = (name: string, timestamp: number = Date.now(), id?: string): number | undefined => {
        const tracker = timers.get(name)
        if (!tracker) return

        return tracker.start(id, timestamp)
    }
    const stopTimer = (name: string, timestamp: number = Date.now(), id?: string): number | undefined => {
        const tracker = timers.get(name)
        if (!tracker) return

        return tracker.stop(id, timestamp)
    }
    const setValue = (name: string, value: number) => {
        if (!(name in values)) return

        values[name] = value
    }
    const setValues = (nameToValue: Record<string, number>) => {
        for (const [name, value] of Object.entries(nameToValue)) {
            setValue(name, value)
        }
    }
    const valueAdd = (name: string, value: number): number | undefined => {
        if (!(name in values)) return

        values[name] += value
        return value
    }
    const valuesAdd = (nameToValue: Record<string, number>): Record<string, number> => {
        const result: Record<string, number> = {}
        for (const [name, value] of Object.entries(nameToValue)) {
            const delta = valueAdd(name, value)
            if (delta === undefined) continue

            result[name] = delta
        }
        return result
    }
    const getValuesDelta = (nameToValue?: Record<string, number>): Record<string, number> => {
        const result: Record<string, number> = {}
        if (!nameToValue) {
            for (const [ name, value ] of Object.entries(values)) {
                result[name] = value
            }
            return result
        }
        for (const [ name, value ] of Object.entries(nameToValue)) {
            if (!(name in values)) continue

            result[name] = values[name] - value
        }
        return result
    }

    const getTimersDelta = (nameToValue: undefined | Record<string, number>): Record<string, number> => {
        const result: Record<string, number> = {}
        if (!nameToValue) {
            for (const name of timers.keys()) {
                result[name] = 0
            }
            return result
        }
        for (const [ name, value ] of Object.entries(nameToValue)) {
            const tracker = timers.get(name)
            if (!tracker) continue

            result[name] = tracker.fixValue() - value
        }
        return result
    }

    const getFixTimerValues = (): Record<string, number> => {
        const result: Record<string, number> = {}
        for (const [ name, tracker ] of timers.entries()) {
            result[name] = tracker.fixValue()
        }
        return result
    }

    const abort = (ids: string[], timestamp = Date.now()): void => {
        for (const tracker of timers.values()) tracker.abort(ids, timestamp)
    }

    const reset = (): void => {
        resetValues()
        for (const tracker of timers.values()) tracker.reset()
    }


    const isValue = (name: string) => (name in values)
    const isTimer = (name: string) => timers.has(name)
    const isTokenValue = (name: string) => isValue(name) && name.startsWith('tokens-')
    const isContextValue = (name: string) => isValue(name) && name.startsWith('context-')

    const getSnapshot = (timestamp: number = Date.now()): Record<string, number> => {
        const result: Record<string, number> = { ...values }
        for (const [name, timer] of timers.entries()) result[name] = timer.value(timestamp)

        return result
    }

    const getFixSnapshot = (): Record<string, number> => {
        const result: Record<string, number> = { ...values }
        for (const [name, timer] of timers.entries()) result[name] = timer.fixValue()

        return result
    }

    const getSnapshotValue = (key: string, timestamp: number = Date.now()): number => {
        if (isValue(key)) {
            return values[key]
        }
        if (isTimer(key)) {
            return timers.get(key)!.value(timestamp)
        }
        throw Error(`Unknown snapshot key "${key}" given`)
    }

    return {
        startTimer,
        stopTimer,
        valueAdd,
        valuesAdd,
        setValue,
        setValues,
        getValuesDelta,
        getTimersDelta,
        isValue,
        isTimer,
        isTokenValue,
        isContextValue,
        getSnapshot,
        getFixSnapshot,
        getFixTimerValues,
        getSnapshotValue,
        reset,
        abort
    }
}

function getReadableContextStats(values: Record<string, number>, deltas: Record<string, number>): string {
    const deltaTokens = deltas['context-tokens']
    if (deltaTokens === undefined) return 'Context: n/a'

    if (deltaTokens === 0) return ''

    const tokens = values['context-tokens']
    const window = values['context-window']
    const usage = values['context-usage']
    const delta = deltaTokens !== 0 ? `(${withSign(deltaTokens.toLocaleString())}) ` : ``

    return `Context: ${tokens.toLocaleString()} ${delta}/ ${window.toLocaleString()} [=${usage.toFixed(2)}%]`
}

function getReadableTokenStats(values: Record<string, number>, deltas?: Record<string, number>): string {
    const isDelta = deltas !== undefined
    const total = values['tokens-total']
    if (total === 0 || (isDelta && deltas['tokens-total'] === 0)) return ''

    const format = isDelta ? withSign : (x: string): string => x
    const parts: string[] = []
    const ref = isDelta ? deltas : values
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const value = ref['tokens-' + key]
        if (value === 0) continue

        parts.push(`${key}: ${format(value.toLocaleString())}`)
    }
    const delta = isDelta ? `(${withSign(deltas['tokens-total'].toLocaleString())}) ` : ''

    return `Tokens: ${total.toLocaleString()} ${delta}[${parts.join(' ')}]`
}

function getReadableTimeStats(values: Record<string, number>, isDelta = false): string[] {
    const parts: string[] = []
    for (const key of ['time-duration', 'time-responding', 'time-thinking', 'time-compaction', 'time-awaiting', 'time-tools']) {
        const duration = values[key] ?? 0
        const readableDuration = getReadableOffset(duration)
        if (readableDuration === '') continue

        parts.push(`${ucFirst(key)}: ${(isDelta ? '+' : '') + readableDuration}`)
    }
    return parts
}

function getReadableValueStats(values: Record<string, number>, isDelta = false): string[] {
    const parts: string[] = []
    const cost = values['cost'] ?? 0
    const prefix = isDelta ? '+' : ''
    if (cost !== 0) {
        parts.push(`Cost: ${prefix + cost.toFixed(2)}$`)
    }
    if (!isDelta) {
        const prompts = values['prompts'] ?? 0
        if (prompts > 0) {
            parts.push(`Prompts: ${prompts.toLocaleString()}`)
        }
        const toolCalls = values['toolCalls'] ?? 0
        if (toolCalls > 0) {
            parts.push(`Tool-Calls: ${toolCalls.toLocaleString()}`)
        }
    }
    return parts
}

function getReadableBlockStats(values: Record<string, number>, deltas: Record<string, number>): string {
    const parts: string[] = [
        getReadableContextStats(values, deltas),
        getReadableTokenStats(values, deltas),
        ...getReadableValueStats(values, true),
        ...getReadableTimeStats(deltas, true)
    ]
    return parts.filter(x => x.length).join(' | ')
}

function getReadableModelStats(values: Record<string, number>): string {
    const parts: string[] = [
        getReadableTokenStats(values),
        ...getReadableValueStats(values, false),
        ...getReadableTimeStats(values, false)
    ]
    return parts.filter(x => x.length).join(' | ')
}

interface ExceededItem {
    scope: MetricsScope
    key: string
    max: number
}

interface Budgets {
    addValueBudget: (scope: MetricsScope, key: string, value: number) => Budgets
    addTimeBudget: (scope: MetricsScope, key: string, numberOrTimeObj: number | TimeConfig) => Budgets
    checkScopeSnapshot: (scope: MetricsScope, snapshot: Record<string, number>) => ExceededItem | void
}

const createBudgets = (): Budgets => {
    const budgets: Partial<Record<MetricsScope, [string, number][]>> = {}

    const api: Budgets = {
        addValueBudget: (scope: MetricsScope, key: string, value: number): Budgets => {
            if (!budgets[scope]) {
                budgets[scope] = []
            }
            budgets[scope].push([key, value])
            return api
        },
        addTimeBudget: (scope: MetricsScope, key: string, numberOrTimeObj: number | TimeConfig): Budgets => {
            if (typeof numberOrTimeObj !== 'number') {
                numberOrTimeObj = toTime(numberOrTimeObj)
            }
            api.addValueBudget(scope, key, numberOrTimeObj)
            return api
        },
        checkScopeSnapshot: (scope: MetricsScope, snapshot: Record<string, number>) => {
            const keyMaxTuples = budgets[scope]
            if (!keyMaxTuples) return

            for (const [key, max] of keyMaxTuples) {
                if (snapshot[key] > max) return { scope, key, max }
            }
        }
    }
    return api
}

interface BudgetManagerApi {
    setCheckInterval: (newInterval: number | TimeConfig) => void
    setRootRunner: (runner: Runner) => void
    setBudgets: (budgets: Budgets) => void
    getBudgets: () => Budgets | void
    startRun: (run: WorkflowRun) => void
    stopRun: (run: WorkflowRun) => void
}

const createBudgetManager = (): BudgetManagerApi => {
    let checkInterval = 1000
    let rootRunner: Runner | undefined
    let budgets: Budgets | undefined
    let interval: any
    let lastTotalSnapshot: Record<string, number>

    const runs = new Set<WorkflowRun>

    const startTrackingInterval = (): void => {
        interval = setInterval(() => {
            const now = Date.now()
            for (const run of runs) {
                const snapshot = run.metrics.getSnapshot(now)
                // TODO store snapshot with run
                if (!budgets) continue

                const exceeded = budgets.checkScopeSnapshot('run', snapshot)
                if (exceeded) run.abort(`Budget of ${exceeded.max} for ${exceeded.key} in ${exceeded.scope} exceeded`)
            }
            lastTotalSnapshot = ModelTracker.totalMetrics.getSnapshot(now)
            if (!budgets) return

            const exceeded = budgets.checkScopeSnapshot('total', lastTotalSnapshot)
            if (exceeded) {
                if (rootRunner) rootRunner.abort(`Budget of ${exceeded.max} for ${exceeded.key} in ${exceeded.scope} exceeded`)
            }
        }, checkInterval)
    }

    return {
        setCheckInterval: (newInterval: number | TimeConfig): void => {
            checkInterval = toTime(newInterval)
        },
        setBudgets: (newBudgets?: Budgets): void => {
            budgets = newBudgets
        },
        getBudgets: (): Budgets | void => budgets,
        setRootRunner: (runner: Runner): void => {
            if (!rootRunner) {
                rootRunner = runner
            }
        },
        startRun: (run: WorkflowRun): void => {
            runs.add(run)
            if (!interval) startTrackingInterval()
        } ,
        stopRun: (run: WorkflowRun): void => {
            runs.delete(run)
            if (!runs.size && interval) {
                clearInterval(interval)
                interval = undefined
            }
        }
    }
}

const BudgetManager = createBudgetManager()

export {
    TimeTracker,
    createTimeTracker,
    createMetrics,
    Metrics,
    MetricsScope,
    DeltasAndValues,
    getReadableBlockStats,
    getReadableModelStats,
    BudgetManager,
    createBudgets,
    Budgets
}