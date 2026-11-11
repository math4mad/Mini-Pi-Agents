/** 纯 reducer：只做状态计算，不产生任何 IO。 */

import type { Message } from "../types.ts";
import {
	AGENT_ABORTED,
	AGENT_ENDED,
	AGENT_ERROR,
	AGENT_INTERRUPT,
	AGENT_MESSAGE_ADDED,
	AGENT_SUBMIT,
	AGENT_TEXT_DELTA,
	AGENT_TURN_ENDED,
	AGENT_TURN_STARTED,
	TOOL_ENDED,
	TOOL_STARTED,
	type AgentAction,
} from "./actions.ts";

export type AgentStatus = "idle" | "running" | "error";

export interface ToolActivity {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	durationMs?: number;
}

export interface AgentState {
	status: AgentStatus;
	messages: Message[];
	/** 第几轮模型请求，用于让渲染层识别新的流式段落。 */
	turn: number;
	/** 当前轮正在流式输出的文本。 */
	streamingText: string;
	/** 最近一次工具调用，CLI 据此渲染工具行。 */
	tool: ToolActivity | null;
	error: string | null;
	stats: { toolCalls: number };
}

export const initialState: AgentState = {
	status: "idle",
	messages: [],
	turn: 0,
	streamingText: "",
	tool: null,
	error: null,
	stats: { toolCalls: 0 },
};

export function agentReducer(state: AgentState = initialState, action: AgentAction): AgentState {
	switch (action.type) {
		case AGENT_SUBMIT:
			return {
				...state,
				status: "running",
				messages: [...state.messages, action.payload.message],
				turn: 0,
				streamingText: "",
				tool: null,
				error: null,
				stats: { toolCalls: 0 },
			};

		case AGENT_TURN_STARTED:
			return { ...state, turn: state.turn + 1, streamingText: "" };

		case AGENT_TEXT_DELTA:
			return { ...state, streamingText: state.streamingText + action.payload.text };

		case AGENT_TURN_ENDED:
			return { ...state, messages: [...state.messages, action.payload.message], streamingText: "" };

		case AGENT_MESSAGE_ADDED:
			return { ...state, messages: [...state.messages, action.payload.message] };

		case TOOL_STARTED:
			return {
				...state,
				tool: {
					id: action.payload.toolCallId,
					name: action.payload.toolName,
					args: action.payload.args,
					status: "running",
				},
				stats: { toolCalls: state.stats.toolCalls + 1 },
			};

		case TOOL_ENDED:
			if (!state.tool || state.tool.id !== action.payload.toolCallId) return state;
			return {
				...state,
				tool: {
					...state.tool,
					status: action.payload.isError ? "error" : "done",
					durationMs: action.payload.durationMs,
				},
			};

		case AGENT_ERROR:
			return { ...state, status: "error", error: action.payload.message };

		case AGENT_ENDED:
			return { ...state, status: state.status === "error" ? "error" : "idle" };

		case AGENT_ABORTED:
			return { ...state, status: "idle", error: "已取消本次任务" };

		case AGENT_INTERRUPT:
			// 中断由 Saga 处理，reducer 只关心最终落到的 AGENT_ABORTED。
			return state;

		default:
			return state;
	}
}

export const selectMessages = (state: AgentState): Message[] => state.messages;
