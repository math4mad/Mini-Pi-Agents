/**
 * 远端协同集成测试：真实启动 POC GraphQL 服务，验证客户端、协调者 Saga 与工作节点 Saga。
 *
 * 覆盖要点：
 * - RemoteClient 的查询 / CAS 提交 / 事件顺序与中止
 * - 协调者把远端事件映射为既有 action，并在任务结束后自然回到 idle
 * - 订阅回放超过 10 条事件时不丢事件（eventChannel 固定缓冲的回归用例）
 * - 工作节点按阶段顺序领取、用本机模型执行并 CAS 提交
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { RemoteClient } from "../remote/graphql.ts";
import type { StageRuntime } from "../types.ts";
import { agentInterrupt, agentSubmit, workerStart } from "./actions.ts";
import { createAgentStore, type AgentStore, type AgentState } from "./index.ts";
import { createRemoteSaga, createWorkerSaga } from "./remote.ts";
import type { AgentRuntime } from "./sagas.ts";

const PORT = Number(process.env.POC_TEST_PORT ?? 4319);
const url = `http://127.0.0.1:${PORT}/graphql`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let server: ChildProcess;

before(async () => {
	server = await startServer();
});

after(async () => {
	server.kill("SIGTERM");
	await waitExit(server);
});

async function startServer(): Promise<ChildProcess> {
	const serverPath = fileURLToPath(new URL("../../poc/server.ts", import.meta.url));
	const child = spawn(process.execPath, [serverPath], {
		env: { ...process.env, POC_PORT: String(PORT) },
		stdio: ["ignore", "pipe", "inherit"],
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("server did not become ready")), 10_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("READY")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`server exited early with code ${code}`));
		});
	});
	return child;
}

function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.on("exit", () => resolve()));
}

function stage(role: StageRuntime["role"], name: string): StageRuntime {
	return { role, name, systemPrompt: role, tools: [] };
}

/** 假模型：不联网，固定返回一段文本。 */
function createRuntime(output: string): AgentRuntime {
	return {
		apiKey: "test",
		baseUrl: "http://localhost",
		model: "test-model",
		stages: [stage("planner", "Planner"), stage("executor", "Executor"), stage("reviewer", "Reviewer")],
		maxTurns: 2,
		maxAttempts: 1,
		stream: async () => ({
			role: "assistant",
			content: [{ type: "text", text: output }],
			timestamp: Date.now(),
			stopReason: "stop",
		}),
	};
}

/** 等待 store 进入指定状态；超时直接失败，避免测试悬挂。 */
function waitFor(
	store: AgentStore,
	predicate: (state: AgentState) => boolean,
	timeoutMs = 15_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (predicate(store.getState())) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("等待 store 状态超时"));
		}, timeoutMs);
		const unsubscribe = store.subscribe(() => {
			if (!predicate(store.getState())) return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
}

interface FakeWorker {
	stop(): Promise<void>;
}

/** 进程内假工作节点：按顺序领取阶段并用 CAS 提交，不调用模型。 */
function runFakeWorker(
	machineId: string,
	options: { output?: string; status?: "done" | "error" } = {},
): FakeWorker {
	const client = new RemoteClient(url);
	const output = options.output ?? machineId;
	const status = options.status ?? "done";
	let stopped = false;

	const done = (async () => {
		while (!stopped) {
			const tasks = await client.tasks();
			const pending = tasks.filter((task) => task.status !== "done" && task.status !== "failed");
			let worked = false;

			for (const task of pending) {
				const stages = await client.stages(task.id);
				const next = stages.find((candidate) => candidate.status !== "done" && candidate.status !== "error");
				if (!next) continue;
				try {
					const claimed = await client.claimStage(next.id, machineId, 60_000);
					await client.finishStage(next.id, claimed.version, output, status);
					worked = true;
					break;
				} catch {
					// 前序未完成或被其他节点抢占，下一轮重试。
				}
			}

			if (!worked) await sleep(20);
		}
	})();

	return {
		async stop() {
			stopped = true;
			await done;
		},
	};
}

/** 把任务剩余阶段直接跑完，避免影响后续用例的 pending 判断。 */
async function drainTask(client: RemoteClient, taskId: string, output = "drained"): Promise<void> {
	const stages = await client.stages(taskId);
	for (const target of stages) {
		if (target.status === "done" || target.status === "error") continue;
		const claimed = await client.claimStage(target.id, "cleanup", 60_000);
		await client.finishStage(target.id, claimed.version, output, "done");
	}
}

test("RemoteClient 创建阶段、CAS 提交并拒绝过期版本", async () => {
	const client = new RemoteClient(url);
	const task = await client.createTask("client-basics");
	const stages = await client.stages(task.id);

	assert.deepEqual(stages.map((item) => item.role), ["planner", "executor", "reviewer"]);
	assert.deepEqual(stages.map((item) => item.index), [0, 1, 2]);

	const planner = stages[0]!;
	const claimed = await client.claimStage(planner.id, "machine-a", 60_000);
	assert.equal(claimed.owner, "machine-a");
	assert.equal(claimed.status, "running");

	await client.finishStage(planner.id, claimed.version, "planner-output", "done");
	const updated = await client.stage(planner.id);
	assert.equal(updated?.status, "done");
	assert.equal(updated?.output, "planner-output");
	assert.equal(updated?.owner, null);

	// 版本已推进，用旧版本重复提交必须失败。
	await assert.rejects(() => client.finishStage(planner.id, claimed.version, "stale", "done"));

	await drainTask(client, task.id);
});

test("RemoteClient 订阅按 seq 回放事件，中止后连接可关闭", async () => {
	const client = new RemoteClient(url);
	const since = await client.lastSeq();
	const task = await client.createTask("client-subscribe");

	const controller = new AbortController();
	const iterator = client.subscribe(since, controller.signal)[Symbol.asyncIterator]();

	const events = [];
	while (events.length < 4) {
		const next = await iterator.next();
		if (next.done) break;
		events.push(next.value);
	}

	assert.deepEqual(
		events.map((event) => event.type).sort(),
		["stage.created", "stage.created", "stage.created", "task.created"].sort(),
	);
	const seqs = events.map((event) => event.seq);
	assert.ok(
		seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!),
		`事件 seq 必须递增：${seqs.join(",")}`,
	);
	assert.ok(events.every((event) => event.payload.taskId === task.id));

	await drainTask(client, task.id);
	controller.abort();
	await iterator.return?.(undefined);
});

test("协调者把远端事件映射为 Redux 状态并自然结束", async () => {
	const store = createAgentStore(createRuntime("unused"), {
		saga: createRemoteSaga(createRuntime("unused"), { url }),
	});
	const worker = runFakeWorker("fake-ok", { output: "remote-output" });

	try {
		store.dispatch(agentSubmit("协调者用例"));
		await waitFor(
			store,
			(state) => state.status === "idle" && state.pipeline.stages.every((item) => item.status === "done"),
			20_000,
		);
	} finally {
		await worker.stop();
	}

	const state = store.getState();
	assert.equal(state.status, "idle");
	assert.equal(state.pipeline.stages.length, 3);
	assert.deepEqual(
		state.pipeline.stages.map((item) => item.name),
		["Planner", "Executor", "Reviewer"],
	);
	assert.ok(state.pipeline.stages.every((item) => item.output === "remote-output"));
	assert.equal(state.pipeline.activeIndex, 2);
	assert.equal(state.error, null);

	// 每个阶段产物都会以一轮 assistant 消息的形式进入会话记录（外加第一条 user 消息）。
	const assistantMessages = state.messages.filter((message) => message.role === "assistant");
	assert.equal(assistantMessages.length, 3);
});

test("协调者在远端任务失败时进入 error 并标记失败阶段", async () => {
	const store = createAgentStore(createRuntime("unused"), {
		saga: createRemoteSaga(createRuntime("unused"), { url }),
	});
	const worker = runFakeWorker("fake-fail", { output: "boom", status: "error" });

	try {
		store.dispatch(agentSubmit("失败路径"));
		await waitFor(store, (state) => state.status === "error", 20_000);
	} finally {
		await worker.stop();
	}

	const state = store.getState();
	assert.equal(state.status, "error");
	assert.match(state.error ?? "", /failed/);
	assert.equal(state.pipeline.stages[0]?.status, "error");
	assert.equal(state.pipeline.stages[0]?.error, "boom");
});

test("工作节点按顺序领取阶段并用本机模型提交结果", async () => {
	const client = new RemoteClient(url);
	const task = await client.createTask("worker-saga");

	const runtime = createRuntime("worker-output");
	const store = createAgentStore(runtime, {
		saga: createWorkerSaga(runtime, {
			url,
			machineId: "w-test",
			exitOnIdle: true,
			pollMs: 20,
		}),
	});

	store.dispatch(workerStart());
	await waitFor(
		store,
		(state) => state.status === "idle" && state.pipeline.stages.length === 3,
		20_000,
	);

	const stages = await client.stages(task.id);
	assert.ok(stages.every((item) => item.status === "done"), JSON.stringify(stages));
	assert.ok(stages.every((item) => item.output === "worker-output"));
	assert.ok(stages.every((item) => item.owner === null));

	const remoteTask = await client.task(task.id);
	assert.equal(remoteTask?.status, "done");

	const state = store.getState();
	assert.ok(state.pipeline.stages.every((item) => item.status === "done"));
	assert.equal(state.error, null);
});

test("中断会取消本地订阅并回到 idle", async () => {
	const store = createAgentStore(createRuntime("unused"), {
		saga: createRemoteSaga(createRuntime("unused"), { url }),
	});

	store.dispatch(agentSubmit("中断用例"));
	await waitFor(store, (state) => state.pipeline.stages.length === 3);
	store.dispatch(agentInterrupt());

	await waitFor(store, (state) => state.status !== "running");
	assert.equal(store.getState().status, "idle");
	assert.equal(store.getState().error, "已取消本次任务");
});
