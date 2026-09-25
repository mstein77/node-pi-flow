import { ModelRuntime, ProviderConfig, SettingsManager } from "@earendil-works/pi-coding-agent"
import type { Model, Api } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts"
import type { Provider, ImagesModel, ImagesApi, MutableImagesModels } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.d.ts"
import { builtinImagesModels } from "./../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js"
import { Metrics, createMetrics, getReadableModelStats } from "./metrics.ts"

interface BaseModelHandler {
    id: string,
    used: boolean,
    abort: (ids: string | string[]) => void
    metrics: Metrics
}

interface ChatModelHandler extends BaseModelHandler {
    model: Model<Api>
    isImageModel: false
}

interface ImageModelHandler extends BaseModelHandler {
    model: ImagesModel<ImagesApi>
    isImageModel: true
}

type ModelHandler = ChatModelHandler | ImageModelHandler

const modelRuntime = await ModelRuntime.create()

class ModelTracker {

    protected static _imageModels: MutableImagesModels | undefined
    protected static _modelRegistry: ModelRuntime | undefined
    protected static _totalMetrics: Metrics | undefined
    private static idToModelHandler: Map<string, ModelHandler> = new Map()
    public static imageProviderToApiKey = new Map<string, string>()

    public static get imageModels(): MutableImagesModels {
        if (!ModelTracker._imageModels) {
            ModelTracker._imageModels = builtinImagesModels()
        }
        return ModelTracker._imageModels
    }

    public static get totalMetrics(): Metrics {
        if (!ModelTracker._totalMetrics) {
            ModelTracker._totalMetrics = createMetrics('total', 'Total')
        }
        return ModelTracker._totalMetrics
    }

    public static get modelRegistry(): ModelRuntime {
        if (!ModelTracker._modelRegistry) {
            ModelTracker._modelRegistry = modelRuntime
        }
        return ModelTracker._modelRegistry
    }

    public static set modelRegistry(runtime: ModelRuntime) {
        ModelTracker._modelRegistry = runtime
    }

    public static registerProvider(name: string, config: ProviderConfig) {
        if (!ModelTracker.modelRegistry) throw Error('Foo')
        ModelTracker.modelRegistry.registerProvider(name, config)
    }

    public static unregisterProvider(name: string) {
        ModelTracker.modelRegistry.unregisterProvider(name)
    }

    /*
    public static get authStorage(): AuthStorage {
        if (!ModelTracker._authStorage) {
            ModelTracker._authStorage = AuthStorage.create()
        }
        return ModelTracker._authStorage
    }
     */

    public static getModelMetrics(modelId: string): Metrics {
        const handler = ModelTracker.getModelHandler(modelId)
        return handler.metrics
    }

    public static getDefaultModelIdFromSettings(settingsManager: SettingsManager): string {
        const model = settingsManager.getDefaultModel()
        const provider = settingsManager.getDefaultProvider()
        return (model && provider) ? `${provider}/${model}` : ''
    }

    public static getGlobalStats(): Record<string, number> {
        return ModelTracker.totalMetrics.getSnapshot()
    }

    public static getReadableGlobalStats(): string {
        return `Total:\n  ${getReadableModelStats(ModelTracker.totalMetrics.getSnapshot())}`
    }

    public static getModelStats(): Record<string, Record<string, number>> {
        const stats: Record<string, Record<string, number>> = {}
        const now = Date.now()
        const models = ModelTracker.getUsedModels()
        for (const modelId of models) {
            const modelHandler = this.idToModelHandler.get(modelId)
            if (!modelHandler || !modelHandler.metrics) continue

            stats[modelId] = modelHandler.metrics.getSnapshot(now)
        }
        return stats
    }

    public static getReadableStatsByModel(): string {
        const lines: string[] = []
        const now = Date.now()
        const models = ModelTracker.getUsedModels()
        for (const modelId of models) {
            const modelHandler = this.idToModelHandler.get(modelId)
            if (!modelHandler || !modelHandler.metrics) continue

            const values = modelHandler.metrics.getSnapshot(now)
            lines.push(`${modelId}:`)
            lines.push(`  ${getReadableModelStats(values)}`)
        }
        return lines.join(`\n`)
    }

    public static markAsUsed(modelId: string): boolean {

        const modelHandler = this.getModelHandler(modelId)
        if (modelHandler.used) return false

        modelHandler.used = true
        return true
    }

    public static getModelHandler(modelId: string, isImageModel = false): ModelHandler {
        const foundHandler = this.idToModelHandler.get(modelId)
        if (foundHandler) return foundHandler

        const idx = modelId.indexOf('/')
        if (idx === -1) {
            // TODO usage util function and unified error message
            throw Error(`Invalid format for model id "${modelId}" given`)
        }
        const provider = modelId.slice(0, idx)
        const modelName = modelId.slice(idx + 1)

        const foundModel =
            isImageModel ?
                ModelTracker.imageModels.getModel(provider, modelName) :
                ModelTracker.modelRegistry.getModel(provider, modelName)

        if (!foundModel) throw Error(`Model "${modelName}" from provider "${provider}" is not available`)

        const metrics = createMetrics('model', `Model "${modelId}"`)
        let handler: ModelHandler | undefined
        if (isImageModel) {
            handler = {
                id: modelId,
                used: isImageModel,
                isImageModel,
                model: foundModel as ImagesModel<ImagesApi>,
                abort: (ids: string | string[]) => {
                    if (!Array.isArray(ids)) ids = [ids]

                    metrics.abort(ids)
                    ModelTracker.totalMetrics.abort(ids)
                },
                metrics
            }
        } else {
            handler = {
                id: modelId,
                used: isImageModel,
                isImageModel,
                model: foundModel as Model<Api>,
                abort: (ids: string | string[]) => {
                    if (!Array.isArray(ids)) ids = [ids]

                    metrics.abort(ids)
                    ModelTracker.totalMetrics.abort(ids)
                },
                metrics
            }
        }
        this.idToModelHandler.set(modelId, handler)

        return handler
    }

    public static async getAvailable(): Promise<readonly Model<Api>[]> {
        return await ModelTracker.modelRegistry.getAvailable()
    }

    public static getUsedModels(): string[] {
        const used = [...this.idToModelHandler.values()].filter(x => x.used)
        return used.map(x => x.id)
    }

    public static getProvider(providerId: string): Provider {
        const provider = ModelTracker.modelRegistry.getProvider(providerId)
        if (!provider) throw Error(`Unknow provider id "${providerId} given`)

        return provider
    }

    public static supportsOAuth(providerId: string) {
        return !!ModelTracker.getProvider(providerId).auth?.oauth
    }

    public static isUsingOAuth(providerId: string) {
        return ModelTracker.modelRegistry.isUsingOAuth(providerId)
    }

    public static supportsSubscription(providerId: string) {
        return !!ModelTracker.getProvider(providerId).auth?.apiKey
    }

    public static isUsingSubscription(providerId: string) {
        return ModelTracker.modelRegistry.isUsingSubscription(providerId)
    }
}

export {
    ModelTracker,
    ModelHandler
}