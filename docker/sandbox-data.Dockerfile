# 数据分析沙箱：Python + pandas + matplotlib，供数据类任务使用。
# 构建：docker build -f docker/sandbox-data.Dockerfile -t mini-pi-sandbox:data .

FROM python:3.12-slim

RUN pip install --no-cache-dir pandas matplotlib

RUN useradd -m -u 1000 sandbox
USER sandbox

WORKDIR /workspace
