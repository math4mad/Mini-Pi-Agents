/** pi Session 投影层单元测试 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { projectMessages, projectPiMessage, projectSessionEvent, type PiAgentMessage } from "./projection.ts";

function piMessage(value: Record<string, unknown>): PiAgentMessage {
	return value as unknown as PiAgentMessage;
}

function piEvent(value: Record<string, unknown>): AgentSessionEvent {
	return value as unknown as AgentSessionEvent;
}

describe("projectPiMessage", () => {
	test("user 消息保留文本与图片 data URL", () => {
		const message = projectPiMessage(
			piMessage({
				role: "user",
				content: [
					{ type: "text", text: "看这张图" },
					{ type: "image", data: "AAA", mimeType: "image/png" },
				],
				timestamp: 1,
			}),
		);

		assert.deepStrictEqual(message, {
			role: "user",
			content: "看这张图",
			timestamp: 1,
			images: ["data:image/png;base64,AAA"],
		});
	});

	test("assistant 消息跳过 thinking，保留文本、工具调用与 usage", () => {
		const message = projectPiMessage(
			piMessage({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内部推理" },
					{ type: "text", text: "开始" },
					{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } },
				],
				stopReason: "toolUse",
				usage: { input: 10, output: 5, totalTokens: 15 },
				timestamp: 2,
			}),
		);

		assert.deepStrictEqual(message, {
			role: "assistant",
			content: [
				{ type: "text", text: "开始" },
				{ type: "toolCall", id: "c1", name: "echo", arguments: { text: "hi" } },
			],
			timestamp: 2,
			stopReason: "toolUse",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		});
	});

	test("assistant 的 pending stopReason 归一为 stop，并保留错误信息", () => {
		const pending = projectPiMessage(
			piMessage({ role: "assistant", content: [], stopReason: "pending", timestamp: 3 }),
		);
		assert.strictEqual(pending?.role === "assistant" ? pending.stopReason : undefined, "stop");
		assert.deepStrictEqual(
			projectPiMessage(
				piMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "boom", timestamp: 4 }),
			),
			{
				role: "assistant",
				content: [],
				timestamp: 4,
				stopReason: "error",
				errorMessage: "boom",
			},
		);
	});

	test("toolResult 只保留文本内容", () => {
		assert.deepStrictEqual(
			projectPiMessage(
				piMessage({
					role: "toolResult",
					toolCallId: "c1",
					toolName: "echo",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 5,
				}),
			),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "echo",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 5,
			},
		);
	});

	test("system 等自定义消息被忽略", () => {
		assert.strictEqual(projectPiMessage(piMessage({ role: "system", content: "rules", timestamp: 6 })), null);
		assert.strictEqual(projectPiMessage(piMessage({ role: "bashExecution", command: "ls", timestamp: 7 })), null);
	});
});

describe("projectMessages", () => {
	test("过滤不可投影的消息", () => {
		const messages = projectMessages([
			piMessage({ role: "system", content: "rules", timestamp: 1 }),
			piMessage({ role: "user", content: "hi", timestamp: 2 }),
		]);

		assert.deepStrictEqual(messages, [{ role: "user", content: "hi", timestamp: 2 }]);
	});
});

describe("projectSessionEvent", () => {
	test("turn_start 与 text_delta", () => {
		assert.strictEqual(projectSessionEvent(piEvent({ type: "turn_start" }))[0]?.type, "agent/turnStarted");
		assert.deepStrictEqual(
			projectSessionEvent(
				piEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你" } }),
			),
			[{ type: "agent/textDelta", payload: { text: "你" } }],
		);
	});

	test("非文本增量不产生 action", () => {
		assert.deepStrictEqual(
			projectSessionEvent(
				piEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } }),
			),
			[],
		);
	});

	test("assistant / toolResult 的 message_end 落库，user 不重复落库", () => {
		const assistant = projectSessionEvent(
			piEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "stop", timestamp: 1 },
			}),
		);
		assert.strictEqual(assistant[0]?.type, "agent/turnEnded");

		const toolResult = projectSessionEvent(
			piEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "echo",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			}),
		);
		assert.strictEqual(toolResult[0]?.type, "agent/messageAdded");

		assert.deepStrictEqual(
			projectSessionEvent(piEvent({ type: "message_end", message: { role: "user", content: "hi", timestamp: 3 } })),
			[],
		);
	});

	test("工具执行开始与结束", () => {
		const started = projectSessionEvent(
			piEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "echo", args: { text: "hi" } }),
		);
		assert.deepStrictEqual(started, [
			{ type: "agent/toolStarted", payload: { toolCallId: "c1", toolName: "echo", args: { text: "hi" } } },
		]);

		const ended = projectSessionEvent(
			piEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "echo", isError: false, durationMs: 12 }),
		);
		assert.deepStrictEqual(ended, [
			{ type: "agent/toolEnded", payload: { toolCallId: "c1", toolName: "echo", isError: false, durationMs: 12 } },
		]);
	});

	test("agent_end 只在终态时报告错误", () => {
		const errorMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "boom",
			timestamp: 1,
		};
		assert.deepStrictEqual(
			projectSessionEvent(piEvent({ type: "agent_end", messages: [errorMessage], willRetry: true })),
			[],
		);
		assert.deepStrictEqual(
			projectSessionEvent(piEvent({ type: "agent_end", messages: [errorMessage], willRetry: false })),
			[{ type: "agent/error", payload: { message: "boom" } }],
		);
	});

	test("agent_settled 不结束任务（由编排层决定）", () => {
		assert.deepStrictEqual(projectSessionEvent(piEvent({ type: "agent_settled", aborted: false })), []);
		assert.deepStrictEqual(projectSessionEvent(piEvent({ type: "agent_settled", aborted: true })), []);
	});
});
