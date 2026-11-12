/**
 * pi Session 适配器。
 *
 * 一个任务对应一个 Session：Session 文件是会话事实源，Redux 只保留投影结果。
 * 适配器负责：
 * - 生成模型配置并创建 / 打开 pi Session
 * - 订阅 Session 事件并投影成 Redux action
 * - 启动重放（把已有历史灌回 store）
 * - dispose 时解除订阅并释放 Session
 * - 维护 taskId ↔ sessionId 的映射
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { sessionDisposed, sessionOpened, sessionRestored, type AgentAction } from "../store/actions.ts";
import type { AgentTool } from "../types.ts";
import { projectMessages, projectSessionEvent } from "./projection.ts";

/** 自定义 provider 名，避免与 pi 内置目录合并，也避免覆盖用户的 models.json。 */
const PROVIDER_ID = "mini-pi";
/** apiKey 通过进程环境变量传入，不落盘。 */
const API_KEY_ENV = "MINI_PI_API_KEY";

export interface SessionAdapterOptions {
	/** Agent 的工作目录，Session 文件也写在这里的 .mini-pi/sessions 下。 */
	cwd: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	/** 编排层的任务 id；单机模式下可由调用方生成。 */
	taskId: string;
	dispatch: (action: AgentAction) => void;
	/** 全局配置目录，默认 <cwd>/.mini-pi/agent。 */
	agentDir?: string;
	/** 会话文件目录，默认 <cwd>/.mini-pi/sessions。 */
	sessionsDir?: string;
	/** 传入已有 Session 文件则续跑，否则新建。 */
	sessionFile?: string;
	/** 注册给模型的工具；为空时不启用任何工具。 */
	tools?: AgentTool[];
	/** 单次 prompt 的最长等待时间，默认 10 分钟。 */
	promptTimeoutMs?: number;
}

export interface SessionPromptOutcome {
	text: string;
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
}

export interface SessionAdapter {
	taskId: string;
	sessionId: string;
	sessionFile: string | undefined;
	prompt(text: string, images?: string[]): Promise<SessionPromptOutcome>;
	/**
	 * 只启用指定工具。Session 只注册一套工具，阶段切换时用这个闸门限制权限，
	 * 例如 planner / reviewer 只读、executor 可写。改动在下一次 turn 生效。
	 */
	setTools(toolNames: string[]): void;
	abort(): Promise<void>;
	dispose(): void;
}

export async function openSessionAdapter(options: SessionAdapterOptions): Promise<SessionAdapter> {
	if (options.apiKey.length === 0) throw new Error("缺少 API Key，无法创建 Session");

	const agentDir = options.agentDir ?? join(options.cwd, ".mini-pi", "agent");
	const sessionsDir = options.sessionsDir ?? join(options.cwd, ".mini-pi", "sessions");

	ensureAgentConfig(agentDir, options);
	process.env[API_KEY_ENV] = options.apiKey;

	const sessionManager = options.sessionFile
		? SessionManager.open(options.sessionFile, sessionsDir, options.cwd)
		: SessionManager.create(options.cwd, sessionsDir);

	const customTools = toPiTools(options.tools ?? []);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		model: createModel(options),
		// 只启用显式注册的工具；没有工具时连内置工具一起关闭，避免 Session 直接操作宿主机。
		...(customTools.length > 0
			? { customTools, tools: customTools.map((tool) => tool.name) }
			: { noTools: "all" as const }),
		sessionManager,
	});

	const attachment = attachSession(session, options.taskId, options.dispatch);
	attachment.hydrate();

	return {
		taskId: options.taskId,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		async prompt(text, images) {
			const settled = attachment.waitForSettled(options.promptTimeoutMs);
			try {
				await session.prompt(text, {
					expandPromptTemplates: false,
					...(images && images.length > 0 ? { images: images.map(toImageContent) } : {}),
				});
				await settled;
			} catch (error) {
				return {
					text: "",
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
				};
			}
			return outcomeOf(session);
		},
		setTools(toolNames) {
			session.setActiveToolsByName(toolNames);
		},
		async abort() {
			await session.abort();
		},
		dispose() {
			attachment.unsubscribe();
			session.dispose();
			options.dispatch(sessionDisposed(options.taskId));
		},
	};
}

/** 纯桥接：订阅事件 + 启动重放，便于用假的 Session 做单测。 */
export function attachSession(
	session: Pick<AgentSession, "subscribe" | "sessionId" | "sessionFile" | "messages">,
	taskId: string,
	dispatch: (action: AgentAction) => void,
): { unsubscribe: () => void; hydrate: () => void; waitForSettled: (timeoutMs?: number) => Promise<void> } {
	let waiters: Array<() => void> = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		for (const action of projectSessionEvent(event)) dispatch(action);
		if (event.type !== "agent_settled") return;
		const pending = waiters;
		waiters = [];
		for (const resolve of pending) resolve();
	});

	return {
		unsubscribe,
		hydrate() {
			dispatch(
				sessionOpened({
					taskId,
					sessionId: session.sessionId,
					...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
				}),
			);
			dispatch(sessionRestored(projectMessages(session.messages)));
		},
		waitForSettled(timeoutMs = 600_000) {
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("等待 Session 结束超时")), timeoutMs);
				waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
}

/** taskId ↔ sessionId 双向索引，供编排层与远端租约查询。 */
export class SessionRegistry {
	private readonly byTask = new Map<string, SessionAdapter>();
	private readonly taskBySession = new Map<string, string>();

	register(adapter: SessionAdapter): void {
		this.byTask.set(adapter.taskId, adapter);
		this.taskBySession.set(adapter.sessionId, adapter.taskId);
	}

	get(taskId: string): SessionAdapter | undefined {
		return this.byTask.get(taskId);
	}

	taskIdOf(sessionId: string): string | undefined {
		return this.taskBySession.get(sessionId);
	}

	dispose(taskId: string): void {
		const adapter = this.byTask.get(taskId);
		if (!adapter) return;
		this.byTask.delete(taskId);
		this.taskBySession.delete(adapter.sessionId);
		adapter.dispose();
	}

	disposeAll(): void {
		for (const taskId of [...this.byTask.keys()]) this.dispose(taskId);
	}
}

function ensureAgentConfig(agentDir: string, options: SessionAdapterOptions): void {
	mkdirSync(agentDir, { recursive: true });
	const path = join(agentDir, "models.json");
	const existing = readJson(path);
	const providers =
		existing && typeof existing.providers === "object" && existing.providers !== null
			? (existing.providers as Record<string, unknown>)
			: {};

	// 只维护自己这一项，保留用户已有的 provider 配置。
	providers[PROVIDER_ID] = {
		api: "openai-completions",
		apiKey: `$${API_KEY_ENV}`,
		baseUrl: options.baseUrl.replace(/\/+$/, ""),
		models: [{ id: options.model, name: options.model }],
	};
	writeFileSync(path, JSON.stringify({ ...existing, providers }, null, 2));
}

function readJson(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		// 配置损坏时直接重建，避免启动被历史文件卡住。
		return null;
	}
}

function createModel(options: SessionAdapterOptions): Model<"openai-completions"> {
	return {
		id: options.model,
		name: options.model,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: options.baseUrl.replace(/\/+$/, ""),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

/** 把内部 AgentTool 包装成 pi 工具，执行仍然走原来的沙箱实现。 */
function toPiTools(tools: AgentTool[]): ToolDefinition[] {
	return tools.map((tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		// 内部参数就是 JSON Schema，运行时校验直接用。
		parameters: tool.parameters as never,
		async execute(_toolCallId, params, signal) {
			const result = await tool.execute(params as Record<string, unknown>, { signal });
			return {
				content: [{ type: "text", text: result.content }],
				details: undefined,
				...(result.isError ? { isError: true } : {}),
			};
		},
	}));
}

/** 从 Session 最后一条 assistant 消息推断本轮结果。 */
function outcomeOf(session: Pick<AgentSession, "messages">): SessionPromptOutcome {
	const last = [...session.messages].reverse().find((message) => message.role === "assistant");
	if (!last || last.role !== "assistant") {
		return { text: "", stopReason: "error", errorMessage: "模型未返回消息" };
	}
	const text = last.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	if (last.stopReason === "error" || last.stopReason === "aborted") {
		return {
			text: "",
			stopReason: last.stopReason,
			errorMessage: last.errorMessage ?? (last.stopReason === "aborted" ? "已取消本次任务" : "模型请求失败"),
		};
	}
	return { text, stopReason: "stop" };
}

/** 内部图片统一是 base64 data URL，pi 需要拆分出 data 与 mimeType。 */
function toImageContent(url: string): { type: "image"; data: string; mimeType: string } {
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
	if (!match) throw new Error("图片仅支持 base64 data URL");
	return { type: "image", data: match[2]!, mimeType: match[1]! };
}
