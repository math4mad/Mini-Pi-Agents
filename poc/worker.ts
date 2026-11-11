/**
 * POC 工作节点：轮询待办阶段 → 抢租约 → 假模型执行 → 版本号 CAS 提交。
 * 多进程运行，用于验证两个 worker 竞争同一阶段时只有一个能推进。
 */

import { gql, STAGES_QUERY, type StageRow } from "./client.ts";

const taskId = process.env.POC_TASK_ID;
const workerId = process.env.POC_WORKER_ID ?? "worker-?";
if (!taskId) {
	console.error("POC_TASK_ID is required");
	process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 假模型：按角色返回可校验的固定输出。 */
function fakeModel(stage: StageRow): string {
	if (stage.role === "planner") return "PLAN: 读取项目结构并输出改动点";
	if (stage.role === "executor") return "IMPL: 按计划执行并自检";
	return "REVIEW: APPROVED";
}

const deadline = Date.now() + 20_000;

while (Date.now() < deadline) {
	const { stages } = await gql<{ stages: StageRow[] }>(STAGES_QUERY, { taskId });
	if (stages.every((stage) => stage.status === "done" || stage.status === "error")) break;

	const candidates = stages.filter((stage) => stage.status !== "done" && stage.status !== "error");
	if (candidates.length === 0) {
		await sleep(50);
		continue;
	}

	for (const stage of candidates) {
		let claimed: { claimStage: StageRow };
		try {
			claimed = await gql<{ claimStage: StageRow }>(
				/* GraphQL */ `
					mutation Claim($stageId: ID!, $machineId: ID!) {
						claimStage(stageId: $stageId, machineId: $machineId, leaseMs: 2000) {
							id
							version
							role
						}
					}
				`,
				{ stageId: stage.id, machineId: workerId },
			);
		} catch {
			// 被其他 worker 持有或已结束，换下一个候选。
			continue;
		}

		// 模拟模型/工具耗时，让并发竞争真实发生。
		await sleep(80 + Math.floor(Math.random() * 120));

		try {
			await gql(
				/* GraphQL */ `
					mutation Finish($stageId: ID!, $expectedVersion: Int!, $output: String!) {
						finishStage(
							stageId: $stageId
							expectedVersion: $expectedVersion
							output: $output
							status: "done"
						) {
							id
							version
						}
					}
				`,
				{
					stageId: claimed.claimStage.id,
					expectedVersion: claimed.claimStage.version,
					output: `${workerId} | ${fakeModel(stage)}`,
				},
			);
		} catch (error) {
			// 版本冲突（被接管）时静默放弃，由新的 owner 完成。
			console.error(`${workerId} finish rejected: ${(error as Error).message}`);
		}
		break;
	}
}

const { stages } = await gql<{ stages: StageRow[] }>(STAGES_QUERY, { taskId });
const done = stages.every((stage) => stage.status === "done");
console.log(`${workerId} exit | done=${done} | stages=${stages.map((s) => s.status).join(",")}`);
process.exit(done ? 0 : 1);
