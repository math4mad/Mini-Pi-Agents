/** Session 编排测试：用假 Driver 验证阶段顺序、返工回路、错误与中断。 */

import assert from "node:assert/strict";
import test from "node:test";
import { agentRetry, agentSubmit, type AgentAction } from "./actions.ts";
import { createAgentStore } from "./index.ts";
import type { AgentRuntime } from "./sagas.ts";
import { createSessionSaga, type SessionDriver } from "./session-saga.ts";
import type { SessionPromptOutcome } from "../session/adapter.ts";
import type { StageRuntime } from "../types.ts";

function stage(role: StageRuntime["role"], name: string): StageRuntime {
	return { role, name, systemPrompt: `你是 ${name}`, tools: [] };
}

function createRuntime(): AgentRuntime {
	return {
		apiKey: "test",
		baseUrl: "http://localhost",
		model: "test-model",
		stages: [stage("planner", "Planner"), stage("executor", "Executor"), stage("reviewer", "Reviewer")],
		maxTurns: 4,
		maxAttempts: 2,
	};
}

function ok(text: string): SessionPromptOutcome {
	return { text, stopReason: "stop" };
}

/** 记录每次 prompt 属于哪个阶段，并返回预设结果。 */
function createDriver(script: (stageName: string, index: number) => SessionPromptOutcome): {
	driver: SessionDriver;
	prompts: string[];
} {
	const prompts: string[] = [];
	return {
		prompts,
		driver: {
			async prompt(text) {
				prompts.push(text);
				const stageName = /你是 (\w+)/.exec(text)?.[1] ?? "unknown";
				return script(stageName, prompts.length);
			},
			async abort() {},
		},
	};
}

function boot(script: (stageName: string, index: number) => SessionPromptOutcome) {
	const { driver, prompts } = createDriver(script);
	const runtime = createRuntime();
	const store = createAgentStore(runtime, {
		saga: createSessionSaga(runtime, { createDriver: async () => driver }),
	});
	return { store, prompts };
}

function run(store: ReturnType<typeof createAgentStore>, action: AgentAction): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("saga 未在 5s 内结束"));
		}, 5000);
		let started = false;
		const unsubscribe = store.subscribe(() => {
			if (store.getState().status === "running") {
				started = true;
				return;
			}
			if (!started) return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
		store.dispatch(action);
	});
}

test("同一 Session 内 planner -> executor -> reviewer，打回后返工到 APPROVED", async () => {
	const verdicts = ["缺少测试", "APPROVED"];
	let executorRuns = 0;
	const { store, prompts } = boot((stageName) => {
		if (stageName === "Planner") return ok("PLAN");
		if (stageName === "Executor") return ok(`impl ${(executorRuns += 1)}`);
		return ok(verdicts.shift() ?? "APPROVED");
	});

	await run(store, agentSubmit("实现一个功能"));

	assert.strictEqual(prompts.length, 5);
	assert.match(prompts[0]!, /你是 Planner/);
	assert.match(prompts[1]!, /你是 Executor/);
	assert.match(prompts[2]!, /你是 Reviewer/);
	// 第二次 executor prompt 带上了 reviewer 反馈。
	assert.match(prompts[3]!, /缺少测试/);
	assert.match(prompts[4]!, /你是 Reviewer/);

	const state = store.getState();
	assert.strictEqual(state.status, "idle");
	assert.deepStrictEqual(
		state.pipeline.stages.map((item) => item.status),
		["done", "done", "done"],
	);
	assert.strictEqual(state.messages.filter((message) => message.role === "user").length, 1);
});

test("阶段返回错误时终止流水线并保留错误信息", async () => {
	const { store, prompts } = boot((stageName) =>
		stageName === "Executor"
			? { text: "", stopReason: "error", errorMessage: "upstream 429" }
			: ok("PLAN"),
	);

	await run(store, agentSubmit("实现一个功能"));

	assert.strictEqual(prompts.length, 2);
	const state = store.getState();
	assert.strictEqual(state.status, "error");
	assert.strictEqual(state.error, "upstream 429");
	assert.strictEqual(state.pipeline.stages[1]?.status, "error");
});

test("阶段被中断时进入取消态", async () => {
	const { store } = boot(() => ({ text: "", stopReason: "aborted", errorMessage: "已取消本次任务" }));

	await run(store, agentSubmit("实现一个功能"));

	const state = store.getState();
	assert.strictEqual(state.status, "idle");
	assert.strictEqual(state.error, "已取消本次任务");
});

test("retry 复用同一个 Driver 重跑上一次任务", async () => {
	const { store, prompts } = boot(() => ok("APPROVED"));

	await run(store, agentSubmit("实现一个功能"));
	await run(store, agentRetry());

	// 单次流水线 3 次 prompt，retry 后共 6 次，且没有新增 user 消息。
	assert.strictEqual(prompts.length, 6);
	assert.strictEqual(store.getState().messages.filter((message) => message.role === "user").length, 1);
});
