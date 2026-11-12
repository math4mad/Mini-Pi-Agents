/**
 * 最小化的消息 / 工具类型。
 *
 * 设计上对齐 pi 的 AgentMessage：会话记录只保存四种角色，
 * provider 在调用边界再把它们转换成 OpenAI 协议格式。
 */

/** 纯文本内容块。 */
export interface TextContent {
	type: "text";
	text: string;
}

/** 模型发起的一次工具调用。 */
export interface ToolCallContent {
	type: "toolCall";
	/** provider 返回的调用 id，用于把结果和调用配对。 */
	id: string;
	name: string;
	/** 已解析的工具参数。 */
	arguments: Record<string, unknown>;
}

export type AssistantContent = TextContent | ToolCallContent;

export interface UserMessage {
	role: "user";
	content: string;
	timestamp: number;
	/** 图片输入（data URL 或公网 URL），由 provider 转成多模态消息。 */
	images?: string[];
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	timestamp: number;
	/** 本轮结束原因；error / aborted 时循环会终止。 */
	stopReason: "stop" | "toolUse" | "length" | "error" | "aborted";
	errorMessage?: string;
	usage?: Usage;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	isError: boolean;
	timestamp: number;
	durationMs?: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/** 工具执行上下文。 */
export interface ToolContext {
	signal?: AbortSignal;
}

export interface ToolResult {
	/** 返回给模型的文本结果。 */
	content: string;
	/** 业务失败请置 true，而不是直接抛错。 */
	isError?: boolean;
}

/** 工具定义。
 * `parameters` 使用 JSON Schema 描述，直接透传给 provider。
 */
export interface AgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	/** UI / 日志用的简短名称。 */
	label: string;
	execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** 流水线中的角色。 */
export type AgentRole = "planner" | "executor" | "reviewer";

/** 一个流水线阶段的运行配置。 */
export interface StageRuntime {
	role: AgentRole;
	name: string;
	systemPrompt: string;
	tools: AgentTool[];
}

/** 阶段的静态描述，用于在 store 中提前占位。 */
export interface StageDescriptor {
	index: number;
	role: AgentRole;
	name: string;
}

/** Agent 循环对外发出的事件，后续接入 Redux/Saga 时直接消费这些事件。 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "text_delta"; text: string }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| {
			type: "tool_end";
			toolCallId: string;
			toolName: string;
			content: string;
			isError: boolean;
			durationMs: number;
	  }
	| { type: "turn_end"; message: AssistantMessage }
	| { type: "error"; message: string }
	| { type: "agent_end"; messages: Message[] };

export type AgentEventListener = (event: AgentEvent) => void;

export function isTextContent(content: AssistantContent): content is TextContent {
	return content.type === "text";
}

export function isToolCallContent(content: AssistantContent): content is ToolCallContent {
	return content.type === "toolCall";
}
