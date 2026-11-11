/** 终端渲染：完全由 store 状态驱动，不直接接触 Agent/Saga。 */

import { stdout } from "node:process";
import type { AgentStore } from "../store/index.ts";
import type { AgentState, ToolActivity } from "../store/reducer.ts";

export function attachRenderer(store: AgentStore): () => void {
	let renderedTurn = 0;
	let printedChars = 0;
	let lastToolId: string | null = null;
	let lastToolStatus: ToolActivity["status"] | null = null;
	let printedError = false;
	let wasRunning = false;
	let renderedStage: string | null = null;

	const render = (state: AgentState): void => {
		// 阶段切换（含返工重试）：打印分隔条，避免多 Agent 输出混在一起。
		const activeIndex = state.pipeline.activeIndex;
		if (activeIndex === null) {
			renderedStage = null;
		} else {
			const stage = state.pipeline.stages[activeIndex];
			const attempt = stage?.attempt ?? 1;
			const stageKey = `${activeIndex}:${attempt}`;
			if (stageKey !== renderedStage) {
				if (printedChars > 0) {
					stdout.write("\n");
					printedChars = 0;
				}
				// 单 Agent 模式只有一个阶段，不需要分隔条。
				if (stage && state.pipeline.stages.length > 1) {
					const retry = attempt > 1 ? ` · retry ${attempt}` : "";
					stdout.write(
						`\n\x1b[36m── [${activeIndex + 1}/${state.pipeline.stages.length}] ${stage.name}${retry} ──\x1b[0m\n`,
					);
				}
				renderedStage = stageKey;
			}
		}

		// 新的一轮：先给上一段文本收尾。
		if (state.turn !== renderedTurn) {
			if (printedChars > 0) {
				stdout.write("\n");
				printedChars = 0;
			}
			renderedTurn = state.turn;
		}

		if (state.streamingText.length > printedChars) {
			stdout.write(state.streamingText.slice(printedChars));
			printedChars = state.streamingText.length;
		}

		const tool = state.tool;
		if (tool) {
			if (tool.id !== lastToolId) {
				if (printedChars > 0) {
					stdout.write("\n");
					printedChars = 0;
				}
				stdout.write(`\x1b[2m→ ${tool.name}(${formatArgs(tool.args)})\x1b[0m\n`);
				lastToolId = tool.id;
				lastToolStatus = tool.status;
			} else if (tool.status !== lastToolStatus) {
				printToolResult(tool);
				lastToolStatus = tool.status;
			}
		}

		if (state.error && !printedError) {
			if (printedChars > 0) {
				stdout.write("\n");
				printedChars = 0;
			}
			stdout.write(`\x1b[31m[error] ${state.error}\x1b[0m\n`);
			printedError = true;
		}

		if (!state.error) {
			printedError = false;
		}

		const running = state.status === "running";
		if (wasRunning && !running && printedChars > 0) {
			stdout.write("\n");
			printedChars = 0;
		}
		wasRunning = running;
	};

	render(store.getState());
	return store.subscribe(() => render(store.getState()));
}

function printToolResult(tool: ToolActivity): void {
	const mark = tool.status === "error" ? "✗" : "✓";
	stdout.write(`\x1b[2m${mark} ${tool.name} ${tool.durationMs ?? 0}ms\x1b[0m\n`);
}

function formatArgs(args: Record<string, unknown>): string {
	const json = JSON.stringify(args).replace(/\s+/g, " ");
	return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}
