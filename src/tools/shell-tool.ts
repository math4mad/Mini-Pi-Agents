/** 命令执行工具：让 Agent 能跑测试、类型检查等真实命令，而不是靠猜。 */

import { exec } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { AgentTool } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 10_000;

export function createShellTool(cwd: string): AgentTool {
	return {
		name: "run_command",
		label: "Run command",
		description:
			"Run a shell command in the working directory and return its exit code, stdout and stderr. Use it to run tests, typecheck, build or git commands instead of guessing their results.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Command line to execute" },
				cwd: {
					type: "string",
					description: "Working directory, absolute or relative to the project root; defaults to the project root",
				},
				timeout_ms: {
					type: "integer",
					description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
		execute: async (args, context) => {
			const command = requireString(args, "command");
			const rawCwd = typeof args.cwd === "string" && args.cwd.trim().length > 0 ? args.cwd : ".";
			const workdir = isAbsolute(rawCwd) ? rawCwd : resolve(cwd, rawCwd);
			const timeout = clampTimeout(args.timeout_ms);

			const result = await runCommand(command, workdir, timeout, context.signal);

			if (result.aborted) {
				return { content: `已取消：${command}`, isError: true };
			}

			const sections = [`$ ${command}`, `cwd: ${workdir}`, `exit: ${result.code ?? "signal"}`];
			if (result.timedOut) {
				sections.push(`[timed out after ${timeout}ms]`);
			}
			if (result.stdout.trim().length > 0) {
				sections.push(`stdout:\n${result.stdout.trimEnd()}`);
			}
			if (result.stderr.trim().length > 0) {
				sections.push(`stderr:\n${result.stderr.trimEnd()}`);
			}

			return {
				content: truncateOutput(sections.join("\n")),
				isError: result.code !== 0,
			};
		},
	};
}

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

function runCommand(
	command: string,
	cwd: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<CommandResult> {
	return new Promise((resolvePromise) => {
		exec(
			command,
			{ cwd, timeout, maxBuffer: 10 * 1024 * 1024, signal },
			(error, stdout, stderr) => {
				const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;

				if (failure && failure.name === "AbortError") {
					resolvePromise({ code: null, stdout, stderr, timedOut: false, aborted: true });
					return;
				}

				resolvePromise({
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

function truncateOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;

	const head = text.slice(0, MAX_OUTPUT_CHARS - 4000);
	const tail = text.slice(-4000);
	return `${head}\n\n[truncated: ${text.length} characters total, showing head and tail]\n\n${tail}`;
}

function clampTimeout(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Missing required string argument "${key}"`);
	}
	return value;
}
