# P0 执行沙箱：方案设计

> 设计稿，已在 `feature/sandbox` 分支实现（最小可用版）。
> 构建镜像（按能力拆，均以 uid 1000 非 root 运行）：
> - `docker build -f docker/sandbox-node.Dockerfile -t mini-pi-sandbox:node .`（Node + bash + git）
> - `docker build -f docker/sandbox-data.Dockerfile -t mini-pi-sandbox:data .`（Python + pandas + matplotlib）
> - `docker build -f docker/sandbox-r.Dockerfile -t mini-pi-sandbox:r .`（R 4.4）
> - `docker build -f docker/sandbox-julia.Dockerfile -t mini-pi-sandbox:julia .`（Julia 1.10）
> 国内构建可用 `--build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`。
> 默认 `SANDBOX_MODE=docker`；开发调试可设 `SANDBOX_MODE=host`。

## 1. 问题

当前 `run_command` 直接 `exec(command, { cwd })`，`write_file` 直接写任意路径。实测后果：

- worker 里的模型自行执行 `npm run poc`，并 `kill 38306` 杀掉 GraphQL server
- 模型可读写 `/etc`、`~/.ssh`、任何项目外的文件

工具集只有 4 个（`read_file` / `write_file` / `list_files` / `run_command`），且都集中在两个工厂函数里，**改造面很小**，这是做沙箱的有利条件。

## 2. 目标与非目标

目标
- 命令执行不能影响宿主：进程、文件系统、网络、资源
- 写入范围限制在任务工作目录内
- 失败时**默认拒绝**（fail closed），不静默降级
- 对 Agent 透明：工具名、参数、返回格式不变

非目标
- 不是多租户安全隔离，不防内核级逃逸（`--privileged` 一律不用）
- 不改动 Provider / Redux / Saga
- 不做审批流（属于 P0 之后的"审批闸门"）

## 3. 方案对比

| 方案 | 隔离强度 | 复杂度 | 跨语言（R/Julia） | 结论 |
| --- | --- | --- | --- | --- |
| A. `sandbox-exec`（macOS 内置） | 中，规则写起来脆 | 低 | 差，依赖宿主已装环境 | 不选 |
| B. 工具级容器：Agent 在宿主，命令转发进容器 | 高 | 中 | 好，换镜像即可 | **选 B** |
| C. 整个 Agent 进容器 | 高 | 高，需带代码/凭据/GraphQL 客户端 | 好 | 暂不选 |

选 B 的核心理由：改造点只落在工具层，`StageRuntime`、Saga、远端协议全都不动；P1 注册表里"能力标签"也正好对应"用哪个镜像"。

## 4. 架构

```
Agent 进程（宿主）
  └─ AgentTool.execute()
       └─ Sandbox.exec(cmd) / Sandbox.read(path) / Sandbox.write(path)
            ├─ HostBackend      （开发/测试，行为同今天）
            └─ DockerBackend    （默认）
                 └─ docker run --rm ... -v <taskDir>:/workspace <image>
```

生命周期选择：

- **每个任务一个容器**：`docker run --rm` 启动，任务阶段结束销毁
- 工作目录以 volume 挂入，容器内固定 `/workspace`
- 冷启动约 1 秒量级，可接受；后续如需优化再做"每 worker 常驻容器 + 每次任务清空工作目录"

## 5. 接口草案

```ts
export interface SandboxOptions {
	mode: "docker" | "host";
	image: string;              // 如 mini-pi-sandbox:node
	workspace: string;          // 宿主任务目录
	network: "none" | "egress";
	cpuLimit: number;           // --cpus
	memoryMb: number;
	pidsLimit: number;
}

export interface Sandbox {
	exec(command: string, opts: { timeoutMs: number; cwd?: string; signal?: AbortSignal }): Promise<CommandResult>;
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	listDir(path: string): Promise<Entry[]>;
	dispose(): Promise<void>;
}
```

接入点：

| 文件 | 改动 |
| --- | --- |
| `src/tools/sandbox.ts`（新） | `createSandbox()` 与两种 backend |
| `src/tools/shell-tool.ts` | `exec` 换成 `sandbox.exec`，保留超时/截断/取消逻辑 |
| `src/tools/file-tools.ts` | 路径先过 `sandbox.resolve()`（必须在 workspace 内），再走 sandbox |
| `src/agent/pipeline.ts` | 工厂签名加 `sandbox` 参数 |
| `src/index.ts` | 读取 `SANDBOX_MODE` / `SANDBOX_IMAGE`，构造 sandbox 注入 pipeline |

工具对模型暴露的 schema 完全不变。

## 6. 安全边界清单

容器参数（默认值）：

- `--network none`（需要访问模型 API 的只有宿主进程；容器内不需要外网）
- `--memory 2g --cpus 2 --pids-limit 256`
- `--read-only` 根文件系统 + `--tmpfs /tmp` + 只读挂载 workspace 之外的路径一律不挂
- `-v <taskDir>:/workspace:rw`，其余不挂载
- 非 root 用户（镜像内建 `uid 1000`）
- 不传 `--privileged`，不挂 `docker.sock`
- 默认不带任何宿主环境变量（`--env-file` 只传白名单，如 `HOME=/workspace`）

应用层校验（backend 内自己再做一遍，不依赖容器）：

1. 路径归一化后必须以 workspace 为前缀（防 `..`、符号链接逃逸）
2. 拒绝绝对路径访问 `/workspace` 之外
3. 命令长度上限、输出上限（沿用 10k 字符截断）
4. 超时沿用 120s / 上限 600s，超时先 `SIGTERM` 再 `SIGKILL`
5. 危险命令不做字符串黑名单（易绕过），**靠容器隔离兜底**

## 7. 失败与降级

- Docker 不可用 / 镜像缺失 → **直接失败**，错误信息告诉用户怎么启用
- 仅当显式 `SANDBOX_MODE=host` 才走宿主执行，并在启动日志打印警告
- 容器启动失败重试 1 次；仍失败则让该阶段失败，由现有 `stageFailed` 路径处理

## 8. 观测

每次工具调用记录一行结构化日志：`tool`、`command`、`exit`、`durationMs`、`containerId`、`workspace`。字段直接复用现有 `toolStarted/toolEnded` action 的 payload，后续 P5 的 trace id 就挂在这里。

## 9. 验收标准

必须全部通过，且要有自动化测试（可 mock docker CLI，另加一条真实 docker 的集成用例）：

| # | 用例 | 期望 |
| --- | --- | --- |
| 1 | `kill <宿主进程>` | 命令失败，宿主进程存活 |
| 2 | `echo x > /etc/passwd` | 权限拒绝 |
| 3 | 写入 `/workspace/../outside.txt` | 工具层拒绝 |
| 4 | 通过符号链接指向宿主目录 | 工具层拒绝 |
| 5 | `curl https://example.com` | 网络不可达（`--network none`） |
| 6 | `:(){ :\|:& };:` 类 fork 炸弹 | 被 pids 限制终止，宿主无影响 |
| 7 | `sleep 999` | 120s 超时终止 |
| 8 | 正常 `node --version` / 写 CSV | 与今天行为一致 |

## 10. 实施顺序（M1 内三步）

1. 抽出 `Sandbox` 接口 + `HostBackend`，行为与今天完全一致，跑通现有测试
2. 实现 `DockerBackend` 与安全参数，默认启用
3. 补验收用例，在 m1 上跑一次真实回归（含 R/Julia 镜像的可选验证）

## 11. 未决问题

1. 镜像策略：单一基础镜像（Node + Python + R + Julia）体积大，还是按能力拆多个小镜像？倾向按能力拆，与 P1 的 capability 对应
2. macOS 上 Docker Desktop 的 I/O 性能对大数据文件是否可接受，需实测
3. 采集端的"读取 inbox 图片"是否需要挂载宿主目录，还是先复制进 workspace（倾向复制）
4. GPU 场景（后续）需要 `--gpus`，属于 P1 之后
