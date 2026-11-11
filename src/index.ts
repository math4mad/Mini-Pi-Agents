/** CLI 入口：终端是唯一入口；状态全部走 Redux store，副作用全部走 Saga。 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createPipeline, createSingleStage } from "./agent/pipeline.ts";
import { attachRenderer } from "./cli/renderer.ts";
import { attachTui } from "./cli/tui.ts";
import { loadConfig } from "./config.ts";
import { agentInterrupt, agentRetry, agentSubmit } from "./store/actions.ts";
import { loadDevtoolsEnhancer } from "./store/devtools.ts";
import { createAgentStore } from "./store/index.ts";

const cwd = process.cwd();
const config = loadConfig();

const argv = process.argv.slice(2);
const devtoolsEnabled = argv.includes("--devtools") || process.env.REDUX_DEVTOOLS === "1";
const tuiEnabled = argv.includes("--tui") && stdout.isTTY === true;
const singleAgent = argv.includes("--single");
const parsedDevtoolsPort = Number.parseInt(process.env.REDUX_DEVTOOLS_PORT ?? "", 10);
const devtoolsPort = Number.isFinite(parsedDevtoolsPort) ? parsedDevtoolsPort : 8000;

const store = createAgentStore(
	{
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		model: config.model,
		stages: singleAgent ? [createSingleStage(cwd)] : createPipeline(cwd),
		maxTurns: 30,
		maxAttempts: 2,
	},
	{ enhancer: await loadDevtoolsEnhancer({ enabled: devtoolsEnabled, port: devtoolsPort }) },
);

// TUI 自己负责渲染，二者不能同时挂载，否则输出会互相覆盖。
if (!tuiEnabled) attachRenderer(store);

if (devtoolsEnabled) {
	stdout.write(`Redux DevTools: 先运行 "npm run devtools"，再打开 http://127.0.0.1:${devtoolsPort}\n`);
}

/** dispatch 一次任务，等 Saga 把状态带回非 running 再返回。 */
function dispatchAndWait(action: Parameters<typeof store.dispatch>[0]): Promise<void> {
	return new Promise((resolve) => {
		let started = false;
		const unsubscribe = store.subscribe(() => {
			const { status } = store.getState();
			if (status === "running") {
				started = true;
				return;
			}
			if (started) {
				unsubscribe();
				resolve();
			}
		});

		store.dispatch(action);
	});
}

function runPrompt(input: string): Promise<void> {
	return dispatchAndWait(agentSubmit(input));
}

function runRetry(): Promise<void> {
	return dispatchAndWait(agentRetry());
}

async function runOneShot(input: string): Promise<void> {
	process.once("SIGINT", () => store.dispatch(agentInterrupt()));
	await runPrompt(input);
	shutdown(store.getState().status === "error" ? 1 : 0);
}

async function runRepl(): Promise<void> {
	const rl = createInterface({ input: stdin, output: stdout });

	rl.on("SIGINT", () => {
		if (store.getState().status === "running") {
			store.dispatch(agentInterrupt());
		} else {
			rl.close();
		}
	});

	stdout.write(`Mini Pi Agents · ${config.model}\n`);
	stdout.write(`cwd: ${cwd}\n`);
	stdout.write(`输入 "exit" 退出，Ctrl+C 中断当前任务，"retry" 重跑上一次任务。\n`);

	try {
		for (;;) {
			let line: string;
			try {
				line = await rl.question("\n> ");
			} catch {
				break;
			}

			const input = line.trim();
			if (input.length === 0) continue;
			if (input === "exit" || input === "quit") break;

			if (input === "retry") {
				await runRetry();
				continue;
			}

			await runPrompt(input);
		}
	} finally {
		rl.close();
	}

	shutdown(store.getState().status === "error" ? 1 : 0);
}

async function runTui(): Promise<void> {
	await attachTui(store, { model: config.model, cwd });
	shutdown(store.getState().status === "error" ? 1 : 0);
}

/** DevTools 的 socket 会持续占用事件循环，启用时需要显式退出。 */
function shutdown(code: number): void {
	process.exitCode = code;
	if (devtoolsEnabled) process.exit(code);
}

const oneShotInput = argv
	.filter((arg) => arg !== "--devtools" && arg !== "--tui" && arg !== "--single")
	.join(" ")
	.trim();
if (oneShotInput.length > 0) {
	await runOneShot(oneShotInput);
} else if (tuiEnabled) {
	await runTui();
} else {
	await runRepl();
}
