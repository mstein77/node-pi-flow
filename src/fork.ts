import ForkRunner from "./runners/fork.ts"

if (process.argv.length < 7) {
    process.exit(1)
}
const [ workflow, parentRunId, rootRunId, stringifiedConfig, stringifiedArgs ] = process.argv.slice(2, 7)

const runnerConfig = JSON.parse(stringifiedConfig)
if (!runnerConfig || typeof runnerConfig !== 'object') throw Error(`Invalid runner config passed`)

const runArgs = JSON.parse(stringifiedArgs)
if (!runArgs || typeof runArgs !== 'object') throw Error(`Invalid run arguments passed`)

const runner = new ForkRunner({ ...runnerConfig, parentRunId, rootRunId })

const messenger = ForkRunner.createMessenger(runner, parentRunId, rootRunId)

const result = await runner.run(workflow, runArgs)
messenger.sendToParentRun({
    from: result.runId ?? '',
    type: 'result',
    result
})
messenger.disconnect()
