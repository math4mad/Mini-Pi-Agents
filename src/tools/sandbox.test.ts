/** 沙箱测试：路径边界用 host backend 覆盖；容器隔离为可选集成用例。 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile as readHostFile, symlink, writeFile as writeHostFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSandbox, resolveInside, type Sandbox } from "./sandbox.ts";

/** docker 可用且镜像存在时才跑集成用例。 */
function dockerReady(image: string): boolean {
	const result = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
	return result.status === 0;
}

describe("resolveInside", () => {
	const root = resolve("/tmp/sandbox-root");

	test("接受工作目录内的相对路径", () => {
		assert.equal(resolveInside(root, "data/a.csv").relative, "data/a.csv");
	});

	test("接受工作目录内的绝对路径", () => {
		assert.equal(resolveInside(root, "/tmp/sandbox-root/data/a.csv").relative, "data/a.csv");
	});

	test("拒绝 .. 越界", () => {
		assert.throws(() => resolveInside(root, "../outside.txt"), /越界/);
	});

	test("拒绝工作目录外的绝对路径", () => {
		assert.throws(() => resolveInside(root, "/etc/passwd"), /越界/);
	});
});

describe("HostSandbox", () => {
	let root: string;
	let sandbox: Sandbox;

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "mini-pi-host-"));
		sandbox = createSandbox({ mode: "host", root });
	});

	after(async () => {
		await sandbox.dispose();
	});

	test("写入、读取、列目录", async () => {
		await sandbox.writeFile("data/a.csv", "x,y\n1,2\n");
		assert.equal(await sandbox.readFile("data/a.csv"), "x,y\n1,2\n");
		assert.deepEqual(await sandbox.listDir("data"), [{ name: "a.csv", isDirectory: false }]);
	});

	test("拒绝写到工作目录之外", async () => {
		await assert.rejects(() => sandbox.writeFile("../escape.txt", "x"), /越界/);
	});

	test("执行命令并返回退出码", async () => {
		const ok = await sandbox.exec("echo hello", { timeoutMs: 10_000 });
		assert.equal(ok.code, 0);
		assert.equal(ok.stdout.trim(), "hello");

		const failed = await sandbox.exec("exit 3", { timeoutMs: 10_000 });
		assert.equal(failed.code, 3);
	});

	test("拒绝经由符号链接读目录外的文件", async () => {
		const outside = await mkdtemp(join(tmpdir(), "mini-pi-outside-"));
		const secret = join(outside, "secret.txt");
		await writeHostFile(secret, "top-secret", "utf8");
		await symlink(secret, join(root, "data/link"));

		await assert.rejects(() => sandbox.readFile("data/link"), /越界/);
	});

	test("超时会终止命令", async () => {
		const result = await sandbox.exec("sleep 5", { timeoutMs: 300 });
		assert.equal(result.timedOut, true);
	});
});

const IMAGE = process.env.SANDBOX_IMAGE ?? "mini-pi-sandbox:node";
const hasImage = dockerReady(IMAGE);

describe("DockerSandbox（集成，需要 docker 与镜像）", { skip: !hasImage }, () => {
	let root: string;
	let sandbox: Sandbox;

	before(async () => {
		root = await mkdtemp(join(tmpdir(), "mini-pi-docker-"));
		await mkdir(join(root, "data"), { recursive: true });
		sandbox = createSandbox({ mode: "docker", root, image: IMAGE });
	});

	after(async () => {
		await sandbox.dispose();
	});

	test("容器内读写映射到工作目录", async () => {
		await sandbox.writeFile("data/out.csv", "a,b\n1,2\n");
		assert.equal(await sandbox.readFile("data/out.csv"), "a,b\n1,2\n");
		// 宿主侧可见同一份文件（volume 挂载）。
		assert.equal(await readHostFile(join(root, "data/out.csv"), "utf8"), "a,b\n1,2\n");
	});

	test("根文件系统只读，写 /etc 被拒绝", async () => {
		const result = await sandbox.exec("echo x > /etc/mini-pi-test", { timeoutMs: 10_000 });
		assert.notEqual(result.code, 0);
	});

	test("默认无网络", async () => {
		const result = await sandbox.exec("wget -T 1 -q -O /dev/null https://example.com", { timeoutMs: 10_000 });
		assert.notEqual(result.code, 0);
	});

	test("容器内的 PID 1 是 sleep，不是宿主进程", async () => {
		const result = await sandbox.exec("cat /proc/1/cmdline", { timeoutMs: 10_000 });
		assert.equal(result.code, 0);
		assert.match(result.stdout, /sleep/);
	});

	test("超时终止", async () => {
		const result = await sandbox.exec("sleep 10", { timeoutMs: 300 });
		assert.equal(result.timedOut, true);
	});
});

describe("DockerSandbox 启动失败", () => {
	test("镜像不存在时报错而不是降级到宿主", async () => {
		const root = await mkdtemp(join(tmpdir(), "mini-pi-missing-"));
		await writeHostFile(join(root, "keep.txt"), "x", "utf8");
		const sandbox = createSandbox({ mode: "docker", root, image: "mini-pi-sandbox:definitely-missing" });
		await assert.rejects(() => sandbox.exec("echo hi", { timeoutMs: 10_000 }), /沙箱容器启动失败/);
		await sandbox.dispose();
	});
});
