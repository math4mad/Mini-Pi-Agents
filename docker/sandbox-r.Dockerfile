# R 分析沙箱：R + 基础系统工具，供统计与绘图任务使用。
# 构建：docker build -f docker/sandbox-r.Dockerfile -t mini-pi-sandbox:r .

FROM r-base:4.4.1

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# 非 root 运行，uid 与其他语言镜像保持一致（r-base 已自带 uid 1000 的 docker 用户）。
RUN grep -q '^[^:]*:[^:]*:1000:' /etc/passwd || useradd -m -u 1000 -s /bin/bash sandbox
USER 1000:1000

WORKDIR /workspace
