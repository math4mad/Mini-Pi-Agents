/** 所有状态变更都从这里发出，CLI 与 Saga 只 dispatch action。 */

import type { AssistantMessage, Message, StageDescriptor, ToolCallContent, UserMessage } from "../types.ts";

export const AGENT_SUBMIT = "agent/submit";
export const AGENT_TURN_STARTED = "agent/turnStarted";
export const AGENT_TEXT_DELTA = "agent/textDelta";
export const AGENT_TURN_ENDED = "agent/turnEnded";
export const AGENT_MESSAGE_ADDED = "agent/messageAdded";
export const TOOL_STARTED = "agent/toolStarted";
export const TOOL_ENDED = "agent/toolEnded";
export const AGENT_ERROR = "agent/error";
export const AGENT_ENDED = "agent/ended";
export const AGENT_INTERRUPT = "agent/interrupt";
export const AGENT_ABORTED = "agent/aborted";
/** 手动重试：重跑上一次提交的完整任务。 */
export const AGENT_RETRY = "agent/retry";

/** 工作节点启动：开始从远端协调者领取阶段。 */
export const WORKER_START = "worker/start";

/** 流水线生命周期：阶段列表在提交时占位，Saga 逐个推进。 */
export const PIPELINE_STARTED = "pipeline/started";
export const STAGE_STARTED = "pipeline/stageStarted";
export const STAGE_ENDED = "pipeline/stageEnded";
export const STAGE_FAILED = "pipeline/stageFailed";

export const agentSubmit = (input: string, images?: string[]) =>
	({
		type: AGENT_SUBMIT,
		payload: {
			message: {
				role: "user",
				content: input,
				timestamp: Date.now(),
				...(images && images.length > 0 ? { images } : {}),
			} satisfies UserMessage,
		},
	}) as const;

export const agentTurnStarted = () => ({ type: AGENT_TURN_STARTED }) as const;

export const agentTextDelta = (text: string) => ({ type: AGENT_TEXT_DELTA, payload: { text } }) as const;

export const agentTurnEnded = (message: AssistantMessage) =>
	({ type: AGENT_TURN_ENDED, payload: { message } }) as const;

export const agentMessageAdded = (message: Message) => ({ type: AGENT_MESSAGE_ADDED, payload: { message } }) as const;

export const toolStarted = (toolCall: ToolCallContent) =>
	({
		type: TOOL_STARTED,
		payload: { toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments },
	}) as const;

export const toolEnded = (result: {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	durationMs: number;
}) => ({ type: TOOL_ENDED, payload: result }) as const;

export const agentError = (message: string) => ({ type: AGENT_ERROR, payload: { message } }) as const;

export const agentEnded = () => ({ type: AGENT_ENDED }) as const;

export const agentInterrupt = () => ({ type: AGENT_INTERRUPT }) as const;

export const agentAborted = () => ({ type: AGENT_ABORTED }) as const;

export const agentRetry = () => ({ type: AGENT_RETRY }) as const;

export const workerStart = () => ({ type: WORKER_START }) as const;

export const pipelineStarted = (stages: StageDescriptor[]) => ({ type: PIPELINE_STARTED, payload: { stages } }) as const;

export const stageStarted = (stage: StageDescriptor & { attempt?: number }) =>
	({ type: STAGE_STARTED, payload: stage }) as const;

export const stageEnded = (payload: { index: number; output: string }) =>
	({ type: STAGE_ENDED, payload }) as const;

export const stageFailed = (payload: { index: number; error: string }) =>
	({ type: STAGE_FAILED, payload }) as const;

export type AgentAction =
	| ReturnType<typeof agentSubmit>
	| ReturnType<typeof agentTurnStarted>
	| ReturnType<typeof agentTextDelta>
	| ReturnType<typeof agentTurnEnded>
	| ReturnType<typeof agentMessageAdded>
	| ReturnType<typeof toolStarted>
	| ReturnType<typeof toolEnded>
	| ReturnType<typeof agentError>
	| ReturnType<typeof agentEnded>
	| ReturnType<typeof agentInterrupt>
	| ReturnType<typeof agentAborted>
	| ReturnType<typeof agentRetry>
	| ReturnType<typeof workerStart>
	| ReturnType<typeof pipelineStarted>
	| ReturnType<typeof stageStarted>
	| ReturnType<typeof stageEnded>
	| ReturnType<typeof stageFailed>;
