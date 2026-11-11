/**
 * Saga 层：所有副作用（模型请求、工具执行、中断、重试）都在这里发生。
 *
 * 多 Agent 采用单流水线：planner -> executor -> reviewer。
 * - 每个阶段拥有独立的消息上下文，阶段之间只传递上一步的最后一条消息。
 * - Reviewer 未通过时，把反馈回灌给 Executor 自动返工，最多 maxAttempts 次。
 * - 手动重试（AGENT_RETRY）重跑上一次提交的完整任务。
 */

import { END, eventChannel } from "redux-saga";
import { call, cancel, cancelled, fork, put, take } from "redux-saga/effects";
import { buildStageInput } from "../agent/pipeline.ts";
import { streamCompletion, type CompletionRequest } from "../provider/openai.ts";
import type {
	AgentRole,
	AgentTool,
	AssistantMessage,
	Message,
	StageRuntime,
	ToolCallContent,
	ToolResult,
	ToolResultMessage,
} from "../types.ts";
import { isToolCallContent } from "../types.ts";
import {
	AGENT_INTERRUPT,
	AGENT_RETRY,
	AGENT_SUBMIT,
	agentAborted,
	agentEnded,
	agentError,
	agentMessageAdded,
	agentTextDelta,
	agentTurnEnded,
	agentTurnStarted,
	pipelineStarted,
	stageEnded,
	stageFailed,
	stageStarted,
	toolEnded,
	toolStarted,
	type AgentAction,
} from "./actions.ts";

export interface AgentRuntime {
	apiKey: string;
	baseUrl: string;
	model: string;
	/** 按执行顺序排列的阶段。单 Agent 模式只有一个 executor 阶段。 */
	stages: StageRuntime[];
	/** 单个阶段允许的最大轮次。 */
	maxTurns: number;
	/** Reviewer 打回后最多重做的次数。 */
	maxAttempts: number;
	/** 可替换的模型调用，测试时注入假实现。 */
	stream?: (request: CompletionRequest) => Promise<AssistantMessage>;
}

type StreamEvent = { type: "delta"; text: string } | { type: "done"; message: AssistantMessage };

interface StageOutcome {
	output: string;
	error: string | null;
}

export function createAgentSaga(runtime: AgentRuntime) {
	return function* watchAgent(): Generator<any, void, any> {
		let runningTask: any;
		let lastTask: string | null = null;

		while (true) {
			const action = (yield take([AGENT_SUBMIT, AGENT_INTERRUPT, AGENT_RETRY])) as AgentAction;

			if (action.type === AGENT_INTERRUPT) {
				// 取消后由 runPipeline 的 finally 根据 cancelled() 落 AGENT_ABORTED。
				if (runningTask) {
					yield cancel(runningTask);
					runningTask = undefined;
				}
				continue;
			}

			if (action.type === AGENT_RETRY) {
				if (lastTask === null) {
					// reducer 已把状态置为 running，这里必须给出终止信号。
					yield put(agentError("没有可重试的任务"));
					continue;
				}
				if (runningTask) yield cancel(runningTask);
				runningTask = yield fork(runPipeline, runtime, lastTask);
				continue;
			}

			if (action.type !== AGENT_SUBMIT) continue;

			lastTask = action.payload.message.content;
			if (runningTask) yield cancel(runningTask);
			runningTask = yield fork(runPipeline, runtime, lastTask);
		}
	};
}

/** 依次执行流水线；含 reviewer 时启用自动返工回路。 */
function* runPipeline(runtime: AgentRuntime, task: string): Generator<any, void, any> {
	try {
		yield put(
			pipelineStarted(
				runtime.stages.map((stage, index) => ({ index, role: stage.role, name: stage.name })),
			),
		);

		const planner = stageIndexOf(runtime.stages, "planner");
		const executor = stageIndexOf(runtime.stages, "executor");
		const reviewer = stageIndexOf(runtime.stages, "reviewer");

		// 单 Agent 或缺少 reviewer：按声明顺序各跑一次。
		if (executor === -1 || reviewer === -1) {
			let previousOutput = "";
			for (let index = 0; index < runtime.stages.length; index += 1) {
				const outcome = (yield call(runStageFlow, runtime, index, task, previousOutput, 1)) as StageOutcome;
				if (outcome.error) {
					yield put(agentError(outcome.error));
					return;
				}
				if (outcome.output.trim().length > 0) previousOutput = outcome.output;
			}
			return;
		}

		let plan = "";
		if (planner !== -1) {
			const planned = (yield call(runStageFlow, runtime, planner, task, "", 1)) as StageOutcome;
			if (planned.error) {
				yield put(agentError(planned.error));
				return;
			}
			plan = planned.output;
		}

		let feedback = "";
		for (let attempt = 1; attempt <= runtime.maxAttempts; attempt += 1) {
			const implemented = (yield call(
				runStageFlow,
				runtime,
				executor,
				task,
				feedback.length > 0 ? feedback : plan,
				attempt,
			)) as StageOutcome;

			if (implemented.error) {
				yield put(agentError(implemented.error));
				return;
			}

			const reviewed = (yield call(
				runStageFlow,
				runtime,
				reviewer,
				task,
				implemented.output,
				attempt,
			)) as StageOutcome;

			if (reviewed.error) {
				yield put(agentError(reviewed.error));
				return;
			}

			if (isApproved(reviewed.output)) return;

			if (attempt === runtime.maxAttempts) {
				const message = `Reviewer 未通过，已重试 ${attempt} 次后停止`;
				yield put(stageFailed({ index: reviewer, error: message }));
				yield put(agentError(message));
				return;
			}

			feedback = `Reviewer feedback to address before the next attempt:\n${reviewed.output}`;
		}
	} catch (error) {
		yield put(agentError(error instanceof Error ? error.message : String(error)));
	} finally {
		const wasCancelled = (yield cancelled()) as boolean;
		yield put(wasCancelled ? agentAborted() : agentEnded());
	}
}

/** 执行单个阶段并同步阶段状态。 */
function* runStageFlow(
	runtime: AgentRuntime,
	index: number,
	task: string,
	previousOutput: string,
	attempt: number,
): Generator<any, StageOutcome, any> {
	const stage = runtime.stages[index]!;
	yield put(stageStarted({ index, role: stage.role, name: stage.name, attempt }));

	const messages: Message[] = [
		{ role: "user", content: buildStageInput(task, stage, previousOutput), timestamp: Date.now() },
	];
	const outcome = (yield call(runStage, runtime, stage, messages)) as StageOutcome;

	if (outcome.error) {
		yield put(stageFailed({ index, error: outcome.error }));
		return outcome;
	}

	yield put(stageEnded({ index, output: outcome.output }));
	return outcome;
}

/** 单个阶段的 Agent 循环：模型响应 -> 工具执行 -> 结果回灌。 */
function* runStage(
	runtime: AgentRuntime,
	stage: StageRuntime,
	messages: Message[],
): Generator<any, StageOutcome, any> {
	for (let turn = 0; turn < runtime.maxTurns; turn++) {
		yield put(agentTurnStarted());

		const assistant = (yield call(streamAssistant, runtime, stage, messages)) as AssistantMessage;
		yield put(agentTurnEnded(assistant));

		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return { output: "", error: assistant.errorMessage ?? assistant.stopReason };
		}

		messages.push(assistant);

		const toolCalls = assistant.content.filter(isToolCallContent);
		if (toolCalls.length === 0) {
			return { output: assistantText(assistant), error: null };
		}

		for (const toolCall of toolCalls) {
			yield put(toolStarted(toolCall));

			const startedAt = performance.now();
			const result = (yield call(executeTool, stage.tools, toolCall)) as ToolResult;
			const durationMs = Math.round(performance.now() - startedAt);

			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: result.content }],
				isError: result.isError === true,
				timestamp: Date.now(),
				durationMs,
			};

			messages.push(message);
			yield put(agentMessageAdded(message));
			yield put(
				toolEnded({
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					isError: message.isError,
					durationMs,
				}),
			);
		}
	}

	return { output: "", error: `已达到最大轮次上限（${runtime.maxTurns}），停止执行` };
}

/** 把流式响应包装成 channel，Saga 用 take 消费，文本增量实时 dispatch。 */
function* streamAssistant(
	runtime: AgentRuntime,
	stage: StageRuntime,
	messages: Message[],
): Generator<any, AssistantMessage, any> {
	const controller = new AbortController();
	let active = true;
	const stream = runtime.stream ?? streamCompletion;

	const channel = eventChannel<StreamEvent>((emit) => {
		stream({
			baseUrl: runtime.baseUrl,
			apiKey: runtime.apiKey,
			model: runtime.model,
			systemPrompt: stage.systemPrompt,
			messages,
			tools: stage.tools,
			signal: controller.signal,
			onTextDelta: (text) => {
				if (active) emit({ type: "delta", text });
			},
		})
			.then((message) => {
				if (active) emit({ type: "done", message });
			})
			.catch((error: unknown) => {
				if (!active) return;
				emit({
					type: "done",
					message: {
						role: "assistant",
						content: [],
						timestamp: Date.now(),
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					},
				});
			});

		return () => {
			active = false;
			controller.abort();
		};
	});

	try {
		while (true) {
			const event = (yield take(channel)) as StreamEvent;
			if ((event as unknown) === END) throw new Error("模型响应流意外结束");

			if (event.type === "delta") {
				yield put(agentTextDelta(event.text));
				continue;
			}

			return event.message;
		}
	} finally {
		channel.close();
	}
}

async function executeTool(tools: AgentTool[], toolCall: ToolCallContent): Promise<ToolResult> {
	const tool = tools.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return { content: `Tool "${toolCall.name}" not found`, isError: true };
	}

	try {
		return await tool.execute(toolCall.arguments, {});
	} catch (error) {
		return { content: error instanceof Error ? error.message : String(error), isError: true };
	}
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Reviewer 的验收契约：最后给出 APPROVED 才算通过。 */
function isApproved(output: string): boolean {
	return /\bAPPROVED\b/i.test(output);
}

function stageIndexOf(stages: StageRuntime[], role: AgentRole): number {
	return stages.findIndex((stage) => stage.role === role);
}
