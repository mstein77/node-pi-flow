import { Runner, BlockType, Content, Workflow, Stage, RunHandlers, InputType, WorkflowRun, createRunHandlers } from "../src/core/workflow.ts"
import { sleepWithSignal } from "../src/core/helper.ts"

class TestRunner extends Runner {
    protected inputError?: Error
    public outputs: string[] = []

    public static async run(workflow: Workflow | Stage[], args?: Record<string, any>) {
        return await TestRunner.runStatic(TestRunner, workflow, args)
    }

    public getRunHandlers(): RunHandlers {
        return createRunHandlers({
            renderBlock: (type: BlockType, content: Content) => {
                if (type === 'assistant') {
                    this.outputs.push(typeof content === 'string' ? content : JSON.stringify(content))
                }
            },
            input: async (run: WorkflowRun, type: InputType, options: any): Promise<string> => {
                if (this.inputError) {
                    throw this.inputError
                }
                await sleepWithSignal(2500, run.signal)
                return ''
            }
        })
    }

    public setInputError(e: Error) {
        this.inputError = e
    }
}

export default TestRunner