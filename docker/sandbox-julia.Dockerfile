# Julia 分析沙箱：Julia + 基础系统工具，供数值计算任务使用。
# 构建：docker build -f docker/sandbox-julia.Dockerfile -t mini-pi-sandbox:julia .

FROM julia:1.10-bookworm

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# 非 root 运行，uid 与其他语言镜像保持一致。
RUN grep -q '^[^:]*:[^:]*:1000:' /etc/passwd || useradd -m -u 1000 -s /bin/bash sandbox
USER 1000:1000

WORKDIR /workspace
