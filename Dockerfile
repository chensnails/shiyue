# 拾阅（shiyue）—— RSS 直连聚合 + 每日 AI 简报（ARM64 / AMD64 通用）
FROM node:22-alpine

# 时区数据：定时摘要按 Asia/Shanghai 计算，日志时间也需要
# 注意：tzdata 不能删，否则 /usr/share/zoneinfo 丢失，TZ 无法解析会回落到 UTC
RUN apk add --no-cache tzdata \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai

# 先装依赖再拷源码，源码改动不会让依赖层缓存失效
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js db.js rss.js digest.js proxy.js ./
COPY public ./public

EXPOSE 3000

# 用 Node 自带 fetch 做健康检查，无需额外装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
