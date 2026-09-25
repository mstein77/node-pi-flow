import { createAbortError, runOnce } from "./workflow.ts"
import readline from 'node:readline/promises'
import { createAbortController } from "./helper.ts"
import { exec } from "node:child_process"
import { promisify } from 'node:util'

interface UserInputOptions {
    signal?: AbortSignal,
    validate?: ((response: string) => false | string)
    createInterface?: ((options: readline.ReadLineOptions) => readline.Interface)
}

const getAbortableUserInput = (
        prompt: string,
        options: UserInputOptions = {}
    ): Promise<string> => {

    const {
        validate = (response: string) => response,
        createInterface = readline.createInterface,
        signal = createAbortController().signal
    } = options
    if (signal.aborted) throw createAbortError(signal.reason)

    let abortHandler: undefined | (() => void)
    const rl = createInterface({input: process.stdin, output: process.stdout})

    return (new Promise<string>(
        async (resolve, reject) => {
            abortHandler = () => {
                reject(createAbortError(signal.reason))
            }
            try {
                signal.addEventListener('abort', abortHandler, runOnce)

                let response: boolean | string = false
                while (response === false) {
                    response = await rl.question(prompt, {signal})
                    response = validate(response)
                }
                resolve(response)
            } catch (e) {
                reject(e)
            }
        }
    )).finally(() => {
        rl.close()
        if (abortHandler) signal.removeEventListener('abort', abortHandler, runOnce)
    })
}

const promiseExec = promisify(exec)

const getCmdOutput = async (cmd: string): Promise<string> => {
    const { stdout } = await promiseExec(cmd)
    return stdout
}

export {
    getCmdOutput,
    getAbortableUserInput
}