/** 所有状态变更都从这里发出，CLI 与 Saga 只 dispatch action。 */

import type { AssistantMessage, Message, ToolCallContent, UserMessage } from "../types.ts";

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

export const agentSubmit = (input: string) =>
	({
		type: AGENT_SUBMIT,
		payload: { message: { role: "user", content: input, timestamp: Date.now() } satisfies UserMessage },
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
	| ReturnType<typeof agentAborted>;
