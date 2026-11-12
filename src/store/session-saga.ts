/**
 * Session 驱动的编排 Saga。
 *
 * 与旧的 `createAgentSaga` 的差别：模型循环、工具执行、会话持久化都交给 pi Session，
 * 这里只负责「阶段顺序」和「评审返工」：
 * - 一个任务对应一个 Session，三个阶段是同一 Session 里的三次 prompt
 * - 阶段指令随 prompt 注入（Session 的 system prompt 建连时已固定）
 * - reviewer 未通过时追加一条反馈 prompt 让 executor 返工
 * - 任务是否结束由本 Saga 决定，投影层不直接改状态
 */

import { call, cancel, cancelled, fork, put, take } from "redux-saga/effects";
import { buildStageInput } from "../agent/pipeline.ts";
import type { AgentRole, StageRuntime, UserMessage } from "../types.ts";
import type { SessionPromptOutcome } from "../session/adapter.ts";
import {
	AGENT_INTERRUPT,
	AGENT_RETRY,
	AGENT_SUBMIT,
	agentAborted,
	agentEnded,
	agentError,
	pipelineStarted,
	stageEnded,
	stageFailed,
	stageStarted,
	type AgentAction,
} from "./actions.ts";

/** 编排层需要的 Session 能力，测试时注入假实现。 */
export interface SessionDriver {
	prompt(text: string, images?: string[]): Promise<SessionPromptOutcome>;
	/** 切换当前阶段可用的工具；同一 Session 只能注册一套，靠这里收窄权限。 */
	setTools(toolNames: string[]): void;
	abort(): Promise<void>;
}

export interface SessionSagaOptions {
	/** 首次提交任务时创建 Session；一个任务一个 Session，后续提交复用。 */
	createDriver: (taskId: string) => Promise<SessionDriver>;
}

interface StageResult {
	output: string;
	error: string | null;
}

export function createSessionSaga(
	runtime: { stages: StageRuntime[]; maxAttempts: number },
	options: SessionSagaOptions,
) {
	return function* watchSession(): Generator<any, void, any> {
		let driver: SessionDriver | null = null;
		let running: any;
		let lastTask: UserMessage | null = null;

		while (true) {
			const action = (yield take([AGENT_SUBMIT, AGENT_INTERRUPT, AGENT_RETRY])) as AgentAction;

			if (action.type === AGENT_INTERRUPT) {
				if (driver) yield call(safeAbort, driver);
				if (running) {
					yield cancel(running);
					running = undefined;
				}
				continue;
			}

			if (action.type === AGENT_RETRY) {
				if (lastTask === null || driver === null) {
					yield put(agentError("没有可重试的任务"));
					continue;
				}
				if (running) yield cancel(running);
				running = yield fork(runPipeline, runtime, driver, lastTask);
				continue;
			}

			if (action.type !== AGENT_SUBMIT) continue;

			lastTask = action.payload.message;
			if (driver === null) {
				try {
					driver = (yield call(options.createDriver, `task-${Date.now().toString(36)}`)) as SessionDriver;
				} catch (error) {
					yield put(agentError(error instanceof Error ? error.message : String(error)));
					yield put(agentEnded());
					continue;
				}
			}
			if (running) yield cancel(running);
			running = yield fork(runPipeline, runtime, driver, lastTask);
		}
	};
}

/** 依次执行流水线；含 reviewer 时启用自动返工回路。 */
function* runPipeline(
	runtime: { stages: StageRuntime[]; maxAttempts: number },
	driver: SessionDriver,
	task: UserMessage,
): Generator<any, void, any> {
	let finished = false;
	try {
		yield put(
			pipelineStarted(runtime.stages.map((stage, index) => ({ index, role: stage.role, name: stage.name }))),
		);

		const planner = stageIndexOf(runtime.stages, "planner");
		const executor = stageIndexOf(runtime.stages, "executor");
		const reviewer = stageIndexOf(runtime.stages, "reviewer");

		// 单 Agent 或缺少 reviewer：按声明顺序各跑一次。
		if (executor === -1 || reviewer === -1) {
			let previousOutput = "";
			for (let index = 0; index < runtime.stages.length; index += 1) {
				const outcome = (yield call(
					runStagePrompt,
					driver,
					runtime.stages,
					index,
					task.content,
					previousOutput,
					1,
					index === 0 ? task.images : undefined,
				)) as StageResult;
				if (outcome.error) {
					finished = true;
					yield* terminate(outcome.error, driver);
					return;
				}
				previousOutput = outcome.output;
			}
			return;
		}

		let plan = "";
		if (planner !== -1) {
			const planned = (yield call(
				runStagePrompt,
				driver,
				runtime.stages,
				planner,
				task.content,
				"",
				1,
				task.images,
			)) as StageResult;
			if (planned.error) {
				finished = true;
				yield* terminate(planned.error, driver);
				return;
			}
			plan = planned.output;
		}

		let feedback = "";
		for (let attempt = 1; attempt <= runtime.maxAttempts; attempt += 1) {
			const implemented = (yield call(
				runStagePrompt,
				driver,
				runtime.stages,
				executor,
				task.content,
				feedback.length > 0 ? feedback : plan,
				attempt,
			)) as StageResult;
			if (implemented.error) {
				finished = true;
				yield* terminate(implemented.error, driver);
				return;
			}

			const reviewed = (yield call(
				runStagePrompt,
				driver,
				runtime.stages,
				reviewer,
				task.content,
				implemented.output,
				attempt,
			)) as StageResult;
			if (reviewed.error) {
				finished = true;
				yield* terminate(reviewed.error, driver);
				return;
			}

			if (isApproved(reviewed.output)) {
				return;
			}

			if (attempt === runtime.maxAttempts) {
				const message = `Reviewer 未通过，已重试 ${attempt} 次后停止`;
				yield put(stageFailed({ index: reviewer, error: message }));
				finished = true;
				yield* terminate(message, driver);
				return;
			}

			feedback = `Reviewer feedback to address before the next attempt:\n${reviewed.output}`;
		}
	} catch (error) {
		finished = true;
		yield put(agentError(error instanceof Error ? error.message : String(error)));
	} finally {
		const wasCancelled = (yield cancelled()) as boolean;
		if (wasCancelled) yield call(safeAbort, driver);
		if (!finished) yield put(wasCancelled ? agentAborted() : agentEnded());
	}
}

/** 终止任务：中断、错误、正常结束分别落到不同 action。 */
function* terminate(error: string, driver: SessionDriver): Generator<any, void, any> {
	const aborted = error === "已取消本次任务";
	if (aborted) {
		yield put(agentAborted());
		return;
	}
	yield put(agentError(error));
	yield put(agentEnded());
}

function* runStagePrompt(
	driver: SessionDriver,
	stages: StageRuntime[],
	index: number,
	task: string,
	previousOutput: string,
	attempt: number,
	images?: string[],
): Generator<any, StageResult, any> {
	const stage = stages[index]!;
	yield put(stageStarted({ index, role: stage.role, name: stage.name, attempt }));

	// Planner / Reviewer 只拿到只读工具，只有 Executor 能写文件。
	yield call([driver, "setTools"], stage.tools.map((tool) => tool.name));

	const outcome = (yield call([driver, "prompt"], stagePrompt(stage, task, previousOutput), images)) as
		| SessionPromptOutcome
		| undefined;

	if (!outcome || outcome.stopReason !== "stop") {
		const error =
			outcome?.errorMessage ??
			(outcome?.stopReason === "aborted" ? "已取消本次任务" : "模型请求失败，未返回结果");
		yield put(stageFailed({ index, error }));
		return { output: "", error };
	}

	yield put(stageEnded({ index, output: outcome.text }));
	return { output: outcome.text, error: null };
}

/** 阶段指令随 prompt 注入，补足同一 Session 无法切换 system prompt 的限制。 */
function stagePrompt(stage: StageRuntime, task: string, previousOutput: string): string {
	return `${stage.systemPrompt}\n\n---\n\n${buildStageInput(task, stage, previousOutput)}`;
}

async function safeAbort(driver: SessionDriver): Promise<void> {
	try {
		await driver.abort();
	} catch {
		// 中断失败不应阻塞后续流程，Session 仍可 dispose。
	}
}

/** Reviewer 的验收契约：最后给出 APPROVED 才算通过。 */
function isApproved(output: string): boolean {
	return /\bAPPROVED\b/i.test(output);
}

function stageIndexOf(stages: StageRuntime[], role: AgentRole): number {
	return stages.findIndex((stage) => stage.role === role);
}
