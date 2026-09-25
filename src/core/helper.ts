const skipPrefix = "@webpack-internal:///./"

interface Console {
    group: (...data: any[]) => void
    log: (...data: any[]) => void
    groupEnd: () => void
}

const createDump = (console: Console): ((main: any, ...params: any[]) => any) => {
    return (main: any, ...params: any[]): any => {
        let stack: any[] = []
        try {
            throw Error("foo")
        } catch (e) {
            if (e instanceof Error && e.stack) {
                stack = e.stack.split("\n")
            }
        }
        const func = []
        for (const line of stack.slice(2)) {
            if (func.length === 0) {
                func.push(line.trim().replace(skipPrefix, "@"))
                continue
            }
            if (func.length > 10) break

            const [first] = line.split("(")
            const code = first.trim().replace(skipPrefix, "@")
            func.push(code)
        }
        console.group("Debug " + func.join(" <- "))
        console.log(main, ...params)
        console.groupEnd()

        return main
    }
}

// @ts-ignore
globalThis.d = createDump(console)

interface AbortableSleep {
    promise: Promise<void>
    get aborted(): boolean
    abort: () => Promise<void>
}

const sleepWithSignal = (ms: number, signal: AbortSignal): Promise<boolean> => {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve(false)
            return
        }
        const timeout = setTimeout(() => {
            resolve(true)
        }, ms)
        signal.addEventListener("abort", () => {
            clearTimeout(timeout)
            resolve(false)
        })
    })
}

const getAbortableSleep = (ms: number, cb?: () => void | Promise<void>): AbortableSleep => {
    const ac = new AbortController()
    return {
        promise: new Promise(async (resolve, reject): Promise<void> => {
            try {
                const success = await sleepWithSignal(ms, ac.signal)
                if (success && cb) await cb()
                resolve()
            } catch (e) {
                reject(e)
            }
        }),
        get aborted() {
            return ac.signal.aborted
        },
        abort: async () => ac.abort("Aborted")
    }
}

const sleep = (ms: number, cb?: () => void | Promise<void>): Promise<void> => getAbortableSleep(ms, cb).promise

function getReadableOffset(offset: number, leading = false): string {
    const parts = []
    const getNumber = (value: number | string) => {
        value = "" + value
        if (!leading || value.length > 1) return value

        return ' ' + value
    }

    let seconds = Math.floor(offset/1000)
    if (seconds <= 0) {
        return (offset === 0) ? '' : `${offset}ms`
    }

    let minutes = 0
    let hours = 0
    if (seconds >= 60) {
        minutes = Math.floor(seconds / 60)
        seconds = seconds % 60
    }
    parts.push(`${getNumber(seconds)}s`)
    if (minutes) {
        hours = Math.floor(minutes / 60)
        minutes = minutes % 60

        parts.unshift(`${getNumber(minutes)}m`)
        if (hours) {
            parts.unshift(`${getNumber(hours)}h`)
        }
    }
    return parts.join(' ')
}

const without = <T>(
    source: T[],
    remove: T | T[]
): T[] => {
    if (!Array.isArray(remove)) remove = [remove]

    return remove.length
        ? source.filter((x) => !remove.includes(x))
        : [...source]
}

interface TimeConfig {
    ms?: number
    s?: number
    m?: number
    h?: number
    d?: number
}

function toTime(configOrNumber: TimeConfig | number): number {
    if (typeof configOrNumber === 'number') return configOrNumber

    const { ms, s, m, h, d } = configOrNumber

    let duration = 0
    duration += ms ?? 0
    duration += (s ?? 0) * 1_000
    duration += (m ?? 0) * 60_000
    duration += (h ?? 0) * 3_600_000
    duration += (d ?? 0) * 86_400_000

    return duration
}

interface RunningPromise {
    promise: Promise<void>
    resolve: () => void,
}

function createRunningPromise(): RunningPromise {
    return {
        promise: Promise.resolve(),
        resolve: () => {}
    }
}

function createAbortController(timeoutMs?: number): AbortController {
    const ac = new AbortController()
    if (timeoutMs === undefined) return ac

    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)])
    return {
        signal,
        abort: (reason: string | undefined) => {
            ac.abort(reason)
        }
    }
}

function withSign(value: string) {
    if (!value.length || ['0', '-'].includes(value[0])) return value

    return '+' + value
}

function ucFirst(value: string) {
    return value ? value[0].toUpperCase() + value.slice(1) : ''
}

function createRandomId(): string {
    return `${Math.random().toString(36).slice(2, 9)}-${Date.now()}`
}

function getErrorMessage(error: any) {
    if (typeof error === 'string') return error

    return typeof error === 'object' ? error.message : 'Unknown error'
}

export {
    createDump,
    createAbortController,
    createRandomId,
    TimeConfig,
    toTime,
    without,
    ucFirst,
    sleep,
    sleepWithSignal,
    getAbortableSleep,
    getErrorMessage,
    getReadableOffset,
    RunningPromise,
    createRunningPromise,
    withSign
}