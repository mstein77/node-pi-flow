import { PromptOptions } from "@earendil-works/pi-coding-agent"
import { FileItem } from "./agent.ts"
import { readFile } from "node:fs/promises"

interface MimeTransformer {
    transform: (item: FileItem, options: PromptOptions) => Promise<void | string>
    canTransform: (mimeType: string) => boolean
}

abstract class Transformer implements MimeTransformer {

    public abstract transform(item: FileItem, options: PromptOptions): Promise<void | string>

    protected async addFileContentAsBase64(item: FileItem): Promise<void> {
        if (item.content !== null || !item.filePath) return

        const dataBuffer = await readFile(item.filePath)
        item.content = dataBuffer.toString('base64')
    }

    protected async addRawFileContent(item: FileItem): Promise<void> {
        if (item.content !== null || !item.filePath) return

        const dataBuffer = await readFile(item.filePath)
        item.content = dataBuffer.toString()
    }

    public canTransform(mimeType: string) {
        return true
    }
}

const mimeToTransformer = new Map<string, MimeTransformer>()
const mainMimeToTransformer = new Map<string, MimeTransformer>()

const addTransformer = (mimeTypes: string | string[], transformer: MimeTransformer) => {
    if (!Array.isArray(mimeTypes)) {
        mimeTypes = [mimeTypes]
    }
    for (const mimeType of mimeTypes) {
        const [main, sub] = mimeType.indexOf('/') === -1 ? [mimeType, '*'] : mimeType.toLowerCase().split('/')
        if (sub === '*') {
            mainMimeToTransformer.set(main, transformer)
        } else {
            mimeToTransformer.set(mimeType, transformer)
        }
    }
}

const getMatchingTransformer = (mimeType: string): MimeTransformer | undefined => {
    let transformer = mimeToTransformer.get(mimeType)
    if (transformer) return transformer

    const [main] = mimeType.split('/')
    transformer = mainMimeToTransformer.get(main)
    if (transformer && transformer.canTransform(mimeType)) return transformer
}

class ImageTransformer extends Transformer {
    public async transform(item: FileItem, options: PromptOptions): Promise<void | string> {
        await this.addFileContentAsBase64(item)
        const { content, mimeType } = item
        if (content === null) return

        if (!Array.isArray(options.images)) {
            options.images = []
        }
        options.images.push({
            type: 'image',
            data: content,
            mimeType
        })
    }
}

class TextTransformer extends Transformer {
    public async transform(item: FileItem, options: PromptOptions): Promise<void | string> {
        await this.addRawFileContent(item)
        if (item.content === null) return

        return item.content
    }
}

addTransformer('image/*', new ImageTransformer())
addTransformer('text/*', new TextTransformer())

export {
    addTransformer,
    getMatchingTransformer
}