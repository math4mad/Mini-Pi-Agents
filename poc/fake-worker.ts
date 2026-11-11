/**
 * 假工作节点：不调用模型，只为验证「协调者订阅事件 → Redux 渲染」链路。
 * 真实模型节点用 `src/index.ts --worker <id>`。
 */

import { RemoteClient } from "../src/remote/graphql.ts";

const client = new RemoteClient(process.env.GRAPHQL_URL);
const machineId = process.env.WORKER_ID ?? "fake-worker";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

while (true) {
	const tasks = await client.tasks();
	const pending = tasks.filter((task) => task.status !== "done" && task.status !== "failed");
	if (process.env.EXIT_ON_IDLE === "1" && tasks.length > 0 && pending.length === 0) break;

	let worked = false;
	for (const task of pending) {
		const stages = await client.stages(task.id);
		const next = stages.find((stage) => stage.status !== "done" && stage.status !== "error");
		if (!next) continue;

		try {
			const claimed = await client.claimStage(next.id, machineId, 60_000);
			await sleep(50);
			await client.finishStage(
				next.id,
				claimed.version,
				`${machineId}:${next.role}`,
				"done",
			);
			worked = true;
			break;
		} catch {
			// 前序未完成或被抢占，下一轮重试。
		}
	}

	if (!worked) await sleep(100);
}

console.log(`${machineId} done`);
