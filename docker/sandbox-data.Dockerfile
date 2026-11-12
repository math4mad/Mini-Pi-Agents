# 数据分析沙箱：Python + pandas + matplotlib，供数据类任务使用。
# 构建：docker build -f docker/sandbox-data.Dockerfile -t mini-pi-sandbox:data .

FROM python:3.12-slim

# 国内环境可传 --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PIP_INDEX_URL=https://pypi.org/simple

RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" pandas matplotlib

RUN useradd -m -u 1000 sandbox
USER sandbox

WORKDIR /workspace
