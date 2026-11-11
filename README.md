# Mini Pi Agents

A minimal coding agent built with **Redux/Redux-Saga** for state management, running in the terminal with optional TUI and Redux DevTools integration.

## Features

- **Redux/Redux-Saga** - All state changes and side effects managed through the Redux store and Sagas
- **Multi-agent pipeline** - `Planner → Executor → Reviewer`, with automatic rework when the reviewer rejects
- **Terminal-first** - CLI REPL, TUI mode, or one-shot execution
- **Redux DevTools** - Real-time state inspection via browser DevTools
- **Tool system** - File operations and shell commands via LLM function calling
- **OpenRouter compatible** - Works with any OpenAI-compatible API

## Project Structure

```
src/
├── agent/
│   ├── pipeline.ts        # Pipeline stages, tool permissions, stage hand-off
│   └── prompt.ts          # System prompts (single agent + per-stage roles)
├── cli/
│   ├── renderer.ts        # CLI output renderer (non-TUI)
│   └── tui.ts             # Terminal UI using @earendil-works/pi-tui
├── provider/
│   └── openai.ts          # OpenAI-compatible streaming client
├── store/
│   ├── actions.ts         # Redux action creators
│   ├── reducer.ts         # Redux reducer (messages, tool, pipeline stages)
│   ├── sagas.ts           # Side effects: LLM calls, tool execution, rework, retry
│   ├── devtools.ts        # Redux DevTools remote enhancer
│   ├── index.ts           # Store factory
│   ├── pipeline.test.ts   # Pipeline orchestration tests (fake model)
│   └── *.test.ts          # Reducer / selector / store tests
├── tools/
│   ├── file-tools.ts      # read_file / write_file / list_files
│   └── shell-tool.ts      # run_command
├── config.ts              # Environment config loader
├── index.ts               # CLI entry point
└── types.ts               # Shared TypeScript types
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create `.env` in project root:

```env
# Required
OPENROUTER_API_KEY=your_openrouter_key
# or OPENAI_API_KEY=your_openai_key

MODEL_NAME=nvidia/nemotron-3-ultra-550b-a55b:free
# or any OpenRouter/OpenAI model name

# Optional
OPENAI_BASE_URL=https://openrouter.ai/api/v1
REDUX_DEVTOOLS_PORT=8000
```

### 3. Run

**One-shot (single prompt, then exit):**
```bash
npm start "read package.json and summarize"
```

**Interactive REPL:**
```bash
npm run dev
```

**TUI (Terminal UI):**
```bash
npm run tui
```

**Single-agent mode (skip the pipeline):**
```bash
npm start -- --single "read package.json and summarize"
```

**With Redux DevTools (two terminals):**

Terminal 1 - Start DevTools server:
```bash
npm run devtools
# Opens http://127.0.0.1:8000
```

Terminal 2 - Run agent with DevTools:
```bash
npm run tui -- --devtools
# or
npm run dev -- --devtools
```

**One-command DevTools + REPL:**
```bash
./devtools-run.sh
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start "prompt"` | One-shot execution |
| `npm start -- --single "prompt"` | One-shot without the multi-agent pipeline |
| `npm run dev` | Interactive REPL |
| `npm run dev -- --devtools` | REPL + DevTools |
| `npm run tui` | Terminal UI |
| `npm run tui -- --devtools` | TUI + DevTools |
| `npm run devtools` | Start DevTools server (port 8000) |
| `npm run typecheck` | TypeScript type check |
| `node --test src/store/*.test.ts` | Run unit tests |

In REPL or TUI, type `retry` to rerun the last task, `exit` to quit, and `Ctrl+C` to interrupt the running task.

## Architecture

### State Management (Redux + Saga)

```
User Input → agentSubmit(action) → Redux Store
    ↓
Saga watches AGENT_SUBMIT / AGENT_INTERRUPT / AGENT_RETRY:
  - Runs pipeline stages sequentially
  - Calls the model and streams text deltas back as actions
  - Executes tool calls and feeds results into the stage context
  - Feeds reviewer feedback back to the executor on rejection
    ↓
Redux DevTools (optional) ← State changes
    ↓
Renderer / TUI reads state → Terminal output
```

### Multi-Agent Pipeline

Default pipeline (`createPipeline` in `src/agent/pipeline.ts`):

| Stage | Tools | Responsibility |
|-------|-------|----------------|
| Planner | `read_file`, `list_files` | Inspect the codebase, produce an implementation plan |
| Executor | all tools | Implement the plan, verify with tests/typecheck |
| Reviewer | read-only + `run_command` | Check the work against the task, run tests, give a verdict |

Hand-off rules:

- Each stage gets its own message context; tools and intermediate turns never leak across stages.
- A stage's **final message** is passed to the next stage (plus the original task).
- The reviewer must end with `APPROVED` to pass. Otherwise its output is fed back to the executor and both stages rerun, up to `maxAttempts` (default 2).
- If attempts are exhausted, the reviewer stage is marked `error` and the task ends.

### Key State Shape

```typescript
interface AgentState {
  status: "idle" | "running" | "error";
  messages: Message[];         // UI transcript (all stages)
  turn: number;                // Turn counter of the active stage
  streamingText: string;       // Current streaming text
  tool: ToolActivity | null;   // Latest tool call
  error: string | null;
  stats: { toolCalls: number };
  pipeline: {
    stages: PipelineStageState[]; // status / attempt / output per stage
    activeIndex: number | null;
  };
}
```

### Actions

- `agentSubmit(input)` - Submit a prompt and start the pipeline
- `agentInterrupt()` - Cancel the running task
- `agentRetry()` - Rerun the last submitted task
- `pipelineStarted(stages)` / `stageStarted` / `stageEnded` / `stageFailed` - Pipeline lifecycle
- `agentTurnStarted` / `agentTextDelta` / `agentTurnEnded` - Model turn lifecycle
- `agentMessageAdded` / `toolStarted` / `toolEnded` - Tool lifecycle
- `agentError` / `agentEnded` / `agentAborted` - Termination

### Tools Available

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create/overwrite file |
| `list_files` | List directory |
| `run_command` | Execute shell command (timeout, abort support) |

## DevTools Usage

1. Start server: `npm run devtools`
2. Open http://127.0.0.1:8000 in browser
3. Run agent with `--devtools` flag
4. Watch actions/state diffs in real-time

> **Note:** Use `http://127.0.0.1:8000` not `localhost` to avoid browser WSS upgrade issues.

## Testing

```bash
node --test src/store/*.test.ts
```

The pipeline tests inject a fake `stream` function into `AgentRuntime`, so rework and retry are verified deterministically without network calls.

## TypeScript

```bash
npm run typecheck  # tsc --noEmit
```

Strict mode enabled. All source files use ES modules (`.ts` extensions in imports).

## Requirements

- Node.js >= 22.19.0
- OpenRouter or OpenAI API key

## License

MIT
