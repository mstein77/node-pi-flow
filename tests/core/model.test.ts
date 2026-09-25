import { describe, test, expect } from "vitest"
import { ModelTracker } from "../../src/core/model.ts"
import { SettingsManager } from "@earendil-works/pi-coding-agent"

describe('Model', () => {
    test('getDefaultModelIdFromSettings()', () => {
        expect(ModelTracker.getDefaultModelIdFromSettings(SettingsManager.inMemory())).toBe('')
        expect(ModelTracker.getDefaultModelIdFromSettings(SettingsManager.inMemory({
            defaultProvider: 'abc'
        }))).toBe('')
        expect(ModelTracker.getDefaultModelIdFromSettings(SettingsManager.inMemory({
            defaultModel: 'xy'
        }))).toBe('')
        expect(ModelTracker.getDefaultModelIdFromSettings(SettingsManager.inMemory({
            defaultProvider: 'abc', defaultModel: 'xy'
        }))).toBe('abc/xy')
    })

    test('getModelHandler()', () => {
        expect(() => ModelTracker.getModelHandler('xy')).toThrow('xy')
    })

    test('getAvailable()', async () => {
        const models = await ModelTracker.getAvailable()
        expect(Array.isArray(models)).toBe(true)
    })

    test('markAsUsed()', () => {
        expect(() => ModelTracker.markAsUsed('abc/xy')).toThrow('xy')
    })

    test('getUsedModels()', () => {
        expect(ModelTracker.getUsedModels()).toEqual([])
    })

    test('getGlobalStats()', () => {
        const stats = ModelTracker.getGlobalStats()
        expect(typeof stats).toBe('object')
        expect(stats['time-responding']).toBe(0)
    })

    test('getModelStats()', () => {
        const stats = ModelTracker.getModelStats()
        expect(typeof stats).toBe('object')
        expect(Object.keys(stats).length).toBe(0)
    })
})