# 彩绘玻璃拼片台
# Node.js 20 + Express + better-sqlite3（SQLite 数据库文件持久化到挂载卷）
FROM node:20-bookworm-slim

# better-sqlite3 在无匹配预编译包时需要本地编译工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先利用层缓存安装依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 应用代码
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/studio.db

# 数据库目录（compose 中挂载命名卷）
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# 容器启动时 src/db.init 自动建表（CREATE TABLE IF NOT EXISTS），
# 因此首次启动即完成数据库初始化，无需额外脚本。
CMD ["node", "src/server.js"]
