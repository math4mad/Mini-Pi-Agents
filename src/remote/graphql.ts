/**
 * 远端协调者的极简 GraphQL 客户端。
 *
 * 只用 fetch 做查询/变更，用 graphql-sse 订阅事件；
 * 不引入 Apollo，避免和 Redux 形成第二个状态源。
 */

import { randomUUID } from "node:crypto";
import { createClient } from "graphql-sse";

export interface RemoteTask {
	id: string;
	prompt: string;
	status: string;
	createdAt: string;
}

export interface RemoteStage {
	id: string;
	taskId: string;
	index: number;
	role: string;
	attempt: number;
	status: string;
	owner: string | null;
	version: number;
	output: string | null;
}

export interface RemoteEvent {
	seq: number;
	type: string;
	payload: Record<string, unknown>;
}

export function remoteUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env.GRAPHQL_URL ?? "http://127.0.0.1:4123/graphql";
}

const TASK_FIELDS = `id prompt status createdAt`;
const STAGE_FIELDS = `id taskId index role attempt status owner version output`;

interface GraphQLResponse<T> {
	data?: T;
	errors?: { message: string }[];
}

interface SseResult<T> {
	data?: T;
	errors?: { message: string }[];
}

export class RemoteClient {
	private readonly url: string;

	constructor(url: string = remoteUrl()) {
		this.url = url;
	}

	async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
		const response = await fetch(this.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query, variables }),
		});
		const payload = (await response.json()) as GraphQLResponse<T>;
		if (payload.errors?.length) {
			throw new Error(payload.errors.map((error) => error.message).join("; "));
		}
		return payload.data as T;
	}

	async lastSeq(): Promise<number> {
		const data = await this.gql<{ lastSeq: number }>(`query { lastSeq }`);
		return data.lastSeq;
	}

	async createTask(prompt: string): Promise<RemoteTask> {
		const data = await this.gql<{ createTask: RemoteTask }>(
			/* GraphQL */ `
				mutation CreateTask($prompt: String!, $clientEventId: ID!) {
					createTask(prompt: $prompt, clientEventId: $clientEventId) {
						${TASK_FIELDS}
					}
				}
			`,
			{ prompt, clientEventId: randomUUID() },
		);
		return data.createTask;
	}

	async task(id: string): Promise<RemoteTask | null> {
		const data = await this.gql<{ task: RemoteTask | null }>(
			/* GraphQL */ `
				query Task($id: ID!) {
					task(id: $id) {
						${TASK_FIELDS}
					}
				}
			`,
			{ id },
		);
		return data.task;
	}

	async tasks(): Promise<RemoteTask[]> {
		const data = await this.gql<{ tasks: RemoteTask[] }>(
			/* GraphQL */ `
				query {
					tasks {
						${TASK_FIELDS}
					}
				}
			`,
		);
		return data.tasks;
	}

	async stages(taskId: string): Promise<RemoteStage[]> {
		const data = await this.gql<{ stages: RemoteStage[] }>(
			/* GraphQL */ `
				query Stages($taskId: ID!) {
					stages(taskId: $taskId) {
						${STAGE_FIELDS}
					}
				}
			`,
			{ taskId },
		);
		return data.stages;
	}

	async stage(id: string): Promise<RemoteStage | null> {
		const data = await this.gql<{ stage: RemoteStage | null }>(
			/* GraphQL */ `
				query Stage($id: ID!) {
					stage(id: $id) {
						${STAGE_FIELDS}
					}
				}
			`,
			{ id },
		);
		return data.stage;
	}

	async claimStage(stageId: string, machineId: string, leaseMs: number): Promise<RemoteStage> {
		const data = await this.gql<{ claimStage: RemoteStage }>(
			/* GraphQL */ `
				mutation Claim($stageId: ID!, $machineId: ID!, $leaseMs: Int!) {
					claimStage(stageId: $stageId, machineId: $machineId, leaseMs: $leaseMs) {
						${STAGE_FIELDS}
					}
				}
			`,
			{ stageId, machineId, leaseMs },
		);
		return data.claimStage;
	}

	async finishStage(
		stageId: string,
		expectedVersion: number,
		output: string,
		status: "done" | "error",
	): Promise<RemoteStage> {
		const data = await this.gql<{ finishStage: RemoteStage }>(
			/* GraphQL */ `
				mutation Finish(
					$stageId: ID!
					$expectedVersion: Int!
					$output: String!
					$status: String!
				) {
					finishStage(
						stageId: $stageId
						expectedVersion: $expectedVersion
						output: $output
						status: $status
					) {
						${STAGE_FIELDS}
					}
				}
			`,
			{ stageId, expectedVersion, output, status },
		);
		return data.finishStage;
	}

	/** 订阅事件流；signal 中止时连同底层 fetch 一起取消。 */
	async *subscribe(since: number, signal?: AbortSignal): AsyncGenerator<RemoteEvent> {
		// 每次订阅独立建连，并把 signal 合并进 fetch：
		// graphql-sse 自己也会通过 init.signal 中止连接，直接覆盖会导致 dispose 失效、进程无法退出。
		const sse = createClient({
			url: this.url,
			retryAttempts: 0,
			fetchFn: (
				input: Parameters<typeof fetch>[0],
				init?: Parameters<typeof fetch>[1],
			) => {
				const inner = init?.signal;
				return fetch(input, {
					...init,
					signal: inner && signal ? AbortSignal.any([inner, signal]) : (inner ?? signal),
				});
			},
		});

		const iterator = sse.iterate<{ event: { seq: number; type: string; payload: string } }>({
			query: /* GraphQL */ `
				subscription Events($since: Int) {
					event(since: $since) {
						seq
						type
						payload
					}
				}
			`,
			variables: { since },
		}) as AsyncIterableIterator<SseResult<{ event: { seq: number; type: string; payload: string } }>>;

		try {
			for await (const result of iterator) {
				if (result.errors?.length) {
					throw new Error(result.errors.map((error) => error.message).join("; "));
				}
				const event = result.data?.event;
				if (!event) continue;
				yield {
					seq: event.seq,
					type: event.type,
					payload: JSON.parse(event.payload) as Record<string, unknown>,
				};
			}
		} finally {
			sse.dispose();
		}
	}

	/** 关闭 SSE 连接；否则长连接会让 Node 进程无法自然退出。 */
	dispose(): void {
		// 连接按订阅创建并在 subscribe 的 finally 中释放，这里保留空实现以兼容调用方。
	}
}
