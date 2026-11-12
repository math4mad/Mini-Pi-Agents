/** 纯 reducer：只做状态计算，不产生任何 IO。 */

import type { Message, StageDescriptor } from "../types.ts";
import {
	AGENT_ABORTED,
	AGENT_ENDED,
	AGENT_ERROR,
	AGENT_INTERRUPT,
	AGENT_MESSAGE_ADDED,
	AGENT_RETRY,
	AGENT_SUBMIT,
	AGENT_TEXT_DELTA,
	AGENT_TURN_ENDED,
	AGENT_TURN_STARTED,
	PIPELINE_STARTED,
	SESSION_DISPOSED,
	SESSION_OPENED,
	SESSION_RESTORED,
	STAGE_ENDED,
	STAGE_FAILED,
	STAGE_STARTED,
	TOOL_ENDED,
	TOOL_STARTED,
	WORKER_START,
	type AgentAction,
} from "./actions.ts";

export type AgentStatus = "idle" | "running" | "error";

export type StageStatus = "pending" | "running" | "done" | "error" | "aborted";

export interface PipelineStageState extends StageDescriptor {
	status: StageStatus;
	/** 当前是第几次尝试；Reviewer 打回后 Executor 会再次执行。 */
	attempt?: number;
	/** 该阶段最后一条消息，作为下一阶段的输入。 */
	output?: string;
	error?: string;
}

export interface PipelineState {
	stages: PipelineStageState[];
	/** 正在执行的阶段下标；空闲时为 null。 */
	activeIndex: number | null;
}

export interface ToolActivity {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	durationMs?: number;
}

/** 当前绑定的 pi Session；任务是编排层概念，一个任务对应一个 Session。 */
export interface SessionState {
	taskId: string | null;
	sessionId: string | null;
	sessionFile: string | null;
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
	pipeline: PipelineState;
	session: SessionState;
}

export const initialState: AgentState = {
	status: "idle",
	messages: [],
	turn: 0,
	streamingText: "",
	tool: null,
	error: null,
	stats: { toolCalls: 0 },
	pipeline: { stages: [], activeIndex: null },
	session: { taskId: null, sessionId: null, sessionFile: null },
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
				pipeline: { stages: [], activeIndex: null },
			};

		case AGENT_TURN_STARTED:
			return { ...state, turn: state.turn + 1, streamingText: "" };

		case SESSION_OPENED:
			return {
				...state,
				session: {
					taskId: action.payload.taskId,
					sessionId: action.payload.sessionId,
					sessionFile: action.payload.sessionFile ?? null,
				},
			};

		case SESSION_RESTORED:
			// 启动重放：Session 里已有的历史整体替换本地投影，避免续跑时出现重复消息。
			return {
				...state,
				messages: action.payload.messages,
				status: "idle",
				turn: 0,
				streamingText: "",
				tool: null,
				error: null,
				stats: { toolCalls: 0 },
				pipeline: { stages: [], activeIndex: null },
			};

		case SESSION_DISPOSED:
			if (state.session.taskId !== null && state.session.taskId !== action.payload.taskId) return state;
			return { ...state, status: "idle", tool: null, session: { taskId: null, sessionId: null, sessionFile: null } };

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

		case PIPELINE_STARTED:
			return {
				...state,
				pipeline: {
					stages: action.payload.stages.map((stage) => ({ ...stage, status: "pending" as const })),
					activeIndex: null,
				},
			};

		case STAGE_STARTED:
			return {
				...state,
				turn: 0,
				streamingText: "",
				tool: null,
				pipeline: {
					...state.pipeline,
					activeIndex: action.payload.index,
					stages: state.pipeline.stages.map((stage) =>
						stage.index === action.payload.index
							? {
									...stage,
									status: "running" as const,
									attempt: action.payload.attempt ?? stage.attempt ?? 1,
								}
							: stage,
					),
				},
			};

		case STAGE_ENDED:
			return {
				...state,
				pipeline: {
					...state.pipeline,
					stages: state.pipeline.stages.map((stage) =>
						stage.index === action.payload.index
							? { ...stage, status: "done" as const, output: action.payload.output }
							: stage,
					),
				},
			};

		case STAGE_FAILED:
			return {
				...state,
				pipeline: {
					...state.pipeline,
					stages: state.pipeline.stages.map((stage) =>
						stage.index === action.payload.index
							? { ...stage, status: "error" as const, error: action.payload.error }
							: stage,
					),
				},
			};

		case AGENT_RETRY:
			return {
				...state,
				status: "running",
				error: null,
				streamingText: "",
				tool: null,
				pipeline: { stages: [], activeIndex: null },
			};

		case WORKER_START:
			return {
				...state,
				status: "running",
				turn: 0,
				streamingText: "",
				tool: null,
				error: null,
				stats: { toolCalls: 0 },
				pipeline: { stages: [], activeIndex: null },
			};

		case AGENT_ERROR:
			return { ...state, status: "error", error: action.payload.message };

		case AGENT_ENDED:
			return { ...state, status: state.status === "error" ? "error" : "idle" };

		case AGENT_ABORTED: {
			const activeIndex = state.pipeline.activeIndex;
			return {
				...state,
				status: "idle",
				error: "已取消本次任务",
				pipeline: {
					...state.pipeline,
					activeIndex: null,
					stages:
						activeIndex === null
							? state.pipeline.stages
							: state.pipeline.stages.map((stage) =>
									stage.index === activeIndex ? { ...stage, status: "aborted" as const } : stage,
								),
				},
			};
		}

		case AGENT_INTERRUPT:
			// 中断由 Saga 处理，reducer 只关心最终落到的 AGENT_ABORTED。
			return state;

		default:
			return state;
	}
}

export const selectMessages = (state: AgentState): Message[] => state.messages;
