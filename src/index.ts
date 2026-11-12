/** CLI 入口：终端是唯一入口；状态全部走 Redux store，副作用全部走 Saga。 */

import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { createPipeline, createSingleStage } from "./agent/pipeline.ts";
import { attachRenderer } from "./cli/renderer.ts";
import { attachTui } from "./cli/tui.ts";
import { loadConfig } from "./config.ts";
import { agentInterrupt, agentRetry, agentSubmit, workerStart } from "./store/actions.ts";
import { loadDevtoolsEnhancer } from "./store/devtools.ts";
import { createAgentStore } from "./store/index.ts";
import { createRemoteSaga, createWorkerSaga } from "./store/remote.ts";
import { createAgentSaga, type AgentRuntime } from "./store/sagas.ts";

const cwd = process.cwd();
const config = loadConfig();

const argv = process.argv.slice(2);
const devtoolsEnabled = argv.includes("--devtools") || process.env.REDUX_DEVTOOLS === "1";
const singleAgent = argv.includes("--single");
const exitOnIdle = argv.includes("--exit-on-idle");
const remoteEnabled = argv.includes("--remote");
/** 图片输入：--image <path>，可重复。读取后转成 data URL 交给多模态模型。 */
const imagePaths: string[] = [];
argv.forEach((arg, index) => {
	if (arg === "--image") {
		imagePaths.push(argv[index + 1] ?? "");
		return;
	}
	if (arg.startsWith("--image=")) imagePaths.push(arg.slice("--image=".length));
});
const images = imagePaths.filter((path) => path.length > 0).map(toDataUrl);
const workerFlagIndex = argv.indexOf("--worker");
const workerId =
	workerFlagIndex >= 0
		? (argv[workerFlagIndex + 1] ?? null)
		: (argv.find((arg) => arg.startsWith("--worker="))?.slice("--worker=".length) ?? null);
const graphqlUrl = process.env.GRAPHQL_URL ?? "http://127.0.0.1:4123/graphql";
// 工作节点是非交互进程，不挂 TUI。
const tuiEnabled = argv.includes("--tui") && stdout.isTTY === true && workerId === null;
const parsedDevtoolsPort = Number.parseInt(process.env.REDUX_DEVTOOLS_PORT ?? "", 10);
const devtoolsPort = Number.isFinite(parsedDevtoolsPort) ? parsedDevtoolsPort : 8000;

if (workerFlagIndex >= 0 && !workerId) {
	stdout.write("用法：--worker <machine-id>，例如 --worker mac-mini\n");
	process.exit(2);
}

const runtime: AgentRuntime = {
	apiKey: config.apiKey,
	baseUrl: config.baseUrl,
	model: config.model,
	stages: singleAgent ? [createSingleStage(cwd)] : createPipeline(cwd),
	maxTurns: 30,
	maxAttempts: 2,
};

// 远端模式只替换根 Saga，渲染层与 action 完全不变。
const saga = workerId
	? createWorkerSaga(runtime, {
			url: graphqlUrl,
			machineId: workerId,
			exitOnIdle,
		})
	: remoteEnabled
		? createRemoteSaga(runtime, { url: graphqlUrl })
		: createAgentSaga(runtime);

const store = createAgentStore(runtime, {
	enhancer: await loadDevtoolsEnhancer({ enabled: devtoolsEnabled, port: devtoolsPort }),
	saga,
});

// TUI 自己负责渲染，二者不能同时挂载，否则输出会互相覆盖。
if (!tuiEnabled) attachRenderer(store);

if (devtoolsEnabled) {
	stdout.write(`Redux DevTools: 先运行 "npm run devtools"，再打开 http://127.0.0.1:${devtoolsPort}\n`);
}
if (remoteEnabled && !workerId) {
	stdout.write(`远端协调者: ${graphqlUrl}\n`);
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
	return dispatchAndWait(agentSubmit(input, images));
}

/** 读取本地图片并转成 data URL，避免依赖公网可访问地址。 */
function toDataUrl(path: string): string {
	const ext = extname(path).toLowerCase();
	const mime =
		ext === ".jpg" || ext === ".jpeg"
			? "image/jpeg"
			: ext === ".webp"
				? "image/webp"
				: ext === ".gif"
					? "image/gif"
					: "image/png";
	const data = readFileSync(path).toString("base64");
	return `data:${mime};base64,${data}`;
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

const skipped = new Set<number>();
argv.forEach((arg, index) => {
	if (["--devtools", "--tui", "--single", "--remote", "--exit-on-idle"].includes(arg)) {
		skipped.add(index);
		return;
	}
	if (arg === "--image") {
		skipped.add(index);
		skipped.add(index + 1);
		return;
	}
	if (arg.startsWith("--image=")) skipped.add(index);
	if (arg === "--worker") {
		skipped.add(index);
		skipped.add(index + 1);
		return;
	}
	if (arg.startsWith("--worker=")) skipped.add(index);
});

const oneShotInput = argv
	.filter((_arg, index) => !skipped.has(index))
	.join(" ")
	.trim();

if (workerId) {
	stdout.write(`Worker ${workerId} · ${graphqlUrl}${exitOnIdle ? " · 完成后退出" : ""}\n`);
	await dispatchAndWait(workerStart());
	shutdown(store.getState().status === "error" ? 1 : 0);
} else if (oneShotInput.length > 0 || images.length > 0) {
	await runOneShot(
		oneShotInput.length > 0 ? oneShotInput : "识别图片中的手写表格，整理成规范的 CSV 数据。",
	);
} else if (tuiEnabled) {
	await runTui();
} else {
	await runRepl();
}
