/** Store 组装：reducer + Saga middleware，CLI 与未来多 Agent 编排共用同一入口。 */

import { applyMiddleware, compose, createStore, type Store, type StoreEnhancer } from "redux";
import createSagaMiddleware from "redux-saga";
import type { AgentAction } from "./actions.ts";
import { agentReducer, initialState, type AgentState } from "./reducer.ts";
import { createAgentSaga, type AgentRuntime } from "./sagas.ts";

export interface AgentStoreOptions {
	/** 可选的 store 增强器，例如 Redux DevTools。 */
	enhancer?: StoreEnhancer;
}

export function createAgentStore(
	runtime: AgentRuntime,
	options: AgentStoreOptions = {},
): Store<AgentState, AgentAction> {
	const sagaMiddleware = createSagaMiddleware();
	const middleware = applyMiddleware(sagaMiddleware);
	const enhancer = options.enhancer
		? (compose(middleware, options.enhancer) as unknown as StoreEnhancer)
		: middleware;

	const store = createStore(agentReducer, initialState, enhancer);
	sagaMiddleware.run(createAgentSaga(runtime));
	return store as Store<AgentState, AgentAction>;
}

export type AgentStore = ReturnType<typeof createAgentStore>;
export type { AgentState, AgentRuntime };
