/** Store integration 测试 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createStore, applyMiddleware } from "redux";
import createSagaMiddleware from "redux-saga";
import { agentReducer, initialState, type AgentState } from "./reducer.ts";
import { agentSubmit, agentTurnStarted, agentTextDelta, agentTurnEnded, toolStarted, toolEnded, agentError, agentEnded, agentAborted, agentInterrupt, AGENT_SUBMIT, type AgentAction } from "./actions.ts";
import type { AssistantMessage, ToolCallContent } from "../types.ts";
import { take, put } from "redux-saga/effects";

describe("Store integration", () => {
	test("store dispatches actions and updates state", () => {
		const store = createStore(agentReducer, initialState);

		const listener = () => {};
		store.subscribe(listener);

		// Dispatch agentSubmit
		store.dispatch(agentSubmit("test input"));

		const state = store.getState();
		assert.strictEqual(state.status, "running");
		assert.strictEqual(state.messages.length, 1);
		assert.strictEqual(state.messages[0]!.content, "test input");
	});

	test("store with saga middleware", async () => {
		const sagaMiddleware = createSagaMiddleware();
		const store = createStore(agentReducer, initialState, applyMiddleware(sagaMiddleware));

		// Mock a simple saga that just echoes
		function* testSaga() {
			yield take(AGENT_SUBMIT);
			yield put(agentTurnStarted());
			yield put(agentTextDelta("Hello"));
			yield put(agentTextDelta(" World"));
			const msg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Hello World" }],
				timestamp: Date.now(),
				stopReason: "stop",
			};
			yield put(agentTurnEnded(msg));
			yield put(agentEnded());
		}

		sagaMiddleware.run(testSaga);

		store.dispatch(agentSubmit("test"));

		// Wait for saga to complete
		await new Promise(resolve => setTimeout(resolve, 50));

		const state = store.getState();
		assert.strictEqual(state.status, "idle");
		assert.strictEqual(state.messages.length, 2);
		assert.strictEqual(state.messages[1]!.role, "assistant");
	});

	test("action types are consistent", () => {
		const action = agentSubmit("test");
		assert.strictEqual(action.type, AGENT_SUBMIT);
	});
});