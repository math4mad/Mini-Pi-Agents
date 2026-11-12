/**
 * 单流水线多 Agent：planner -> executor -> reviewer。
 *
 * 每个阶段有独立的系统提示词、工具集合和消息上下文；
 * 阶段之间只通过「上一阶段的最后一条消息」传递信息。
 */

import { createFileTools } from "../tools/file-tools.ts";
import type { Sandbox } from "../tools/sandbox.ts";
import { createShellTool } from "../tools/shell-tool.ts";
import type { StageRuntime } from "../types.ts";
import { buildStageSystemPrompt, buildSystemPrompt } from "./prompt.ts";

/** 单 Agent 模式：一个 executor 阶段，保持原有行为。 */
export function createSingleStage(cwd: string, sandbox: Sandbox): StageRuntime {
	return {
		role: "executor",
		name: "Agent",
		systemPrompt: buildSystemPrompt(cwd),
		tools: [...createFileTools(sandbox), createShellTool(sandbox)],
	};
}

export function createPipeline(cwd: string, sandbox: Sandbox): StageRuntime[] {
	const fileTools = createFileTools(sandbox);
	const shellTool = createShellTool(sandbox);
	// 只有 executor 能写文件，planner / reviewer 保持只读。
	const readOnlyTools = fileTools.filter((tool) => tool.name !== "write_file");

	return [
		{
			role: "planner",
			name: "Planner",
			systemPrompt: buildStageSystemPrompt("planner", cwd),
			tools: readOnlyTools,
		},
		{
			role: "executor",
			name: "Executor",
			systemPrompt: buildStageSystemPrompt("executor", cwd),
			tools: [...fileTools, shellTool],
		},
		{
			role: "reviewer",
			name: "Reviewer",
			systemPrompt: buildStageSystemPrompt("reviewer", cwd),
			tools: [...readOnlyTools, shellTool],
		},
	];
}

/** 构造某个阶段的用户输入：首阶段只有任务本身，后续阶段附带上一阶段输出。 */
export function buildStageInput(task: string, stage: StageRuntime, previousOutput: string): string {
	if (stage.role === "planner" || previousOutput.trim().length === 0) {
		return `Task:\n${task}`;
	}

	return `Original task:\n${task}\n\nResult from the previous stage:\n${previousOutput}\n\nProceed with your stage.`;
}
