# node-pi-flow

Agentic workflow runner and orchestrator based on the pi coding agent. 

**Work In Progress - This project is still under development and not yet ready use!**

## Features

* JS workflows instead of config files 
* run a workflow in the CLI, over a REST API, WebSockets or a browser
* builtin pi coding agent features like auto compaction, skills, extensions etc. 
* user interaction
* multi agents from local or remote models
* persistent storage for execution history and session reconstruction
* sync and asynchronic stage execution
* image generation
* orchestrate workflows over multiple processes and machines 
* file input / output and MIME-based prompt-transformers
* filesystem changes tracking
* budget and cost tracking and limits

## Installation

### Prerequisites

* Node.js >=22.19.0
* Subscription to a LLM provider (OpenAI, Anthropic etc.) or a running local model server (ollama, Llama.ccp, LMStudio etc.)

### Install

You can add node-pi-flow to your project using npm:

```bash
npm install node-pi-flow
```

If you want to use local models in your workflow you must create a models file either in the project or your home directory (see [pi coding agent documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#configure-a-compatible-endpoint)) 


## Usage

You import one of the following runners and then you can either instantiate it or use the static methods provided.

| Runner      | Description                                                                       |
|-------------|-----------------------------------------------------------------------------------|
| `CliRunner` | Writes the outputs to CLI                                                         |
| `ApiRunner` | Starts a server (REST/Websockets) which allows to control workflows via API calls |
| `WebRunner` | Starts a web server which allows to control workflows via browser                 |

Example:

```javascript
import { CliRunner, doContent } from 'node-pi-flow'

CliRunner.run([
    doContent('Hello World!')
])
```
If you execute this script the runner should write `Hello World!` as an assistant message to the console.

### Runner controls

A runner instance has the following methods to control workflows:

| method                                     | Description                                                                                     
|--------------------------------------------|-------------------------------------------------------------------------------------------------|
| `run(idOrWorkflow, args = {})`             | Starts a new workflow with the given `args`-object and returns a workflow result object         |
| `abort()`                                  | Aborts all running workflows                                                                    |
| `restart( workflowResultOrId )`            | Restarts the workflow from the given result object or id and returns the workflow result object |

You can start multiple workflows on a runner instance and if the runner starts a server like the Api- or WebRunner the process will not exit until you explitly shut it down.
If you just want to execute a single workflow you can use the static run method of the runner and after finishing the run, the runner will exit automatically.

See the runner options to configure how the runner behaves.

## Workflows

A workflow is technically an array of stages and each stage has a `exec()` function which does the execution, but you don't have to deal with these classes. Instead you will use a small set of do-functions which return these stage-instances.

#### Workflow Registry

You can always create an anonymous workflow by using an array of do-functions of stage-instances, but you can also store such a workflow under a certain id and name in a `WorkflowRegistry` instance and pass the registry to a runner in its constructor. When you start workflows or sub workflows in the runner you can then use the id of the workflow. The WorkflowRegistry also tries to load workflows from files matching the name `<workflow-id>.workflow.js` automatically if the `autoLoad` feature is enabled (default). Such a file based workflow must be a ESM-module which exports a default function that returns a worfklow. The function is called with node-pi-flow module, so that you can use all available do-functions or stage-classes.    

#### Workflow Execution

Workflow-Stages are executed in the order they are added to the workflow, but you also have the possibility to either skip a stage or to jump to another stage with a certain label. All do-Functions or stage-configs provide the following properties:

| Property | Description |
|---------|-------------|
| `label` | Sets a label to the current stage
| `skip`  | Returns whether the current stage should be skipped or not.
| `next`  | Returns a boolean or a string with the label of the stage which should be next. When `false` is returned the workflow will stop
| `async`  | Returns whether the current stage should be executed synchronously (`false`) or asynchronously (`true` or a string which can be used as async-id in a await-stage). This property is not supported by all stages 

Setting fix value for `skip` or `next` is possible but most of the time we want to set the values dynamically depending on the current state of the workflow. That's why most of the stage-properties can also be given as function which returns the value for the property and this function is always called with 2 arguments:
* state (an object with the current state of the workflow)
* ctx (an object with context information which allows to access the API of the workflow run and global information)

#### Sub Workflows

A workflow can start a sub-workflow either synchronously or asynchronously. You can start a synchronous anonymous sub-workflow by simply adding a sub-array with new stages:
```javascript
import { CliRunner, doContent } from 'node-pi-flow'

CliRunner.run([
  doContent('main workflow'),
  [
      doContent('sub workflow')
  ]
])
```
If you want to start an asynchronous sub-workflow, you must use the `doWorkflow()`-function and pass a config with `async`-property to `true` or a string-id:

```javascript
import { CliRunner, doContent, doWorkflow, doAwait } from 'node-pi-flow'

CliRunner.run([
  doContent('main workflow'),
  doWorkflow({
    "async": true,
    "workflow": [
       doContent('sub workflow')
    ]
  }),
  doAwait()  // we should wait for the sub workflow to finish before continuing
])
```
It's also possible to start workflows in another process (`doForkWorkflow()`) or on another machine (`doApiWorkflow()`).

## Agents

Agents can be created by calling the `doCreateAgent()` function in your workflow. You can specify an id, set a model, a thinking level and a systemPrompt which should be used and define which tools are allowed whereas the config of an agent follows mainly the one from agents in `pi`. Models however must always be identified by a `"<provider>/<model>"` string. You can change some of the agent properties afterwards by calling `doUpdateAgent()` and this also allows you to `clear` the context of an agent and start with a new session. An agent `default` is always created with the default model / provider which is stored in the settings of `pi`, but if these settings are not found an error is thrown.

### Prompting

You can prompt an agent by calling `doAskAgent()`. If you don't pass an agent id, the id will be determined by the following fallback algorithm:
* the last prompted agent id
* the first agent created
* the `default` agent


## Available do-Functions / Stage-Classes

| doFunction       | Stage-Class         | Description  |
|------------------|---------------------|--------------|
| `doNoop`         | `NoopStage`         | Does nothing
| `doContent`      | `ContentStage`      | Writes content (text or files) to the user or an agent
| `doWait`         | `WaitStage`         | Waits for a certain amount of time
| `doAwait`        | `AwaitStage`        | Waits until all or certain async stages have finished
| `doReturn`       | `ReturnStage`       | Stops the execution and returns a result
| `doError`        | `ErrorStage`        | Stops the execution with an error  
| `doConnect`      | `ConnectStage`      | Connects to an API runner on another machine
| `doFunction`     | `FunctionStage`     | Calls a custom function
| `doWorkflow`     | `WorkflowStage`     | Starts a new sub workflow and writes the result to the state
| `doForkWorkflow` | `ForkWorkflowStage` | Starts a new sub workflow in a new process and writes the result to the state
| `doApiWorkflow`  | `ApiWorkflowStage`  | Starts a new workflow on a connected API and writes the result to the state
| `doCreateAgent`  | `CreateAgentStage`  | Creates a new agent based on a model and system prompt
| `doUpdateAgent`  | `UpdateAgentStage`  | Updates an existing agent
| `doAskUser`      | `AskUserStage`      | Prompts the user for input
| `doAskAgent`     | `AskAgentStage`     | Prompts an agent
| `doAskImageGenerator`| `AskImageGeneratorStage` | Prompts an image generator

## License

This project is licensed under the [MIT License](./LICENSE).
