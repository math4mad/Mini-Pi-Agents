/**
 * POC：单进程 GraphQL 协调者（内存存储）。
 *
 * 只验证多机协同需要的四个原语：
 * 任务/阶段、租约式 claim、版本号 CAS 的 finish、带 seq 的事件流订阅。
 * 不接数据库、不接真实模型。
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createSchema, createYoga } from "graphql-yoga";

type StageStatus = "pending" | "running" | "done" | "error";

interface Task {
	id: string;
	prompt: string;
	status: "pending" | "running" | "done" | "failed";
	createdAt: string;
}

interface Stage {
	id: string;
	taskId: string;
	index: number;
	role: "planner" | "executor" | "reviewer";
	attempt: number;
	status: StageStatus;
	owner: string | null;
	leaseExpiresAt: number;
	version: number;
	output: string | null;
}

interface StoredEvent {
	seq: number;
	type: string;
	payload: string;
}

const tasks = new Map<string, Task>();
const stages = new Map<string, Stage>();
const events: StoredEvent[] = [];
const listeners = new Set<(event: StoredEvent) => void>();
const idempotency = new Map<string, unknown>();
let seq = 0;

function publish(type: string, payload: Record<string, unknown>): StoredEvent {
	const event: StoredEvent = { seq: ++seq, type, payload: JSON.stringify(payload) };
	events.push(event);
	for (const listener of listeners) listener(event);
	return event;
}

function requireStage(id: string): Stage {
	const stage = stages.get(id);
	if (!stage) throw new Error(`stage ${id} not found`);
	return stage;
}

function leaseActive(stage: Stage): boolean {
	return stage.leaseExpiresAt > Date.now();
}

function settleTask(taskId: string): void {
	const task = tasks.get(taskId);
	if (!task) return;
	const owned = [...stages.values()].filter((stage) => stage.taskId === taskId);
	if (owned.some((stage) => stage.status === "error")) {
		task.status = "failed";
		publish("task.finished", { taskId, status: task.status });
		return;
	}
	if (owned.every((stage) => stage.status === "done")) {
		task.status = "done";
		publish("task.finished", { taskId, status: task.status });
	}
}

/** 事件流：先补发 since 之后的存量事件，再推送新事件。 */
function eventStream(since: number): AsyncIterable<StoredEvent> {
	const queue: StoredEvent[] = events.filter((event) => event.seq > since);
	let waiter: ((event: StoredEvent) => void) | null = null;

	const onEvent = (event: StoredEvent): void => {
		if (waiter) {
			const resolve = waiter;
			waiter = null;
			resolve(event);
			return;
		}
		queue.push(event);
	};
	listeners.add(onEvent);

	return {
		[Symbol.asyncIterator]: () => ({
			next: () => {
				const queued = queue.shift();
				if (queued) return Promise.resolve({ value: queued, done: false });
				return new Promise((resolve) => {
					waiter = (event) => resolve({ value: event, done: false });
				});
			},
			return: () => {
				listeners.delete(onEvent);
				waiter = null;
				return Promise.resolve({ value: undefined, done: true });
			},
		}),
	};
}

const schema = createSchema({
	typeDefs: /* GraphQL */ `
		type Task {
			id: ID!
			prompt: String!
			status: String!
			createdAt: String!
		}
		type Stage {
			id: ID!
			taskId: ID!
			index: Int!
			role: String!
			attempt: Int!
			status: String!
			owner: String
			leaseExpiresAt: String
			version: Int!
			output: String
		}
		type Event {
			seq: Int!
			type: String!
			payload: String!
		}
		type Query {
			task(id: ID!): Task
			stages(taskId: ID!): [Stage!]!
			events(since: Int!): [Event!]!
		}
		type Subscription {
			event(since: Int): Event!
		}
		type Mutation {
			createTask(prompt: String!, clientEventId: ID!): Task!
			claimStage(stageId: ID!, machineId: ID!, leaseMs: Int): Stage!
			finishStage(stageId: ID!, expectedVersion: Int!, output: String!, status: String): Stage!
		}
	`,
	resolvers: {
		Query: {
			task: (_parent: unknown, { id }: { id: string }) => tasks.get(id) ?? null,
			stages: (_parent: unknown, { taskId }: { taskId: string }) =>
				[...stages.values()]
					.filter((stage) => stage.taskId === taskId)
					.sort((a, b) => a.index - b.index),
			events: (_parent: unknown, { since }: { since: number }) =>
				events.filter((event) => event.seq > since),
		},
		Subscription: {
			event: {
				subscribe: (_parent: unknown, { since }: { since?: number }) => eventStream(since ?? 0),
				resolve: (event: StoredEvent) => event,
			},
		},
		Mutation: {
			createTask: (
				_parent: unknown,
				{ prompt, clientEventId }: { prompt: string; clientEventId: string },
			): Task => {
				// 幂等：同一个 clientEventId 重放时直接返回已有任务。
				const replay = idempotency.get(clientEventId);
				if (replay) return replay as Task;

				const task: Task = {
					id: randomUUID(),
					prompt,
					status: "pending",
					createdAt: new Date().toISOString(),
				};
				tasks.set(task.id, task);
				idempotency.set(clientEventId, task);

				for (const [index, role] of (["planner", "executor", "reviewer"] as const).entries()) {
					const stage: Stage = {
						id: randomUUID(),
						taskId: task.id,
						index,
						role,
						attempt: 1,
						status: "pending",
						owner: null,
						leaseExpiresAt: 0,
						version: 1,
						output: null,
					};
					stages.set(stage.id, stage);
					publish("stage.created", { taskId: task.id, stageId: stage.id, role });
				}
				publish("task.created", { taskId: task.id });
				return task;
			},
			claimStage: (
				_parent: unknown,
				{ stageId, machineId, leaseMs = 2000 }: { stageId: string; machineId: string; leaseMs?: number },
			): Stage => {
				const stage = requireStage(stageId);
				if (stage.status === "done" || stage.status === "error") {
					throw new Error("stage already finished");
				}
				if (stage.owner !== null && stage.owner !== machineId && leaseActive(stage)) {
					throw new Error(`stage is leased by ${stage.owner}`);
				}

				stage.owner = machineId;
				stage.leaseExpiresAt = Date.now() + leaseMs;
				stage.status = "running";
				stage.version += 1;
				publish("stage.claimed", {
					stageId,
					machineId,
					version: stage.version,
				});
				return stage;
			},
			finishStage: (
				_parent: unknown,
				{
					stageId,
					expectedVersion,
					output,
					status = "done",
				}: { stageId: string; expectedVersion: number; output: string; status?: StageStatus },
			): Stage => {
				const stage = requireStage(stageId);
				if (stage.status === "done") throw new Error("stage already finished");
				if (stage.version !== expectedVersion) {
					throw new Error(`version conflict: expected ${expectedVersion}, got ${stage.version}`);
				}

				stage.status = status;
				stage.output = output;
				stage.owner = null;
				stage.leaseExpiresAt = 0;
				stage.version += 1;
				publish("stage.finished", { stageId, status, version: stage.version });
				settleTask(stage.taskId);
				return stage;
			},
		},
	},
});

const port = Number(process.env.POC_PORT ?? 4123);
const yoga = createYoga({ schema, logging: false });
const server = createServer(yoga);

server.listen(port, "127.0.0.1", () => {
	// run.ts 依赖这一行判断服务端就绪。
	console.log(`READY ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}
