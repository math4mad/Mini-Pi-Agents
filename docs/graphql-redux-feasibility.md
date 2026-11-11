# GraphQL + Redux 多机协同：可行性评估

对应设想见 `graphql-redux.md`。本文只回答三个问题：能不能做、应该怎么做、第一步验证什么。

## 1. 结论

**可行，但不建议做「Redux 全量双向同步」。**

更稳的形态是：**GraphQL 作为远程控制面与事件通道，Redux 仍是每台机器本地的状态中心**。Saga 通过 GraphQL 读写远端、订阅事件，再把事件 dispatch 成 action；渲染层与 Agent 循环完全不用感知网络。

原因：Agent 的状态里混了三类东西——控制面（任务、阶段、归属）、数据面（消息、工具输出、产物）、检索内容（GraphRAG）。把它们整棵 state 树做 CRDT/GraphQL 同步，收益低、冲突复杂度高；而按「事件 + 单写者」同步，冲突面会小一个数量级。

## 2. 需求拆解

| 层面 | 内容 | 同步策略 |
|---|---|---|
| 控制面 | Task、Run、Stage 状态与归属机器 | 必须强一致，服务端裁决 |
| 数据面 | Message、ToolResult、Artifact | 追加写、只读同步，按事件序号补齐 |
| 检索面 | GraphRAG 文档、图谱关系、向量 | 服务端存储，按需查询，不同步到 Redux |

## 3. 架构选择

### 3.1 Redux 与 GraphQL 的关系

| 方案 | 做法 | 评价 |
|---|---|---|
| A. Apollo Cache 取代 Redux | 用 Apollo 的规范化缓存当唯一状态源 | 与现有 Saga/Reducer 冲突，等于重写；且 Agent 的本地瞬时状态（streamingText、tool 进度）不适合进远端缓存 |
| B. Saga 内调用 GraphQL | `call(graphqlRequest, doc)` + `call(subscribeEvents)`，结果 dispatch 成现有 action | **推荐**。改动集中在 [sagas.ts](../src/store/sagas.ts) 与新增 client，reducer/渲染层几乎不动 |
| C. Redux 中间件同步整个 state | 每次 action 后把 state diff 推到服务端 | 拒绝。噪声大、体积大、无法表达“谁有权写” |

方案 B 与当前结构天然契合：`AgentRuntime` 已经支持注入 `stream`，同样可以注入一个 `remote` 接口（提交任务、领取阶段、追加消息、订阅事件），测试时用内存实现即可。

### 3.2 拓扑

**推荐：单协调者 + 多工作节点（coordinator / worker）。**

- coordinator 持有 GraphQL schema 与数据库，负责派发阶段、维护归属与重试
- worker 拉取“分配给我的阶段”，在本机执行工具与模型调用，把消息/结果追加回服务端
- 不在机器之间做双向文件同步：`run_command`、`write_file` 都只作用于 worker 本地工作目录

全互联（每台机器都能改任意状态）在 Agent 场景里没有收益，只会引入写冲突与权限问题。

### 3.3 一致性与并发

Agent 的副作用（改文件、跑命令）不能重复执行，因此：

- **单写者租约**：`Stage.owner` + `leaseExpiresAt`，只允许 owner 推进该阶段；租约过期才允许抢占
- **版本号 CAS**：`stageEnded(stageId, expectedVersion, output)`，服务端版本不匹配返回冲突，客户端重新拉取后决定重试
- **幂等键**：`clientEventId` 随 mutation 提交，服务端按 id 去重，解决断线重发
- **事件序号**：全局递增 `seq`，订阅端记录 cursor，重连时 `events(since: seq)` 补齐

## 4. 数据模型草案

```graphql
type Machine { id: ID!, name: String!, lastSeenAt: String! }

type Task {
  id: ID!
  prompt: String!
  status: TaskStatus!        # pending | running | done | failed
  createdAt: String!
}

type Stage {
  id: ID!
  taskId: ID!
  index: Int!
  role: String!              # planner | executor | reviewer
  attempt: Int!
  status: String!            # pending | running | done | error | aborted
  owner: Machine
  leaseExpiresAt: String
  version: Int!              # CAS
  output: String
}

type Message {
  id: ID!
  stageId: ID!
  seq: Int!
  role: String!
  content: String!
  toolName: String
  isError: Boolean
}

type Artifact { id: ID!, taskId: ID!, path: String!, hash: String!, size: Int! }

type RetrievalDoc {
  id: ID!
  title: String!
  text: String!              # 分页返回
  embeddingRef: String!      # 向量存独立索引，GraphQL 只存引用
  relations: [RetrievalEdge!]!
}

type Query {
  task(id: ID!): Task
  stages(taskId: ID!): [Stage!]!
  events(since: Int!): [Event!]!
  searchDocs(query: String!, limit: Int = 5): [RetrievalDoc!]!
}

type Subscription {
  event(since: Int): Event!
}

type Mutation {
  createTask(prompt: String!, clientEventId: ID!): Task!
  claimStage(stageId: ID!, machineId: ID!): Stage
  appendMessage(stageId: ID!, input: MessageInput!, clientEventId: ID!): Message!
  finishStage(stageId: ID!, expectedVersion: Int!, output: String!, status: String!): Stage!
}
```

`Event` 是给同步用的精简信封（`seq`、`type`、`payload`），避免订阅端拉全量对象。

## 5. 实时同步链路

```
GraphQL Subscription (SSE 或 graphql-ws)
  → eventChannel（复用 sagas.ts 已有的 take 模式）
  → dispatch remoteEventReceived(evt)
  → reducer 按 seq 去重后更新 pipeline / messages
  → renderer 重绘
```

选 SSE 即可：单向推送、断线自动重连、实现比 WS 简单；GraphQL over SSE 已有成熟实现。只有需要客户端经同一连接发 mutation 时才值得上 WS。

## 6. 与当前代码的差距

| 现状 | 需要的改动 |
|---|---|
| `AgentRuntime.stages` 在启动时写死 | 改为从服务端领取阶段配置（角色、提示词、工具权限） |
| 工具在本机执行 | 保持本机，但 `cwd` 限定到 worker 的工作目录 |
| 阶段输出为纯文本 | 追加 `Artifact` 元数据，便于跨机查看产物而不传文件内容 |
| 无身份/鉴权 | 每个 worker 携带机器 token；`run_command` 只在本地生效 |
| 无重放/去重 | 引入 `seq` 与 `clientEventId` |

## 7. 风险清单

1. **双写**：没有租约时两台机器同时推进同一阶段 → 重复改文件。必须服务端裁决，不能靠客户端自觉。
2. **重复执行**：订阅是 at-least-once，客户端必须按 `seq` / `clientEventId` 幂等。
3. **大载荷**：消息与检索文本可能很大。GraphQL 响应按页返回；不要把 embedding 数组放进 GraphQL。
4. **工具执行安全**：`run_command` 无审批且继承环境变量。跨机后必须限定工作目录并禁止敏感环境变量透传。
5. **调试成本**：多进程 + 订阅 + Redux DevTools 同时观察，需要统一的 `traceId`（沿用 `taskId/stageId` 即可）。
6. **GraphQL 不是同步协议**：它只解决“怎么取数”，不解决冲突、重放、权限。这些必须自己建。

## 8. 不建议的做法

- 把整个 Redux state 树同步到服务端（体积、噪声、权限都不可控）
- 在 reducer 里发网络请求（违反当前“reducer 纯函数”的约定）
- 用 GraphQL 存二进制产物或 embedding
- 让多台机器共享同一个工作目录（Agent 的写操作没有事务语义）

## 9. 最小验证（建议的下一步）

一个本地 POC，不接真实模型：

1. `graphql-yoga` 单进程服务端：`createTask`、`claimStage`、`finishStage`、`event` 订阅
2. coordinator 进程：创建任务，按 planner → executor → reviewer 派发
3. 两个 worker 进程：用内存假模型，只认领分配给自己的阶段
4. 验证项：
   - 同一阶段被两个 worker 同时 `claim` 时，只有一个成功
   - 杀掉 worker 后租约过期，阶段可被另一个 worker 接管
   - 订阅端断线 5 秒后按 `seq` 补齐事件，无丢失、无重复执行
5. 通过后，再把 `AgentRuntime.stream` 换成真实模型，接入现有 Saga

## 10. 待定问题

1. 协同范围是**局域网内多机**还是**公网**？前者可以省掉 TLS/鉴权的大部分工作。
2. GraphRAG 的规模与更新频率？如果只是静态知识库，直接做成只读查询接口比订阅同步简单。
3. worker 之间是否需要共享产物文件？如果需要，建议对象存储 + `Artifact.hash`，而不是同步文件内容。
4. 是否允许多个 planner 并行探索？如果不允许，单协调者就是最终形态，不需要更复杂的调度层。
