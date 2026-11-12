/**
 * pi Session -> Redux 的投影层。
 *
 * pi Session 是会话事实源，这里只做单向映射：
 * - AgentMessage -> 内部 Message（渲染与 store 使用的精简结构）
 * - AgentSessionEvent -> Redux action（流式文本、工具过程、轮次、终止）
 *
 * 未识别的消息类型（bashExecution / custom / summary 等）与事件直接忽略，
 * 保证 pi 升级新增事件时不会打断投影。
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	agentError,
	agentMessageAdded,
	agentTextDelta,
	agentTurnEnded,
	agentTurnStarted,
	toolEnded,
	toolStarted,
	type AgentAction,
} from "../store/actions.ts";
import type { AssistantContent, AssistantMessage, Message, Usage } from "../types.ts";

/** pi 的 AgentMessage 由 provider 消息与扩展自定义消息组成，这里只取公共结构。 */
export type PiAgentMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];

/** 把 Session 中的历史消息整体投影成内部消息列表。 */
export function projectMessages(messages: readonly PiAgentMessage[]): Message[] {
	const projected: Message[] = [];
	for (const message of messages) {
		const item = projectPiMessage(message);
		if (item) projected.push(item);
	}
	return projected;
}

export function projectPiMessage(message: PiAgentMessage): Message | null {
	switch (message.role) {
		case "user":
			return projectUserMessage(message);
		case "assistant":
			return projectAssistantMessage(message);
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content
					.filter((block) => block.type === "text")
					.map((block) => ({ type: "text" as const, text: block.text })),
				isError: message.isError,
				timestamp: message.timestamp,
			};
		default:
			// system、bashExecution、custom、branchSummary 等不对应内部消息。
			return null;
	}
}

export function projectSessionEvent(event: AgentSessionEvent): AgentAction[] {
	switch (event.type) {
		case "turn_start":
			return [agentTurnStarted()];

		case "message_update":
			// 一轮 143 次 message_update 的聚合在 reducer 里完成，这里只透传文本增量。
			return event.assistantMessageEvent.type === "text_delta"
				? [agentTextDelta(event.assistantMessageEvent.delta)]
				: [];

		case "message_end": {
			// 用户消息由 SESSION_PROMPT 落库，避免同一条消息出现两次。
			if (event.message.role === "user") return [];
			const projected = projectPiMessage(event.message);
			if (!projected) return [];
			if (projected.role === "assistant") return [agentTurnEnded(projected)];
			if (projected.role === "toolResult") return [agentMessageAdded(projected)];
			return [];
		}

		case "tool_execution_start":
			return [
				toolStarted({
					type: "toolCall",
					id: event.toolCallId,
					name: event.toolName,
					arguments: asArguments(event.args),
				}),
			];

		case "tool_execution_end":
			return [
				toolEnded({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					durationMs: event.durationMs ?? 0,
				}),
			];

		case "agent_end": {
			// willRetry 表示 pi 正在自动重试，此时不能把任务标记成结束。
			if (event.willRetry) return [];
			const last = [...event.messages].reverse().find((message) => message.role === "assistant");
			const projected = last ? projectPiMessage(last) : null;
			if (projected?.role === "assistant" && projected.stopReason === "error") {
				return [agentError(projected.errorMessage ?? "模型请求失败")];
			}
			return [];
		}

		case "agent_settled":
			// 单次 prompt 的结束由编排层决定任务何时收尾，这里不直接结束整个任务。
			return [];

		default:
			return [];
	}
}

function projectUserMessage(message: Extract<PiAgentMessage, { role: "user" }>): Message {
	const blocks =
		typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: message.content;
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	const images = blocks
		.filter((block) => block.type === "image")
		.map((block) => `data:${block.mimeType};base64,${block.data}`);
	return {
		role: "user",
		content: text,
		timestamp: message.timestamp,
		...(images.length > 0 ? { images } : {}),
	};
}

function projectAssistantMessage(message: Extract<PiAgentMessage, { role: "assistant" }>): AssistantMessage {
	const content: AssistantContent[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: asArguments(block.arguments),
			});
		}
	}
	return {
		role: "assistant",
		content,
		timestamp: message.timestamp,
		stopReason: toStopReason(message.stopReason),
		...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
		...(message.usage ? { usage: toUsage(message.usage) } : {}),
	};
}

function toStopReason(reason: string): AssistantMessage["stopReason"] {
	switch (reason) {
		case "length":
			return "length";
		case "toolUse":
			return "toolUse";
		case "error":
			return "error";
		case "aborted":
			return "aborted";
		default:
			// pending / deferred / stop 在内部都视为正常结束。
			return "stop";
	}
}

function toUsage(usage: { input: number; output: number; totalTokens: number }): Usage {
	return {
		promptTokens: usage.input,
		completionTokens: usage.output,
		totalTokens: usage.totalTokens,
	};
}

function asArguments(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
