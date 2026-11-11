/** Test runner that uses node:test */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	AGENT_SUBMIT,
	AGENT_TURN_STARTED,
	AGENT_TEXT_DELTA,
	AGENT_TURN_ENDED,
	AGENT_MESSAGE_ADDED,
	TOOL_STARTED,
	TOOL_ENDED,
	AGENT_ERROR,
	AGENT_ENDED,
	AGENT_INTERRUPT,
	AGENT_ABORTED,
	agentSubmit,
	agentTurnStarted,
	agentTextDelta,
	agentTurnEnded,
	agentMessageAdded,
	toolStarted,
	toolEnded,
	agentError,
	agentEnded,
	agentInterrupt,
	agentAborted,
	type AgentAction,
} from "./actions.ts";

describe("actions constants", () => {
	test("action type constants are defined", () => {
		assert.strictEqual(AGENT_SUBMIT, "agent/submit");
		assert.strictEqual(AGENT_TURN_STARTED, "agent/turnStarted");
		assert.strictEqual(AGENT_TEXT_DELTA, "agent/textDelta");
		assert.strictEqual(AGENT_TURN_ENDED, "agent/turnEnded");
		assert.strictEqual(AGENT_MESSAGE_ADDED, "agent/messageAdded");
		assert.strictEqual(TOOL_STARTED, "agent/toolStarted");
		assert.strictEqual(TOOL_ENDED, "agent/toolEnded");
		assert.strictEqual(AGENT_ERROR, "agent/error");
		assert.strictEqual(AGENT_ENDED, "agent/ended");
		assert.strictEqual(AGENT_INTERRUPT, "agent/interrupt");
		assert.strictEqual(AGENT_ABORTED, "agent/aborted");
	});
});

describe("action creators", () => {
	test("agentSubmit creates correct action", () => {
		const action = agentSubmit("hello world");

		assert.strictEqual(action.type, AGENT_SUBMIT);
		assert.deepStrictEqual(action.payload.message, {
			role: "user",
			content: "hello world",
			timestamp: action.payload.message.timestamp,
		});
		assert.ok(action.payload.message.timestamp > 0);
	});

	test("agentTurnStarted creates correct action", () => {
		const action = agentTurnStarted();

		assert.strictEqual(action.type, AGENT_TURN_STARTED);
		assert.strictEqual(Object.keys(action).length, 1);
	});

	test("agentTextDelta creates correct action", () => {
		const action = agentTextDelta("some text");

		assert.strictEqual(action.type, AGENT_TEXT_DELTA);
		assert.strictEqual(action.payload.text, "some text");
	});

	test("agentTurnEnded creates correct action", () => {
		const assistantMessage = {
			role: "assistant" as const,
			content: [],
			timestamp: Date.now(),
			stopReason: "stop" as const,
		};

		const action = agentTurnEnded(assistantMessage);

		assert.strictEqual(action.type, AGENT_TURN_ENDED);
		assert.strictEqual(action.payload.message, assistantMessage);
	});

	test("agentMessageAdded creates correct action", () => {
		const message = {
			role: "user" as const,
			content: "test",
			timestamp: Date.now(),
		};

		const action = agentMessageAdded(message);

		assert.strictEqual(action.type, AGENT_MESSAGE_ADDED);
		assert.strictEqual(action.payload.message, message);
	});

	test("toolStarted creates correct action", () => {
		const toolCall = {
			type: "toolCall" as const,
			id: "call_123",
			name: "read_file",
			arguments: { path: "src/test.ts" },
		};

		const action = toolStarted(toolCall);

		assert.strictEqual(action.type, TOOL_STARTED);
		assert.strictEqual(action.payload.toolCallId, "call_123");
		assert.strictEqual(action.payload.toolName, "read_file");
		assert.deepStrictEqual(action.payload.args, { path: "src/test.ts" });
	});

	test("toolEnded creates correct action", () => {
		const result = {
			toolCallId: "call_123",
			toolName: "read_file",
			isError: false,
			durationMs: 150,
		};

		const action = toolEnded(result);

		assert.strictEqual(action.type, TOOL_ENDED);
		assert.deepStrictEqual(action.payload, result);
	});

	test("toolEnded with error creates correct action", () => {
		const result = {
			toolCallId: "call_123",
			toolName: "read_file",
			isError: true,
			durationMs: 150,
		};

		const action = toolEnded(result);

		assert.strictEqual(action.type, TOOL_ENDED);
		assert.strictEqual(action.payload.isError, true);
	});

	test("agentError creates correct action", () => {
		const action = agentError("Something went wrong");

		assert.strictEqual(action.type, AGENT_ERROR);
		assert.strictEqual(action.payload.message, "Something went wrong");
	});

	test("agentEnded creates correct action", () => {
		const action = agentEnded();

		assert.strictEqual(action.type, AGENT_ENDED);
		assert.strictEqual(Object.keys(action).length, 1);
	});

	test("agentInterrupt creates correct action", () => {
		const action = agentInterrupt();

		assert.strictEqual(action.type, AGENT_INTERRUPT);
		assert.strictEqual(Object.keys(action).length, 1);
	});

	test("agentAborted creates correct action", () => {
		const action = agentAborted();

		assert.strictEqual(action.type, AGENT_ABORTED);
		assert.strictEqual(Object.keys(action).length, 1);
	});
});

describe("AgentAction type union", () => {
	test("all action creators return valid AgentAction types", () => {
		const actions: AgentAction[] = [
			agentSubmit("test"),
			agentTurnStarted(),
			agentTextDelta("test"),
			agentTurnEnded({
				role: "assistant",
				content: [],
				timestamp: Date.now(),
				stopReason: "stop",
			}),
			agentMessageAdded({
				role: "user",
				content: "test",
				timestamp: Date.now(),
			}),
			toolStarted({
				type: "toolCall",
				id: "call_1",
				name: "test_tool",
				arguments: {},
			}),
			toolEnded({
				toolCallId: "call_1",
				toolName: "test_tool",
				isError: false,
				durationMs: 100,
			}),
			agentError("error"),
			agentEnded(),
			agentInterrupt(),
			agentAborted(),
		];

		assert.strictEqual(actions.length, 11);
	});
});