# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w @parse-then-llm/api --include-workspace-root=false
COPY spec spec
COPY apps/api apps/api
WORKDIR /app/apps/api
RUN mkdir -p /data/documents && chown node /data/documents
USER node
EXPOSE 3000
CMD ["npx", "tsx", "src/main.ts"]
