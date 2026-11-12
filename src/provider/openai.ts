/**
 * OpenAI 兼容的模型调用层，传输由 pi-ai 负责（当前用于 OpenRouter）。
 *
 * 职责：
 * - 保持对内的 `CompletionRequest` / `AssistantMessage` 契约不变
 * - 把内部 Message[] 转成 pi-ai 的 Context / Model
 * - 消费 pi-ai 的流式事件，把文本增量回调给上层（TUI / Saga）
 * - 不抛异常：任何失败都以 stopReason "error"/"aborted" 的 AssistantMessage 返回
 */

import type {
	AssistantMessage as PiAssistantMessage,
	ImageContent,
	JsonObject,
	Message as PiMessage,
	Model,
	Tool as PiTool,
	Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type {
	AgentTool,
	AssistantContent,
	AssistantMessage,
	Message,
	Usage,
} from "../types.ts";

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

export async function streamCompletion(request: CompletionRequest): Promise<AssistantMessage> {
	let stream: ReturnType<typeof streamSimple>;
	try {
		const model = toPiModel(request);
		stream = streamSimple(model, normalizeContext(toPiContext(request, model)), {
			apiKey: request.apiKey,
			signal: request.signal,
			maxRetries: 2,
		});
	} catch (error) {
		// pi-ai 在缺少鉴权等请求前置条件时会同步抛错。
		return failedMessage(error, request.signal);
	}

	try {
		for await (const event of stream) {
			if (event.type === "text_delta") request.onTextDelta?.(event.delta);
		}
	} catch (error) {
		return failedMessage(error, request.signal);
	}

	let final: PiAssistantMessage;
	try {
		final = await stream.result();
	} catch (error) {
		return failedMessage(error, request.signal);
	}

	const aborted =
		final.stopReason === "aborted" ||
		(final.stopReason === "error" && request.signal?.aborted === true);
	if (final.stopReason === "error" || aborted) {
		return {
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			stopReason: aborted ? "aborted" : "error",
			errorMessage: final.errorMessage ?? (aborted ? "已取消本次请求" : "模型请求失败"),
		};
	}

	const content = toAssistantContent(final);
	if (content.length === 0) {
		return {
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			stopReason: "error",
			errorMessage: "模型返回了空响应",
		};
	}

	const hasToolCalls = content.some((block) => block.type === "toolCall");
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		stopReason: hasToolCalls ? "toolUse" : final.stopReason === "length" ? "length" : "stop",
		...(final.usage ? { usage: toUsage(final.usage) } : {}),
	};
}

function toPiModel(request: CompletionRequest): Model<"openai-completions"> {
	return {
		id: request.model,
		name: request.model,
		api: "openai-completions",
		// provider 只影响兼容性探测与 OpenRouter 头信息，按 baseUrl 推断即可。
		provider: request.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai-compatible",
		baseUrl: request.baseUrl.replace(/\/+$/, ""),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function toPiContext(request: CompletionRequest, model: Model<"openai-completions">) {
	const tools: PiTool[] = request.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return {
		systemPrompt: request.systemPrompt,
		messages: request.messages.map((message) => toPiMessage(message, model)),
		tools,
	};
}

function toPiMessage(message: Message, model: Model<"openai-completions">): PiMessage {
	switch (message.role) {
		case "user": {
			if (!message.images || message.images.length === 0) {
				return { role: "user", content: message.content, timestamp: message.timestamp };
			}
			return {
				role: "user",
				content: [
					{ type: "text", text: message.content },
					...message.images.map(toImageContent),
				],
				timestamp: message.timestamp,
			};
		}

		case "assistant":
			return {
				role: "assistant",
				content: message.content.map(
					(block): PiAssistantMessage["content"][number] =>
						block.type === "text"
							? { type: "text", text: block.text }
							: {
									type: "toolCall",
									id: block.id,
									name: block.name,
									// 内部参数来自 JSON.parse，运行时必然是 JSON 对象。
									arguments: block.arguments as unknown as JsonObject,
								},
				),
				api: "openai-completions",
				provider: model.provider,
				model: model.id,
				usage: zeroUsage(),
				stopReason: message.stopReason,
				timestamp: message.timestamp,
			};

		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				isError: message.isError,
				timestamp: message.timestamp,
			};
	}
}

/** 内部图片统一是 data URL（见 index.ts 的 toDataUrl），pi-ai 需要 base64 + mimeType。 */
function toImageContent(url: string): ImageContent {
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
	if (!match) throw new Error("图片仅支持 base64 data URL");
	return { type: "image", data: match[2]!, mimeType: match[1]! };
}

function toAssistantContent(message: PiAssistantMessage): AssistantContent[] {
	const content: AssistantContent[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: { ...block.arguments } as Record<string, unknown>,
			});
		}
		// thinking 等其它内容块不下发给 Agent 循环。
	}
	return content;
}

function toUsage(usage: PiUsage): Usage {
	return {
		promptTokens: usage.input,
		completionTokens: usage.output,
		totalTokens: usage.totalTokens,
	};
}

function zeroUsage(): PiUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
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
