/**
 * 执行沙箱：把命令与文件访问限制在任务工作目录内。
 *
 * 两种 backend：
 * - host：与改造前行为一致，仅用于开发与测试；仍做路径越界校验
 * - docker：命令在容器内执行，工作目录以 volume 挂入，默认无网络、限内存/CPU/进程数
 *
 * 设计说明见 docs/sandbox-design.md。
 */

import { exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** 与 shell-tool / file-tools 共享的执行结果结构。 */
export interface SandboxResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export interface SandboxEntry {
	name: string;
	isDirectory: boolean;
}

export interface ExecOptions {
	/** 相对于工作目录的子目录。 */
	cwd?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface Sandbox {
	readonly mode: "host" | "docker";
	readonly root: string;
	exec(command: string, options: ExecOptions): Promise<SandboxResult>;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	listDir(path: string): Promise<SandboxEntry[]>;
	dispose(): Promise<void>;
}

export interface SandboxOptions {
	mode?: "host" | "docker";
	/** 宿主工作目录，容器内固定挂到 /workspace。 */
	root?: string;
	image?: string;
	network?: "none" | "egress";
	memoryMb?: number;
	cpus?: number;
	pidsLimit?: number;
}

const CONTAINER_WORKSPACE = "/workspace";
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024;

/** 根据配置创建沙箱；未指定 mode 时默认 docker（失败即报错，不静默降级）。 */
export function createSandbox(options: SandboxOptions = {}): Sandbox {
	const root = resolve(options.root ?? process.cwd());
	const mode = options.mode ?? "docker";

	if (mode === "host") return new HostSandbox(root);
	return new DockerSandbox(root, {
		image: options.image ?? "mini-pi-sandbox:node",
		network: options.network ?? "none",
		memoryMb: options.memoryMb ?? 1024,
		cpus: options.cpus ?? 2,
		pidsLimit: options.pidsLimit ?? 256,
	});
}

/** 把任意路径归一化成工作目录内的相对路径；越界直接抛错。 */
export function resolveInside(root: string, path: string): { absolute: string; relative: string } {
	const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
	const rel = relative(root, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`路径越界（超出工作目录）: ${path}`);
	}
	return { absolute, relative: rel.length === 0 ? "." : rel };
}

/** 宿主执行：行为与改造前一致。 */
class HostSandbox implements Sandbox {
	readonly mode = "host" as const;
	readonly root: string;
	/** 工作目录本身可能就是符号链接（如 macOS 的 /tmp），比较时要用真实路径。 */
	private readonly realRoot: Promise<string>;

	constructor(root: string) {
		this.root = root;
		this.realRoot = realpath(root);
	}

	exec(command: string, options: ExecOptions): Promise<SandboxResult> {
		const cwd = options.cwd ? resolveInside(this.root, options.cwd).absolute : this.root;
		return new Promise((done) => {
			exec(
				command,
				{ cwd, timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT_CHARS, signal: options.signal },
				(error, stdout, stderr) => {
					const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
					if (failure && failure.name === "AbortError") {
						done({ code: null, stdout, stderr, timedOut: false, aborted: true });
						return;
					}
					done({
						code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
						stdout,
						stderr,
						timedOut: Boolean(failure?.killed),
						aborted: false,
					});
				},
			);
		});
	}

	async readFile(path: string): Promise<string> {
		const { absolute } = resolveInside(this.root, path);
		await this.assertRealInside(absolute);
		return readFile(absolute, "utf8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		const { absolute } = resolveInside(this.root, path);
		const parent = dirname(absolute);
		// 先检查已存在的父目录，避免经由符号链接把文件写到目录之外。
		await this.assertRealInside(parent, { allowMissing: true });
		await mkdir(parent, { recursive: true });
		await this.assertRealInside(parent);
		await writeFile(absolute, content, "utf8");
	}

	async listDir(path: string): Promise<SandboxEntry[]> {
		const { absolute } = resolveInside(this.root, path);
		await this.assertRealInside(absolute);
		const entries = await readdir(absolute, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
	}

	async dispose(): Promise<void> {
		// 宿主模式无资源需要释放。
	}

	/** 路径本身在目录内，但可能是跳出去的符号链接。 */
	private async assertRealInside(path: string, options: { allowMissing?: boolean } = {}): Promise<void> {
		let resolved: string;
		try {
			resolved = await realpath(path);
		} catch (error) {
			if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const real = await this.realRoot;
		const rel = relative(real, resolved);
		if (rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`路径越界（符号链接指向工作目录之外）: ${path}`);
		}
	}
}

/** 容器执行：一个沙箱一个常驻容器，任务结束销毁。 */
class DockerSandbox implements Sandbox {
	readonly mode = "docker" as const;
	readonly root: string;

	private readonly image: string;
	private readonly network: "none" | "egress";
	private readonly memoryMb: number;
	private readonly cpus: number;
	private readonly pidsLimit: number;
	private readonly containerName: string;
	private ready: Promise<void> | null = null;

	constructor(
		root: string,
		options: { image: string; network: "none" | "egress"; memoryMb: number; cpus: number; pidsLimit: number },
	) {
		this.root = root;
		this.image = options.image;
		this.network = options.network;
		this.memoryMb = options.memoryMb;
		this.cpus = options.cpus;
		this.pidsLimit = options.pidsLimit;
		this.containerName = `mini-pi-sbx-${randomUUID().slice(0, 8)}`;
	}

	async exec(command: string, options: ExecOptions): Promise<SandboxResult> {
		await this.ensureReady();
		const workdir = options.cwd
			? `${CONTAINER_WORKSPACE}/${resolveInside(this.root, options.cwd).relative}`
			: CONTAINER_WORKSPACE;
		return runDocker(
			["exec", "-i", "--workdir", workdir, this.containerName, "sh", "-lc", command],
			{ timeoutMs: options.timeoutMs, signal: options.signal },
		);
	}

	async readFile(path: string): Promise<string> {
		await this.ensureReady();
		const target = `${CONTAINER_WORKSPACE}/${resolveInside(this.root, path).relative}`;
		const result = await runDocker(["exec", this.containerName, "cat", target], { timeoutMs: 30_000 });
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `读取失败: ${path}`);
		}
		return result.stdout;
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.ensureReady();
		const target = `${CONTAINER_WORKSPACE}/${resolveInside(this.root, path).relative}`;
		// 用 sh 负责建目录并写入，内容经 stdin 传入，避免转义问题。
		const result = await runDocker(
			["exec", "-i", this.containerName, "sh", "-c", `mkdir -p "$(dirname "$1")" && cat > "$1"`, "sh", target],
			{ timeoutMs: 30_000, input: content },
		);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || `写入失败: ${path}`);
		}
	}

	async listDir(path: string): Promise<SandboxEntry[]> {
		await this.ensureReady();
		const target = `${CONTAINER_WORKSPACE}/${resolveInside(this.root, path).relative}`;
		const result = await runDocker(
			["exec", this.containerName, "ls", "-1p", "--color=never", target],
			{ timeoutMs: 30_000 },
		);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `列目录失败: ${path}`);
		return result.stdout
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0)
			.map((line) => ({ name: line.replace(/\/$/, ""), isDirectory: line.endsWith("/") }));
	}

	async dispose(): Promise<void> {
		// 未启动过就不需要清理，避免为了删容器反而先启动一个。
		if (!this.ready) return;
		await runDocker(["rm", "-f", this.containerName], { timeoutMs: 30_000 });
	}

	/** 首次使用时启动容器；失败向上抛出，不做静默降级。 */
	private ensureReady(): Promise<void> {
		if (!this.ready) this.ready = this.start();
		return this.ready;
	}

	private async start(): Promise<void> {
		const networkArgs = this.network === "none" ? ["--network", "none"] : [];
		await runDocker(
			[
				"run",
				"-d",
				"--rm",
				// 镜像缺失时立即失败，不去远端拉取（沙箱镜像需显式构建）。
				"--pull",
				"never",
				"--name",
				this.containerName,
				...networkArgs,
				"--memory",
				`${this.memoryMb}m`,
				"--cpus",
				String(this.cpus),
				"--pids-limit",
				String(this.pidsLimit),
				"--read-only",
				"--tmpfs",
				"/tmp",
				"-v",
				`${this.root}:${CONTAINER_WORKSPACE}`,
				"-w",
				CONTAINER_WORKSPACE,
				"-e",
				"HOME=/tmp",
				this.image,
				"sleep",
				"infinity",
			],
			{ timeoutMs: 120_000 },
		).then((result) => {
			if (result.code !== 0) {
				throw new Error(
					`沙箱容器启动失败（镜像 ${this.image}）：${result.stderr.trim() || `exit ${result.code}`}`,
				);
			}
		});
	}
}

/** 统一跑 docker CLI：支持 stdin、超时与取消。 */
function runDocker(
	args: string[],
	options: { timeoutMs: number; signal?: AbortSignal; input?: string },
): Promise<SandboxResult> {
	return new Promise((done) => {
		const child = spawn("docker", args, { signal: options.signal });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => {
			clearTimeout(timer);
			if (error.name === "AbortError") {
				aborted = true;
				done({ code: null, stdout, stderr, timedOut, aborted });
				return;
			}
			done({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut, aborted });
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			done({ code, stdout, stderr, timedOut, aborted });
		});

		if (options.input !== undefined) {
			child.stdin.end(options.input);
		} else {
			child.stdin.end();
		}
	});
}
