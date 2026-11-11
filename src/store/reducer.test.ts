/** Redux reducer 单元测试 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	agentReducer,
	initialState,
	type AgentState,
	selectMessages,
} from "./reducer.ts";
import {
	agentSubmit,
	agentTurnStarted,
	agentTextDelta,
	agentTurnEnded,
	agentMessageAdded,
	toolStarted,
	toolEnded,
	agentError,
	agentEnded,
	agentAborted,
	agentInterrupt,
	type AgentAction,
} from "./actions.ts";
import type { AssistantMessage, Message, ToolCallContent } from "../types.ts";

describe("reducer", () => {
	test("initialState has correct defaults", () => {
		const state = initialState;

		assert.strictEqual(state.status, "idle");
		assert.deepStrictEqual(state.messages, []);
		assert.strictEqual(state.turn, 0);
		assert.strictEqual(state.streamingText, "");
		assert.strictEqual(state.tool, null);
		assert.strictEqual(state.error, null);
		assert.deepStrictEqual(state.stats, { toolCalls: 0 });
	});

	test("AGENT_SUBMIT resets state and adds user message", () => {
		const action = agentSubmit("hello");
		const state = agentReducer(initialState, action);

		assert.strictEqual(state.status, "running");
		assert.strictEqual(state.messages.length, 1);
		assert.strictEqual(state.messages[0]!.role, "user");
		assert.strictEqual(state.messages[0]!.content, "hello");
		assert.strictEqual(state.turn, 0);
		assert.strictEqual(state.streamingText, "");
		assert.strictEqual(state.tool, null);
		assert.strictEqual(state.error, null);
		assert.deepStrictEqual(state.stats, { toolCalls: 0 });
	});

	test("AGENT_TURN_STARTED increments turn and clears streamingText", () => {
		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentTurnStarted());

		assert.strictEqual(state.turn, 1);
		assert.strictEqual(state.streamingText, "");
	});

	test("AGENT_TEXT_DELTA appends to streamingText", () => {
		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentTurnStarted());
		state = agentReducer(state, agentTextDelta("Hello"));
		state = agentReducer(state, agentTextDelta(" World"));

		assert.strictEqual(state.streamingText, "Hello World");
	});

	test("AGENT_TURN_ENDED adds assistant message to messages", () => {
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hello!" }],
			timestamp: Date.now(),
			stopReason: "stop",
		};

		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentTurnEnded(assistantMessage));

		assert.strictEqual(state.messages.length, 2);
		assert.strictEqual(state.messages[1]!.role, "assistant");
	});

	test("AGENT_MESSAGE_ADDED adds message to messages", () => {
		const message: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read_file",
			content: [{ type: "text", text: "file content" }],
			isError: false,
			timestamp: Date.now(),
			durationMs: 100,
		};

		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentMessageAdded(message));

		assert.strictEqual(state.messages.length, 2);
		assert.strictEqual(state.messages[1], message);
	});

	test("TOOL_STARTED sets tool activity and increments toolCalls", () => {
		const toolCall: ToolCallContent = {
			type: "toolCall",
			id: "call_123",
			name: "read_file",
			arguments: { path: "src/test.ts" },
		};

		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, toolStarted(toolCall));

		assert.strictEqual(state.tool?.id, "call_123");
		assert.strictEqual(state.tool?.name, "read_file");
		assert.strictEqual(state.tool?.status, "running");
		assert.deepStrictEqual(state.tool?.args, { path: "src/test.ts" });
		assert.strictEqual(state.stats.toolCalls, 1);
	});

	test("TOOL_ENDED updates tool status to done", () => {
		const toolCall: ToolCallContent = {
			type: "toolCall",
			id: "call_123",
			name: "read_file",
			arguments: { path: "src/test.ts" },
		};

		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, toolStarted(toolCall));
		state = agentReducer(state, toolEnded({
			toolCallId: "call_123",
			toolName: "read_file",
			isError: false,
			durationMs: 150,
		}));

		assert.strictEqual(state.tool?.status, "done");
		assert.strictEqual(state.tool?.durationMs, 150);
	});

	test("TOOL_ENDED updates tool status to error", () => {
		const toolCall: ToolCallContent = {
			type: "toolCall",
			id: "call_123",
			name: "read_file",
			arguments: { path: "src/test.ts" },
		};

		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, toolStarted(toolCall));
		state = agentReducer(state, toolEnded({
			toolCallId: "call_123",
			toolName: "read_file",
			isError: true,
			durationMs: 150,
		}));

		assert.strictEqual(state.tool?.status, "error");
		assert.strictEqual(state.tool?.durationMs, 150);
	});

	test("TOOL_ENDED ignores mismatched toolCallId", () => {
		const toolCall: ToolCallContent = {
			type: "toolCall",
			id: "call_123",
			name: "read_file",
			arguments: { path: "src/test.ts" },
		};

		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, toolStarted(toolCall));
		state = agentReducer(state, toolEnded({
			toolCallId: "call_999",
			toolName: "read_file",
			isError: false,
			durationMs: 150,
		}));

		// tool 应该保持 running 状态
		assert.strictEqual(state.tool?.status, "running");
		assert.strictEqual(state.tool?.durationMs, undefined);
	});

	test("AGENT_ERROR sets error status and message", () => {
		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentError("API key invalid"));

		assert.strictEqual(state.status, "error");
		assert.strictEqual(state.error, "API key invalid");
	});

	test("AGENT_ENDED sets status to idle when not error", () => {
		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentEnded());

		assert.strictEqual(state.status, "idle");
	});

	test("AGENT_ENDED keeps error status when already error", () => {
		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentError("Something failed"));
		state = agentReducer(state, agentEnded());

		assert.strictEqual(state.status, "error");
	});

	test("AGENT_ABORTED sets status to idle with abort message", () => {
		let state = agentReducer(initialState, agentSubmit("test"));
		state = agentReducer(state, agentAborted());

		assert.strictEqual(state.status, "idle");
		assert.strictEqual(state.error, "已取消本次任务");
	});

	test("AGENT_INTERRUPT does not change state (handled by saga)", () => {
		let state = agentReducer(initialState, agentSubmit("test"));
		const before = { ...state };
		state = agentReducer(state, agentInterrupt());

		// state should be unchanged
		assert.deepStrictEqual(state, before);
	});

	test("reducer returns same state for unknown action", () => {
		const unknownAction = { type: "unknown/action" } as unknown as AgentAction;
		const state = agentReducer(initialState, unknownAction);

		assert.strictEqual(state, initialState);
	});

	test("multiple turns work correctly", () => {
		let state = agentReducer(initialState, agentSubmit("test"));

		// Turn 1
		state = agentReducer(state, agentTurnStarted());
		state = agentReducer(state, agentTextDelta("First turn"));
		const msg1: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "First turn" }],
			timestamp: Date.now(),
			stopReason: "stop",
		};
		state = agentReducer(state, agentTurnEnded(msg1));

		// Turn 2
		state = agentReducer(state, agentTurnStarted());
		state = agentReducer(state, agentTextDelta("Second turn"));
		const msg2: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Second turn" }],
			timestamp: Date.now(),
			stopReason: "stop",
		};
		state = agentReducer(state, agentTurnEnded(msg2));

		assert.strictEqual(state.turn, 2);
		assert.strictEqual(state.messages.length, 3); // 1 user + 2 assistant
		assert.strictEqual(state.streamingText, "");
	});
});

describe("selectMessages selector", () => {
	test("returns messages array", () => {
		let state = agentReducer(initialState, agentSubmit("test"));

		const msg1: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			timestamp: Date.now(),
			stopReason: "stop",
		};
		state = agentReducer(state, agentTurnEnded(msg1));

		const messages = selectMessages(state);
		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0]!.role, "user");
		assert.strictEqual(messages[1]!.role, "assistant");
	});
});