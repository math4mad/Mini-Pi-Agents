/**
 * POC 编排与验证（扮演 coordinator）：
 *   1) 并发 claim 同一阶段 → 只有一个成功
 *   2) 租约过期 → 另一台机器可接管
 *   3) 订阅断线后按 seq 补齐 → 不丢、不重
 *   4) 两个 worker 进程竞争执行三角色流水线 → 每个阶段只完成一次
 *
 * 运行：node poc/run.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "graphql-sse";
import { gql, STAGES_QUERY, type StageRow, type TaskRow } from "./client.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const failures: string[] = [];

function check(name: string, passed: boolean, detail?: unknown): void {
	if (passed) {
		console.log(`PASS  ${name}`);
		return;
	}
	failures.push(name);
	console.error(`FAIL  ${name}`, detail === undefined ? "" : detail);
}

async function createTask(prompt: string): Promise<TaskRow> {
	const { createTask: task } = await gql<{ createTask: TaskRow }>(
		/* GraphQL */ `
			mutation CreateTask($prompt: String!, $clientEventId: ID!) {
				createTask(prompt: $prompt, clientEventId: $clientEventId) {
					id
					status
				}
			}
		`,
		{ prompt, clientEventId: randomUUID() },
	);
	return task;
}

interface ClaimResult {
	ok: boolean;
	stage?: StageRow;
	error?: string;
}

async function tryClaim(stageId: string, machineId: string, leaseMs: number): Promise<ClaimResult> {
	try {
		const { claimStage } = await gql<{ claimStage: StageRow }>(
			/* GraphQL */ `
				mutation Claim($stageId: ID!, $machineId: ID!, $leaseMs: Int!) {
					claimStage(stageId: $stageId, machineId: $machineId, leaseMs: $leaseMs) {
						id
						owner
						version
						status
					}
				}
			`,
			{ stageId, machineId, leaseMs },
		);
		return { ok: true, stage: claimStage };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

async function startServer(): Promise<ChildProcess> {
	const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));
	const child = spawn(process.execPath, [serverPath], {
		env: { ...process.env, POC_PORT: "4123" },
		stdio: ["ignore", "pipe", "inherit"],
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("server did not become ready")), 10_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("READY")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`server exited early with code ${code}`));
		});
	});
	return child;
}

interface WireEvent {
	seq: number;
	type: string;
	payload: string;
}

interface SseResult {
	data?: { event: WireEvent };
}

async function collectEvents(
	iterator: AsyncIterableIterator<SseResult>,
	count: number,
	timeoutMs = 5000,
): Promise<WireEvent[]> {
	const collected: WireEvent[] = [];
	const timeout = new Promise<never>((_resolve, reject) =>
		setTimeout(() => reject(new Error("event timeout")), timeoutMs),
	);

	const pump = (async () => {
		while (collected.length < count) {
			const next = await iterator.next();
			if (next.done) break;
			const event = next.value.data?.event;
			if (!event) throw new Error(`unexpected SSE payload: ${JSON.stringify(next.value)}`);
			collected.push(event);
		}
		return collected;
	})();

	return Promise.race([pump, timeout]);
}

async function waitExit(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

async function testConcurrentClaim(): Promise<void> {
	const task = await createTask("concurrency");
	const { stages } = await gql<{ stages: StageRow[] }>(STAGES_QUERY, { taskId: task.id });
	const target = stages[0];
	if (!target) throw new Error("no stage created");

	const [first, second] = await Promise.all([
		tryClaim(target.id, "machine-A", 3000),
		tryClaim(target.id, "machine-B", 3000),
	]);
	const winners = [first, second].filter((result) => result.ok);
	check("并发 claim 只有一个成功", winners.length === 1, { first, second });

	if (winners.length === 1) {
		const { stages: after } = await gql<{ stages: StageRow[] }>(STAGES_QUERY, { taskId: task.id });
		check("失败方的 owner 未写入", after[0]?.owner === winners[0]?.stage?.owner, after[0]);
	}
}

async function testLeaseTakeover(): Promise<void> {
	const task = await createTask("lease");
	const { stages } = await gql<{ stages: StageRow[] }>(STAGES_QUERY, { taskId: task.id });
	const target = stages[0];
	if (!target) throw new Error("no stage created");

	const crasher = await tryClaim(target.id, "crasher", 200);
	const blocked = await tryClaim(target.id, "rescuer", 3000);
	check("租约内其他机器无法抢占", crasher.ok && !blocked.ok, blocked.error);

	await sleep(250);
	const takeover = await tryClaim(target.id, "rescuer", 3000);
	check("租约过期后允许接管", takeover.ok, takeover.error);
}

async function testReconnectReplay(): Promise<void> {
	const client = createClient({ url: process.env.POC_URL ?? "http://127.0.0.1:4123/graphql", retryAttempts: 0 });
	const subscription = /* GraphQL */ `
		subscription Events($since: Int) {
			event(since: $since) {
				seq
				type
				payload
			}
		}
	`;

	const firstRun = client.iterate<{ event: WireEvent }>({
		query: subscription,
		variables: { since: 0 },
	}) as AsyncIterableIterator<SseResult>;

	const head = await collectEvents(firstRun, 2);
	await firstRun.return?.();
	const lastSeq = head.at(-1)?.seq ?? 0;

	// 断线期间产生 4 条事件：3 个 stage.created + 1 个 task.created
	await createTask("reconnect");

	const secondRun = client.iterate<{ event: WireEvent }>({
		query: subscription,
		variables: { since: lastSeq },
	}) as AsyncIterableIterator<SseResult>;

	const replay = await collectEvents(secondRun, 4);
	await secondRun.return?.();

	const seqs = replay.map((event) => event.seq);
	const contiguous = seqs.every((seq, index) => seq === lastSeq + index + 1);
	check("断线重连按 seq 补齐且连续", contiguous, { lastSeq, seqs });
	check("重放无重复事件", new Set(seqs).size === seqs.length, seqs);
}

async function testPipeline(): Promise<void> {
	const task = await createTask("pipeline");
	const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url));
	const workers: ChildProcess[] = [];

	for (const workerId of ["worker-1", "worker-2"]) {
		const worker = spawn(process.execPath, [workerPath], {
			env: { ...process.env, POC_TASK_ID: task.id, POC_WORKER_ID: workerId },
			stdio: ["ignore", "pipe", "inherit"],
		});
		worker.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${workerId}] ${chunk}`));
		workers.push(worker);
	}

	try {
		const deadline = Date.now() + 25_000;
		let status = "pending";
		while (Date.now() < deadline) {
			const { task: current } = await gql<{ task: TaskRow }>(
				/* GraphQL */ `query Task($id: ID!) { task(id: $id) { id status } }`,
				{ id: task.id },
			);
			status = current.status;
			if (status === "done" || status === "failed") break;
			await sleep(150);
		}

		const codes = await Promise.all(workers.map(waitExit));
		const { stages } = await gql<{ stages: StageRow[] }>(STAGES_QUERY, { taskId: task.id });

		check("流水线完成", status === "done", { status, stages });
		check("两个 worker 都正常退出", codes.every((code) => code === 0), codes);
		check("三个阶段全部 done", stages.every((stage) => stage.status === "done"), stages);
		check(
			"输出来自 worker",
			stages.every((stage) => stage.output?.startsWith("worker-")),
			stages.map((stage) => stage.output),
		);

		const { events } = await gql<{ events: { seq: number; type: string; payload: string }[] }>(
			/* GraphQL */ `query Events($since: Int!) { events(since: $since) { seq type payload } }`,
			{ since: 0 },
		);
		const finishedCounts = new Map<string, number>();
		for (const event of events) {
			if (event.type !== "stage.finished") continue;
			const { stageId } = JSON.parse(event.payload) as { stageId: string };
			finishedCounts.set(stageId, (finishedCounts.get(stageId) ?? 0) + 1);
		}
		check(
			"每个阶段只完成一次",
			stages.every((stage) => finishedCounts.get(stage.id) === 1),
			Object.fromEntries(finishedCounts),
		);
	} finally {
		for (const worker of workers) {
			if (worker.exitCode === null) worker.kill("SIGTERM");
		}
	}
}

async function main(): Promise<void> {
	const server = await startServer();
	try {
		await testConcurrentClaim();
		await testLeaseTakeover();
		await testReconnectReplay();
		await testPipeline();
	} finally {
		server.kill("SIGTERM");
		await waitExit(server);
	}

	console.log(`\n${failures.length === 0 ? "ALL PASS" : `FAILED: ${failures.join(", ")}`}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("POC crashed:", error);
	process.exit(1);
});
