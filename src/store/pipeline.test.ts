/** 流水线编排测试：注入假模型，验证自动返工回路与手动重试。 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CompletionRequest } from "../provider/openai.ts";
import type { AgentAction } from "./actions.ts";
import { agentRetry, agentSubmit } from "./actions.ts";
import { createAgentStore } from "./index.ts";
import type { AgentRuntime } from "./sagas.ts";
import type { AssistantMessage, StageRuntime } from "../types.ts";

function stage(role: StageRuntime["role"], name: string): StageRuntime {
	// 假模型用 systemPrompt 区分角色。
	return { role, name, systemPrompt: role, tools: [] };
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "stop",
	};
}

function createRuntime(stream: AgentRuntime["stream"]): AgentRuntime {
	return {
		apiKey: "test",
		baseUrl: "http://localhost",
		model: "test-model",
		stages: [stage("planner", "Planner"), stage("executor", "Executor"), stage("reviewer", "Reviewer")],
		maxTurns: 4,
		maxAttempts: 2,
		stream,
	};
}

/** dispatch 后等待 store 从 running 回到非 running。 */
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

test("Reviewer 打回后 Executor 自动返工，直到 APPROVED", async () => {
	const calls = { planner: 0, executor: 0, reviewer: 0 };
	const verdicts = ["问题 1：缺少测试", "APPROVED"];

	const store = createAgentStore(
		createRuntime(async (request: CompletionRequest) => {
			if (request.systemPrompt === "planner") {
				calls.planner += 1;
				return reply("PLAN");
			}
			if (request.systemPrompt === "executor") {
				calls.executor += 1;
				return reply(`impl ${calls.executor}`);
			}
			calls.reviewer += 1;
			return reply(verdicts[calls.reviewer - 1] ?? "APPROVED");
		}),
	);

	await run(store, agentSubmit("实现一个功能"));

	const state = store.getState();
	assert.equal(state.status, "idle");
	assert.equal(state.error, null);
	assert.equal(calls.planner, 1);
	assert.equal(calls.executor, 2, "Reviewer 打回后 Executor 应再执行一次");
	assert.equal(calls.reviewer, 2);

	const [planner, executor, reviewer] = state.pipeline.stages;
	assert.equal(planner?.status, "done");
	assert.equal(executor?.attempt, 2);
	assert.equal(executor?.status, "done");
	assert.equal(reviewer?.status, "done");
	assert.match(reviewer?.output ?? "", /APPROVED/);
});

test("多次未通过时以 Reviewer 失败结束", async () => {
	const store = createAgentStore(
		createRuntime(async (request: CompletionRequest) => {
			if (request.systemPrompt === "planner") return reply("PLAN");
			if (request.systemPrompt === "executor") return reply("impl");
			return reply("仍然缺少测试");
		}),
	);

	await run(store, agentSubmit("实现一个功能"));

	const state = store.getState();
	assert.equal(state.status, "error");
	assert.match(state.error ?? "", /已重试 2 次/);
	assert.equal(state.pipeline.stages[2]?.status, "error");
});

test("手动重试会重跑上一次任务", async () => {
	const calls = { planner: 0, executor: 0, reviewer: 0 };
	const store = createAgentStore(
		createRuntime(async (request: CompletionRequest) => {
			if (request.systemPrompt === "planner") {
				calls.planner += 1;
				return reply("PLAN");
			}
			if (request.systemPrompt === "executor") {
				calls.executor += 1;
				return reply("impl");
			}
			calls.reviewer += 1;
			return reply("APPROVED");
		}),
	);

	await run(store, agentSubmit("实现一个功能"));
	assert.deepEqual(calls, { planner: 1, executor: 1, reviewer: 1 });

	await run(store, agentRetry());
	assert.deepEqual(calls, { planner: 2, executor: 2, reviewer: 2 });
	assert.equal(store.getState().status, "idle");
	assert.equal(store.getState().pipeline.stages[1]?.attempt, 1, "重试应从第 1 次尝试重新开始");
});

test("没有历史任务时手动重试给出错误而不是卡住", async () => {
	const store = createAgentStore(createRuntime(async () => reply("unused")));

	await run(store, agentRetry());

	const state = store.getState();
	assert.equal(state.status, "error");
	assert.match(state.error ?? "", /没有可重试的任务/);
});
