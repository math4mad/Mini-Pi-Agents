/**
 * 最小 OpenAI 兼容流式客户端（当前用于 OpenRouter）。
 *
 * 职责：
 * - 把内部 Message[] 转成 OpenAI chat/completions 协议
 * - 解析 SSE，拼接文本增量和 tool_call 参数
 * - 不抛异常：任何失败都以 stopReason "error"/"aborted" 的 AssistantMessage 返回
 */

import type { AgentTool, AssistantContent, AssistantMessage, Message, Usage } from "../types.ts";

export interface CompletionRequest {
	baseUrl: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	messages: Message[];
	tools: AgentTool[];
	signal?: AbortSignal;
	/** 文本增量回调，用于终端实时输出。 */
	onTextDelta?: (text: string) => void;
}

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

type OpenAITextPart = { type: "text"; text: string };
type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };

type OpenAIMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | Array<OpenAITextPart | OpenAIImagePart> }
	| { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCallDelta {
	index: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
	choices?: Array<{
		delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	} | null;
	error?: string | { message?: string };
}

interface StreamState {
	text: string;
	toolCalls: Map<number, { id: string; name: string; argumentsJson: string }>;
	usage?: Usage;
	finishReason: string;
}

export async function streamCompletion(request: CompletionRequest): Promise<AssistantMessage> {
	const body = {
		model: request.model,
		messages: toOpenAIMessages(request),
		stream: true,
		stream_options: { include_usage: true },
		...(request.tools.length > 0
			? {
					tools: request.tools.map((tool) => ({
						type: "function" as const,
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						},
					})),
					tool_choice: "auto" as const,
				}
			: {}),
	};

	let response: Response;
	try {
		response = await fetch(`${request.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${request.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: request.signal,
		});
	} catch (error) {
		return failedMessage(error, request.signal);
	}

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		const suffix = detail ? `: ${detail.slice(0, 2000)}` : "";
		return failedMessage(new Error(`HTTP ${response.status} ${response.statusText}${suffix}`), request.signal);
	}

	if (!response.body) {
		return failedMessage(new Error("响应体为空，无法读取流式数据"), request.signal);
	}

	const state: StreamState = {
		text: "",
		toolCalls: new Map(),
		finishReason: "",
	};

	try {
		await readSseStream(response.body, (chunk) => applyChunk(chunk, state, request.onTextDelta));
	} catch (error) {
		return failedMessage(error, request.signal);
	}

	const content: AssistantContent[] = [];
	if (state.text.length > 0) {
		content.push({ type: "text", text: state.text });
	}

	for (const [index, call] of [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
		content.push({
			type: "toolCall",
			id: call.id || `call_${index}`,
			name: call.name,
			arguments: parseArguments(call.argumentsJson),
		});
	}

	const hasToolCalls = state.toolCalls.size > 0;
	const stopReason =
		state.finishReason === "length" ? "length" : hasToolCalls ? "toolUse" : "stop";

	if (content.length === 0) {
		return {
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			stopReason: "error",
			errorMessage: "模型返回了空响应",
		};
	}

	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		stopReason,
		...(state.usage ? { usage: state.usage } : {}),
	};
}

function toOpenAIMessages(request: CompletionRequest): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [{ role: "system", content: request.systemPrompt }];

	for (const message of request.messages) {
		switch (message.role) {
			case "user":
				// 有图片时改用多模态 content 数组，文本放在图片前更利于模型理解任务。
				if (message.images && message.images.length > 0) {
					messages.push({
						role: "user",
						content: [
							{ type: "text", text: message.content },
							...message.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
						],
					});
				} else {
					messages.push({ role: "user", content: message.content });
				}
				break;

			case "assistant": {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				const toolCalls = message.content
					.filter((part) => part.type === "toolCall")
					.map((part) => ({
						id: part.id,
						type: "function" as const,
						function: {
							name: part.name,
							arguments: JSON.stringify(part.arguments),
						},
					}));

				messages.push({
					role: "assistant",
					content: text.length > 0 ? text : null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				});
				break;
			}

			case "toolResult":
				messages.push({
					role: "tool",
					tool_call_id: message.toolCallId,
					content: message.content.map((part) => part.text).join("\n"),
				});
				break;
		}
	}

	return messages;
}

function applyChunk(chunk: OpenAIChunk, state: StreamState, onTextDelta?: (text: string) => void): void {
	if (chunk.error) {
		const message = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "provider error");
		throw new Error(message);
	}

	if (chunk.usage) {
		state.usage = {
			promptTokens: chunk.usage.prompt_tokens ?? 0,
			completionTokens: chunk.usage.completion_tokens ?? 0,
			totalTokens: chunk.usage.total_tokens ?? 0,
		};
	}

	const choice = chunk.choices?.[0];
	if (!choice) return;

	const text = choice.delta?.content;
	if (text) {
		state.text += text;
		onTextDelta?.(text);
	}

	for (const delta of choice.delta?.tool_calls ?? []) {
		const existing = state.toolCalls.get(delta.index) ?? { id: "", name: "", argumentsJson: "" };
		if (delta.id) existing.id = delta.id;
		if (delta.function?.name) existing.name = delta.function.name;
		if (delta.function?.arguments) existing.argumentsJson += delta.function.arguments;
		state.toolCalls.set(delta.index, existing);
	}

	if (choice.finish_reason) {
		state.finishReason = choice.finish_reason;
	}
}

/** 逐块读取 SSE，事件之间以空行分隔。 */
async function readSseStream(
	body: ReadableStream<Uint8Array>,
	onChunk: (chunk: OpenAIChunk) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			let separator = /\r?\n\r?\n/.exec(buffer);
			while (separator) {
				const rawEvent = buffer.slice(0, separator.index);
				buffer = buffer.slice(separator.index + separator[0].length);
				dispatchSseEvent(rawEvent, onChunk);
				separator = /\r?\n\r?\n/.exec(buffer);
			}
		}

		if (buffer.trim().length > 0) {
			dispatchSseEvent(buffer, onChunk);
		}
	} finally {
		reader.releaseLock();
	}
}

function dispatchSseEvent(rawEvent: string, onChunk: (chunk: OpenAIChunk) => void): void {
	for (const line of rawEvent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;

		const data = trimmed.slice("data:".length).trim();
		if (data.length === 0 || data === "[DONE]") continue;

		try {
			onChunk(JSON.parse(data) as OpenAIChunk);
		} catch (error) {
			// JSON 解析失败通常是被中断的半行数据；provider 的真实错误会走 error 字段。
			if (error instanceof SyntaxError) continue;
			throw error;
		}
	}
}

function parseArguments(raw: string): Record<string, unknown> {
	if (raw.trim().length === 0) return {};

	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// 参数被截断时返回空对象，让工具层以参数校验错误的形式反馈给模型。
	}

	return {};
}

function failedMessage(error: unknown, signal: AbortSignal | undefined): AssistantMessage {
	const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted ? "已取消本次请求" : error instanceof Error ? error.message : String(error),
	};
}
