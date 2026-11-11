/**
 * 远端协同 Saga：
 * - 协调者模式（--remote）：提交任务到 GraphQL，订阅事件并映射成现有 action。
 * - 工作节点模式（--worker）：领取阶段，在本机跑真实模型与工具，再提交结果。
 *
 * 两种模式都只通过 action 更新 store，渲染层无需感知网络。
 */

import { END, buffers, eventChannel } from "redux-saga";
import { call, cancel, cancelled, delay, fork, put, take } from "redux-saga/effects";
import { buildStageInput } from "../agent/pipeline.ts";
import {
	RemoteClient,
	remoteUrl,
	type RemoteEvent,
	type RemoteStage,
	type RemoteTask,
} from "../remote/graphql.ts";
import type { AgentRole, Message, StageDescriptor } from "../types.ts";
import {
	AGENT_INTERRUPT,
	AGENT_RETRY,
	AGENT_SUBMIT,
	WORKER_START,
	agentAborted,
	agentEnded,
	agentError,
	agentTextDelta,
	agentTurnEnded,
	agentTurnStarted,
	pipelineStarted,
	stageEnded,
	stageFailed,
	stageStarted,
	type AgentAction,
} from "./actions.ts";
import { runStage, type AgentRuntime, type StageOutcome } from "./sagas.ts";

export interface RemoteOptions {
	url?: string;
}

export interface WorkerOptions extends RemoteOptions {
	machineId: string;
	/** 一次租约的时长；真实模型调用较慢，默认 10 分钟。 */
	leaseMs?: number;
	pollMs?: number;
	/** 所有任务都完成后退出（用于单次验证）。 */
	exitOnIdle?: boolean;
}

const STREAM_ERROR = "stream.error";

function roleName(role: string): string {
	if (role === "planner") return "Planner";
	if (role === "executor") return "Executor";
	if (role === "reviewer") return "Reviewer";
	return role;
}

function descriptorsOf(stages: RemoteStage[]): StageDescriptor[] {
	return stages.map((stage) => ({
		index: stage.index,
		role: stage.role as AgentRole,
		name: roleName(stage.role),
	}));
}

/** 协调者：提交任务并消费远端事件；中断只取消本地订阅，远端任务继续执行。 */
export function createRemoteSaga(runtime: AgentRuntime, options: RemoteOptions = {}) {
	const url = options.url ?? remoteUrl();

	return function* watchRemote(): Generator<any, void, any> {
		let runningTask: any;
		let lastPrompt: string | null = null;

		while (true) {
			const action = (yield take([AGENT_SUBMIT, AGENT_INTERRUPT, AGENT_RETRY])) as AgentAction;

			if (action.type === AGENT_INTERRUPT) {
				if (runningTask) {
					yield cancel(runningTask);
					runningTask = undefined;
				}
				continue;
			}

			const prompt: string | null =
				action.type === AGENT_SUBMIT
					? action.payload.message.content
					: lastPrompt;

			if (prompt === null || prompt === undefined) {
				yield put(agentError("没有可重试的任务"));
				continue;
			}

			lastPrompt = prompt;
			if (runningTask) yield cancel(runningTask);
			runningTask = yield fork(runRemoteTask, runtime, url, prompt);
		}
	};
}

function* runRemoteTask(
	runtime: AgentRuntime,
	url: string,
	prompt: string,
): Generator<any, void, any> {
	const client = new RemoteClient(url);
	const controller = new AbortController();
	let channel: any = null;

	try {
		// 先记下当前事件序号，再创建任务：订阅时从这里补齐，避免遗漏创建事件。
		const since: number = yield call([client, client.lastSeq]);
		const task: RemoteTask = yield call([client, client.createTask], prompt);
		const stages: RemoteStage[] = yield call([client, client.stages], task.id);

		yield put(pipelineStarted(descriptorsOf(stages)));
		const byId = new Map(stages.map((stage) => [stage.id, stage]));

		// 默认固定缓冲会把订阅刚建立时的回放事件挤掉，这里用可扩展缓冲避免丢事件。
		channel = eventChannel<RemoteEvent>((emit) => {
			void (async () => {
				try {
					for await (const event of client.subscribe(since, controller.signal)) {
						emit(event);
					}
				} catch (error) {
					if (!controller.signal.aborted) {
						emit({
							seq: -1,
							type: STREAM_ERROR,
							payload: { message: error instanceof Error ? error.message : String(error) },
						});
					}
				} finally {
					emit(END);
				}
			})();

			return () => controller.abort();
		}, buffers.expanding());

		while (true) {
			const event = (yield take(channel)) as RemoteEvent;

			if ((event as unknown) === END) {
				yield put(agentError("远端事件流意外结束"));
				return;
			}
			if (event.type === STREAM_ERROR) {
				yield put(agentError(String(event.payload.message ?? "订阅失败")));
				return;
			}
			// 其他任务的事件直接忽略。
			if (event.payload.taskId !== task.id) continue;

			if (event.type === "stage.claimed") {
				const stage = byId.get(String(event.payload.stageId));
				if (!stage) continue;
				yield put(
					stageStarted({
						index: stage.index,
						role: stage.role as AgentRole,
						name: roleName(stage.role),
						attempt: stage.attempt,
					}),
				);
				continue;
			}

			if (event.type === "stage.finished") {
				const stageId = String(event.payload.stageId);
				const stage = byId.get(stageId);
				if (!stage) continue;

				const remote: RemoteStage | null = yield call([client, client.stage], stageId);
				if (!remote) continue;

				if (remote.status === "done") {
					const output = remote.output ?? "";
					yield put(stageEnded({ index: stage.index, output }));
					// 复用一轮模型消息的语义，让行式渲染器与 TUI 都能显示阶段产物。
					if (output.trim().length > 0) {
						yield put(agentTurnStarted());
						yield put(agentTextDelta(output));
						yield put(
							agentTurnEnded({
								role: "assistant",
								content: [{ type: "text", text: output }],
								timestamp: Date.now(),
								stopReason: "stop",
							}),
						);
					}
				} else {
					yield put(stageFailed({ index: stage.index, error: remote.output ?? "阶段失败" }));
				}
				continue;
			}

			if (event.type === "task.finished") {
				const status = String(event.payload.status);
				if (status !== "done") yield put(agentError(`远端任务失败：${status}`));
				return;
			}
		}
	} catch (error) {
		yield put(agentError(error instanceof Error ? error.message : String(error)));
	} finally {
		controller.abort();
		client.dispose();
		if (channel) channel.close();
		const wasCancelled = (yield cancelled()) as boolean;
		yield put(wasCancelled ? agentAborted() : agentEnded());
	}
}

/** 工作节点：轮询任务 -> 按阶段顺序抢租约 -> 本机执行 -> CAS 提交。 */
export function createWorkerSaga(runtime: AgentRuntime, options: WorkerOptions) {
	const url = options.url ?? remoteUrl();
	const leaseMs = options.leaseMs ?? 10 * 60_000;
	const pollMs = options.pollMs ?? 300;

	return function* watchWorker(): Generator<any, void, any> {
		yield take(WORKER_START);

		const client = new RemoteClient(url);
		const byRole = new Map(runtime.stages.map((stage) => [stage.role, stage]));
		// 每个任务只初始化一次流水线；重复 dispatch 会把已完成阶段重置为 pending。
		const announced = new Set<string>();

		try {
			while (true) {
				const tasks: RemoteTask[] = yield call([client, client.tasks]);
				const pending = tasks.filter(
					(task) => task.status !== "done" && task.status !== "failed",
				);

				if (pending.length === 0) {
					if (options.exitOnIdle && tasks.length > 0) return;
					yield delay(pollMs);
					continue;
				}

				let worked = false;
				for (const task of pending) {
					const stages: RemoteStage[] = yield call([client, client.stages], task.id);
					const next = stages.find(
						(stage) => stage.status !== "done" && stage.status !== "error",
					);
					if (!next) continue;

					let claimed: RemoteStage;
					try {
						claimed = (yield call(
							[client, client.claimStage],
							next.id,
							options.machineId,
							leaseMs,
						)) as RemoteStage;
					} catch {
						// 前序未完成或其他机器持有租约，稍后重试。
						continue;
					}
					worked = true;

					if (!announced.has(task.id)) {
						announced.add(task.id);
						yield put(pipelineStarted(descriptorsOf(stages)));
					}

					const stageRuntime = byRole.get(next.role as AgentRole);
					if (!stageRuntime) {
						const message = `工作节点不支持阶段角色：${next.role}`;
						yield put(stageFailed({ index: next.index, error: message }));
						yield call([client, client.finishStage], next.id, claimed.version, message, "error");
						break;
					}

					const previous = stages.find((stage) => stage.index === next.index - 1)?.output ?? "";
					yield put(
						stageStarted({
							index: next.index,
							role: stageRuntime.role,
							name: stageRuntime.name,
							attempt: next.attempt,
						}),
					);

					const messages: Message[] = [
						{
							role: "user",
							content: buildStageInput(task.prompt, stageRuntime, previous),
							timestamp: Date.now(),
						},
					];
					const outcome = (yield call(runStage, runtime, stageRuntime, messages)) as StageOutcome;

					if (outcome.error) {
						yield put(stageFailed({ index: next.index, error: outcome.error }));
						yield call(
							[client, client.finishStage],
							next.id,
							claimed.version,
							outcome.error,
							"error",
						);
					} else {
						yield call(
							[client, client.finishStage],
							next.id,
							claimed.version,
							outcome.output,
							"done",
						);
						yield put(stageEnded({ index: next.index, output: outcome.output }));
					}
					break;
				}

				if (!worked) yield delay(pollMs);
			}
		} catch (error) {
			yield put(agentError(error instanceof Error ? error.message : String(error)));
		} finally {
			const wasCancelled = (yield cancelled()) as boolean;
			yield put(wasCancelled ? agentAborted() : agentEnded());
		}
	};
}
