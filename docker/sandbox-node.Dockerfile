# 编码任务沙箱：Node + bash + git，供 Agent 跑测试与构建。
# 构建：docker build -f docker/sandbox-node.Dockerfile -t mini-pi-sandbox:node .

FROM node:22-alpine

RUN apk add --no-cache bash git python3

# 非 root 运行；node 镜像自带 uid 1000 的 node 用户。配合 --read-only 与 HOME=/tmp 使用。
USER node

WORKDIR /workspace
