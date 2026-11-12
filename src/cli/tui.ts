/**
 * 基于 pi-tui 的交互界面。
 *
 * 与行式渲染器一样，它只订阅 store：读状态、渲染、把用户输入 dispatch 回去，
 * 不直接接触 Saga / Provider / 工具。
 */

import {
	Editor,
	Key,
	Markdown,
	ProcessTerminal,
	Text,
	TuiMainScreen,
	matchesKey,
	truncateToWidth,
	type Component,
	type EditorTheme,
	type MarkdownTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import type { Message } from "../types.ts";
import { agentInterrupt, agentRetry, agentSubmit } from "../store/actions.ts";
import type { AgentState } from "../store/reducer.ts";
import type { AgentStore } from "../store/index.ts";
import { pingProvider } from "../provider/ping.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

const editorTheme: EditorTheme = {
	borderColor: dim,
	selectList: {
		selectedPrefix: cyan,
		selectedText: cyan,
		description: dim,
		scrollInfo: dim,
		noMatch: dim,
	},
};

const markdownTheme: MarkdownTheme = {
	heading: bold,
	link: cyan,
	linkUrl: dim,
	code: yellow,
	codeBlock: (text) => text,
	codeBlockBorder: dim,
	quote: dim,
	quoteBorder: dim,
	hr: dim,
	listBullet: cyan,
	bold,
	italic: dim,
	strikethrough: dim,
	underline: (text) => `\x1b[4m${text}\x1b[0m`,
};

/** 单个工具结果最多展示的字符数，避免把长输出整段刷进屏幕。 */
const MAX_TOOL_OUTPUT_CHARS = 1200;

export interface TuiOptions {
	model: string;
	baseUrl: string;
	apiKey: string;
	cwd: string;
}

/** 挂载 TUI；返回的 Promise 在用户退出时 resolve。 */
export function attachTui(store: AgentStore, options: TuiOptions): Promise<void> {
	return new TuiView(store, options).run();
}

/** 单行状态栏：TruncatedText 不支持更新，这里用最小组件替代。 */
class StatusLine implements Component {
	private text = "";

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [truncateToWidth(this.text, width)];
	}
}

class TuiView {
	private readonly tui: TUI;
	private readonly editor: Editor;
	private readonly statusLine = new StatusLine();
	/** 已经渲染进 tui 的 assistant 流式片段。 */
	private stream: Markdown | null = null;
	/** 已消费的消息数量，用于增量渲染。 */
	private renderedMessages = 0;
	private lastStatus: AgentState["status"] = "idle";
	private lastStatusText = "";
	private renderedStage: string | null = null;
	/** /ping 进行中：避免重复触发同一探测。 */
	private pinging = false;
	private finish?: () => void;
	private unsubscribe?: () => void;

	private readonly store: AgentStore;
	private readonly options: TuiOptions;

	constructor(store: AgentStore, options: TuiOptions) {
		this.store = store;
		this.options = options;
		this.tui = new TuiMainScreen(new ProcessTerminal());
		this.editor = new Editor(this.tui, editorTheme);

		this.tui.addChild(new Text(`${bold("Mini Pi Agents")} ${dim(`· ${options.model}`)}\n${dim(`cwd: ${options.cwd}`)}`));
		this.tui.addChild(new Text(dim("/status 查看配置 · /ping 测试 provider · /exit 退出")));
		this.tui.addChild(this.editor);
		this.tui.addChild(this.statusLine);
	}

	run(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.finish = resolve;

			this.editor.onSubmit = (value: string) => {
				const input = value.trim();
				if (input.length === 0) return;
				if (input === "exit" || input === "quit" || input === "/exit") {
					this.quit();
					return;
				}
				if (input === "/status") {
					this.showStatus();
					return;
				}
				if (input === "/ping") {
					void this.ping();
					return;
				}
				if (this.store.getState().status === "running") return;
				if (input === "retry") {
					this.store.dispatch(agentRetry());
					return;
				}
				this.store.dispatch(agentSubmit(input));
			};

			// raw mode 下 Ctrl+C 不会触发 SIGINT，需要自己接管。
			this.tui.addInputListener((data) => {
				if (!matchesKey(data, Key.ctrl("c"))) return;
				if (this.store.getState().status === "running") {
					this.store.dispatch(agentInterrupt());
				} else {
					this.quit();
				}
				return { consume: true };
			});

			this.unsubscribe = this.store.subscribe(() => this.sync());
			this.tui.setFocus(this.editor);
			this.tui.start();
			this.sync();
		});
	}

	private quit(): void {
		this.unsubscribe?.();
		this.tui.stop();
		this.finish?.();
	}

	/** /status：只读当前配置，不触发任何请求；key 只露头尾。 */
	private showStatus(): void {
		const { model, baseUrl, apiKey, cwd } = this.options;
		const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "已配置";
		const lines = [
			bold("配置"),
			`model:   ${model}`,
			`baseUrl: ${baseUrl}`,
			`apiKey:  ${maskedKey}`,
			`cwd:     ${cwd}`,
		];
		this.insertBeforeEditor(new Text(lines.join("\n"), 1, 0));
		this.tui.requestRender();
	}

	/** /ping：发一次 1 token 的请求，验证 key、baseUrl 与模型名。 */
	private async ping(): Promise<void> {
		if (this.pinging) return;
		this.pinging = true;

		const pending = new Text(dim(`⏳ 连接 ${this.options.baseUrl} …`), 1, 0);
		this.insertBeforeEditor(pending);
		this.tui.requestRender();

		const result = await pingProvider(this.options);
		pending.setText(
			result.ok
				? green(`✓ provider 可用 · ${result.ms}ms · ${result.detail}`)
				: red(`✖ provider 不可用 · ${result.ms}ms · ${result.detail}`),
		);

		this.pinging = false;
		this.tui.requestRender();
	}

	/** 把 store 状态增量投影到组件树。 */
	private sync(): void {
		const state = this.store.getState();
		let dirty = false;

		for (; this.renderedMessages < state.messages.length; this.renderedMessages += 1) {
			dirty = this.renderMessage(state.messages[this.renderedMessages]!) || dirty;
		}

		if (state.streamingText.length > 0) {
			if (!this.stream) {
				this.stream = new Markdown("", 1, 1, markdownTheme);
				this.insertBeforeEditor(this.stream);
				dirty = true;
			}
			this.stream.setText(state.streamingText);
			dirty = true;
		}

		const activeIndex = state.pipeline.activeIndex;
		if (activeIndex === null) {
			this.renderedStage = null;
		} else {
			const stage = state.pipeline.stages[activeIndex];
			const attempt = stage?.attempt ?? 1;
			const stageKey = `${activeIndex}:${attempt}`;
			if (stageKey !== this.renderedStage) {
				if (stage && state.pipeline.stages.length > 1) {
					const retry = attempt > 1 ? ` · retry ${attempt}` : "";
					this.insertBeforeEditor(
						new Text(
							cyan(`── [${activeIndex + 1}/${state.pipeline.stages.length}] ${stage.name}${retry} ──`),
							1,
							1,
						),
					);
					dirty = true;
				}
				this.renderedStage = stageKey;
			}
		}

		if (state.status !== this.lastStatus || state.error) {
			this.lastStatus = state.status;
			dirty = true;
		}

		const nextStatus = this.describe(state);
		if (this.lastStatusText !== nextStatus) {
			this.lastStatusText = nextStatus;
			this.statusLine.setText(nextStatus);
			dirty = true;
		}

		if (dirty) this.tui.requestRender();
	}

	private renderMessage(message: Message): boolean {
		if (message.role === "user") {
			this.insertBeforeEditor(new Text(`${cyan("❯")} ${message.content}`, 1, 0));
			return true;
		}

		if (message.role === "assistant") {
			// 流式阶段已经渲染过正文，这里只负责收尾，避免重复输出。
			if (this.stream) {
				const text = message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
				if (text.length > 0) this.stream.setText(text);
				this.stream = null;
			}
			if (message.stopReason === "error" && message.errorMessage) {
				this.insertBeforeEditor(new Text(red(`✖ ${message.errorMessage}`), 1, 0));
			}
			return true;
		}

		const icon = message.isError ? red("✖") : green("✓");
		const duration = message.durationMs ? dim(` ${message.durationMs}ms`) : "";
		const output = truncate(message.content.map((block) => block.text).join(""), MAX_TOOL_OUTPUT_CHARS);
		this.insertBeforeEditor(new Text(`${icon} ${bold(message.toolName)}${duration}\n${dim(output)}`, 1, 0));
		return true;
	}

	private insertBeforeEditor(component: Component): void {
		const index = this.tui.children.indexOf(this.editor);
		this.tui.children.splice(index === -1 ? this.tui.children.length : index, 0, component);
	}

	private describe(state: AgentState): string {
		if (state.error) return red(`● error · ${state.error}`);

		if (state.status === "running") {
			const stage = state.pipeline.stages[state.pipeline.activeIndex ?? -1];
			const retry = stage && (stage.attempt ?? 1) > 1 ? ` · retry ${stage.attempt}` : "";
			const stageLabel = stage ? `${stage.name}${retry} · ` : "";
			const tool = state.tool ? ` · ${state.tool.name}(${summarizeArgs(state.tool.args)})` : "";
			return `${yellow("●")} running · ${stageLabel}turn ${state.turn}${tool} · ${state.stats.toolCalls} tools`;
		}

		return `${dim("●")} idle · turn ${state.turn} · ${state.stats.toolCalls} tools`;
	}
}

function summarizeArgs(args: Record<string, unknown>): string {
	const json = JSON.stringify(args);
	if (json === undefined) return "";
	return json.length > 60 ? `${json.slice(0, 57)}...` : json.slice(1, -1);
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}
