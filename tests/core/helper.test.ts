import { describe, expect, test } from "vitest"
import {createDump, toTime, without, sleep, getAbortableSleep, getReadableOffset} from '../../src/core/helper.ts'

describe('Helper', () => {

    test('createDump()', () => {
        const dump = createDump({
            group: (...data: any[]) => void {},
            log: (...data: any[]) => void {},
            groupEnd: () => void {}
        })

        expect(dump(undefined)).toBeUndefined()
        expect(dump(true)).toBe(true)
        expect(dump(1, 2, 3)).toBe(1)
    })


    test('toTime()', () => {
        expect(toTime(0)).toBe(0)
        expect(toTime(100)).toBe(100)
        expect(toTime({})).toBe(0)
        expect(toTime({ms: 1})).toBe(1)
        expect(toTime({s: 1})).toBe(1_000)
        expect(toTime({m: 1})).toBe(60 * 1_000)
        expect(toTime({h: 1})).toBe(60 * 60 * 1_000)
        expect(toTime({d: 1})).toBe(24 * 60 * 60 * 1_000)

        expect(toTime({ms: 50, s: 2, m: 4, h: 3, d: 2})).toBe(
            50 +
            2 * 1_000 +
            4 * 60 * 1_000 +
            3 * 60 * 60 * 1_000 +
            2 * 24 * 60 * 60 * 1_000
        )
    })

    test('without()', () => {
        expect(without<string>([], 'x')).toEqual([])
        expect(without<string>([], [])).toEqual([])
        expect(without<string>(['y'], [])).toEqual(['y'])
        expect(without<string>(['y'], 'y')).toEqual([])
        expect(without<string>(['y', 'y'], 'y')).toEqual([])
        expect(without<string>(['y'], 'x')).toEqual(['y'])
        expect(without<string>(['y'], ['x'])).toEqual(['y'])
        expect(without<string>(['y'], ['x', 'y'])).toEqual([])
        expect(without<string>(['y'], ['y', 'y'])).toEqual([])
    })

    test('sleep()', async () => {
        const start = Date.now()
        await sleep(100)
        expect((Date.now() - start) >= 100)

        let x = false
        await sleep(0, () => {
            x = true
        })
        expect(x).toBe(true)
    })

    test('getAbortableSleep()', async () => {
        {
            const start = Date.now()
            const abortable = getAbortableSleep(100)
            await abortable.promise
            expect((Date.now() - start) >= 100)
        }
        {
            let x = false
            const abortable = getAbortableSleep(100, () => {
                x = true
            })
            await abortable.promise
            expect(x).toBe(true)
        }
        {
            const start = Date.now()
            const abortable = getAbortableSleep(1000)
            await Promise.all([
                abortable.promise,
                sleep(100, async () => {
                    await abortable.abort()
                })
            ])
            expect((Date.now() - start) <= 250)
        }
    })

    test('getReadableOffset()', () => {
        expect(getReadableOffset(0)).toBe("")
        expect(getReadableOffset(61500)).toBe("1m 1s")
    })
})