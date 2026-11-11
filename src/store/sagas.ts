/**
 * Saga 层：所有副作用（模型请求、工具执行、中断）都在这里发生。
 * 每个副作用的结果都通过 put(action) 回到 reducer，CLI 只订阅 store。
 */

import { END, eventChannel } from "redux-saga";
import { call, cancel, cancelled, fork, put, select, take } from "redux-saga/effects";
import { streamCompletion } from "../provider/openai.ts";
import type {
	AgentTool,
	AssistantMessage,
	Message,
	ToolCallContent,
	ToolResult,
	ToolResultMessage,
} from "../types.ts";
import { isToolCallContent } from "../types.ts";
import {
	AGENT_INTERRUPT,
	AGENT_SUBMIT,
	agentAborted,
	agentEnded,
	agentError,
	agentMessageAdded,
	agentTextDelta,
	agentTurnEnded,
	agentTurnStarted,
	toolEnded,
	toolStarted,
	type AgentAction,
} from "./actions.ts";
import { selectMessages } from "./reducer.ts";

export interface AgentRuntime {
	apiKey: string;
	baseUrl: string;
	model: string;
	systemPrompt: string;
	tools: AgentTool[];
	maxTurns: number;
}

type StreamEvent = { type: "delta"; text: string } | { type: "done"; message: AssistantMessage };

export function createAgentSaga(runtime: AgentRuntime) {
	return function* watchAgent(): Generator<any, void, any> {
		let runningTask: any;

		while (true) {
			const action = (yield take([AGENT_SUBMIT, AGENT_INTERRUPT])) as AgentAction;

			if (action.type === AGENT_INTERRUPT) {
				// 取消任务后由 runAgent 的 finally 根据 cancelled() 落 AGENT_ABORTED。
				if (runningTask) {
					yield cancel(runningTask);
					runningTask = undefined;
				}
				continue;
			}

			if (runningTask) yield cancel(runningTask);
			runningTask = yield fork(runAgent, runtime);
		}
	};
}

/** 一次用户输入触发的完整 Agent 循环。 */
function* runAgent(runtime: AgentRuntime): Generator<any, void, any> {
	try {
		for (let turn = 0; turn < runtime.maxTurns; turn++) {
			yield put(agentTurnStarted());

			const messages = (yield select(selectMessages)) as Message[];
			const assistant = (yield call(streamAssistant, runtime, messages)) as AssistantMessage;
			yield put(agentTurnEnded(assistant));

			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
				yield put(agentError(assistant.errorMessage ?? assistant.stopReason));
				return;
			}

			const toolCalls = assistant.content.filter(isToolCallContent);
			if (toolCalls.length === 0) return;

			for (const toolCall of toolCalls) {
				yield put(toolStarted(toolCall));

				const startedAt = performance.now();
				const result = (yield call(executeTool, runtime.tools, toolCall)) as ToolResult;
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

		yield put(agentError(`已达到最大轮次上限（${runtime.maxTurns}），停止执行`));
	} catch (error) {
		yield put(agentError(error instanceof Error ? error.message : String(error)));
	} finally {
		const wasCancelled = (yield cancelled()) as boolean;
		yield put(wasCancelled ? agentAborted() : agentEnded());
	}
}

/** 把流式响应包装成 channel，Saga 用 take 消费，文本增量实时 dispatch。 */
function* streamAssistant(runtime: AgentRuntime, messages: Message[]): Generator<any, AssistantMessage, any> {
	const controller = new AbortController();
	let active = true;

	const channel = eventChannel<StreamEvent>((emit) => {
		streamCompletion({
			baseUrl: runtime.baseUrl,
			apiKey: runtime.apiKey,
			model: runtime.model,
			systemPrompt: runtime.systemPrompt,
			messages,
			tools: runtime.tools,
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
