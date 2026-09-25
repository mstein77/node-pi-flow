import { vi, describe, expect, test } from "vitest"
import { getAbortableUserInput } from "../../src/core/cli.ts"
import { createAbortController, sleep, sleepWithSignal } from "../../src/core/helper.ts"
import { Abortable} from "node:events"
import { Interface} from "node:readline/promises"
import { AbortError } from "../../src/core/workflow.ts"

const SLEEP_MS = 250

const getCreateInterfaceMock = (responses: string[], output: string[] = []): (...args: any[]) => Interface => {
    return (...args: any[]): Interface => ({
        question: async (prompt: string, options: Abortable | undefined): Promise<string> => {
            output.push(prompt)
            const item = responses.shift()
            if (item === undefined) throw Error('No more mock responses')

            if (options?.signal) {
                await sleepWithSignal(SLEEP_MS, options.signal)
                if (options.signal.aborted) {
                    throw new AbortError()
                }
            } else {
                await sleep(SLEEP_MS)
            }
            return item
        },
        close: () => {}
    } as Interface)
}

describe("CLI", () => {
    test('getAbortableUserInput()', async () => {
        {
            let catched: any = undefined
            try {
                await getAbortableUserInput('xy', {signal: AbortSignal.abort('test abort')})
            } catch (e) {
                catched = e
            }
            expect(typeof catched).toBe('object')
            expect(catched instanceof AbortError).toBe(true)
            expect(catched.message).toBe('test abort')
        }
        {
            // pre-aborted
            const output: string[] = []
            const result = await getAbortableUserInput('xy', {createInterface: getCreateInterfaceMock(['123'], output)})
            expect(result).toBe('123')
            expect(output.length).toBe(1)
            expect(output).toEqual(['xy'])
        }
        {
            // check abort
            const ac = createAbortController()
            const start = Date.now()
            const inputPromise = getAbortableUserInput('xy', {createInterface: getCreateInterfaceMock(['123']), signal: ac.signal})
            sleep(100, async () => {
                ac.abort('test reason')
            })
            await expect(inputPromise).rejects.toThrow('test reason')
            const duration = Date.now() - start
            expect(duration >= 100 && duration <= 120).toBe(true)
        }
        {
            // validation overwrite
            const output: string[] = []
            const result = await getAbortableUserInput(
                'xy',
                {validate: (response) => 'foo',
                createInterface: getCreateInterfaceMock(['xy'], output)
            })
            expect(result).toBe('foo')
            expect(output.length).toBe(1)
            expect(output).toEqual(['xy'])
        }
        {
            // validation rejection should trigger another prompt
            const output: string[] = []
            const result = await getAbortableUserInput(
                'xy',
                {
                    validate: (response) => {
                        return response !== '12' ? false : '12'
                    },
                    createInterface: getCreateInterfaceMock(['123', '12'], output)
                }
            )
            expect(result).toBe('12')
            expect(output.length).toBe(2)
            expect(output).toEqual(['xy', 'xy'])
        }
        {
            // abort after validation fail reprompt
            const sleepMs = SLEEP_MS + 50
            const ac = createAbortController(sleepMs)
            const output: string[] = []
            const inputPromise = getAbortableUserInput(
                'xy',
                {
                    validate: (response) => {
                        return false
                    },
                    createInterface: getCreateInterfaceMock(['123', '12'], output),
                    signal: ac.signal
                }
            )
            const start = Date.now()
            await expect(inputPromise).rejects.toThrow('aborted')
            const duration = Date.now() - start
            expect(duration >= sleepMs - 20 && duration <= sleepMs + 20).toBe(true)
        }
    })
})