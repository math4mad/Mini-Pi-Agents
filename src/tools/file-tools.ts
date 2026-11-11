/** 文件读写工具：最小但够一个编码 Agent 使用。 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "../types.ts";

/** 单次读取上限，避免把整个大文件塞进上下文。 */
const MAX_READ_CHARS = 100_000;
const MAX_LIST_ENTRIES = 200;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

export function createFileTools(cwd: string): AgentTool[] {
	return [createReadFileTool(cwd), createWriteFileTool(cwd), createListFilesTool(cwd)];
}

function createReadFileTool(cwd: string): AgentTool {
	return {
		name: "read_file",
		label: "Read file",
		description: "Read a UTF-8 text file. Returns the file content, truncated when very large.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory" },
			},
			required: ["path"],
			additionalProperties: false,
		},
		execute: async (args) => {
			const absolutePath = resolvePath(cwd, requireString(args, "path"));
			const content = await readFile(absolutePath, "utf8");

			if (content.length > MAX_READ_CHARS) {
				return {
					content: `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated: file is ${content.length} characters, showing first ${MAX_READ_CHARS}]`,
				};
			}

			return { content };
		},
	};
}

function createWriteFileTool(cwd: string): AgentTool {
	return {
		name: "write_file",
		label: "Write file",
		description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path, absolute or relative to the working directory" },
				content: { type: "string", description: "Full file content to write" },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		execute: async (args) => {
			const absolutePath = resolvePath(cwd, requireString(args, "path"));
			const content = requireString(args, "content", true);

			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, content, "utf8");

			return {
				content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${displayPath(cwd, absolutePath)}`,
			};
		},
	};
}

function createListFilesTool(cwd: string): AgentTool {
	return {
		name: "list_files",
		label: "List files",
		description: "List entries in a directory (non-recursive). Skips node_modules and .git.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Directory path relative to the working directory; defaults to the working directory",
				},
			},
			additionalProperties: false,
		},
		execute: async (args) => {
			const rawPath = args.path;
			const relativePath = typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath : ".";
			const absolutePath = resolvePath(cwd, relativePath);
			const entries = await readdir(absolutePath, { withFileTypes: true });

			const visible = entries
				.filter((entry) => !(entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)))
				.sort((a, b) => {
					if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
					return a.name.localeCompare(b.name);
				});

			const lines = visible
				.slice(0, MAX_LIST_ENTRIES)
				.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

			if (visible.length > MAX_LIST_ENTRIES) {
				lines.push(`[truncated: ${visible.length - MAX_LIST_ENTRIES} more entries]`);
			}

			return {
				content: `Directory: ${displayPath(cwd, absolutePath)}\n${lines.join("\n") || "(empty)"}`,
			};
		},
	};
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, absolutePath: string): string {
	const relativePath = relative(cwd, absolutePath);
	return relativePath.length > 0 ? relativePath : ".";
}

function requireString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
	const value = args[key];
	if (typeof value !== "string") {
		throw new Error(`Missing required string argument "${key}"`);
	}
	if (!allowEmpty && value.trim().length === 0) {
		throw new Error(`Argument "${key}" must not be empty`);
	}
	return value;
}
