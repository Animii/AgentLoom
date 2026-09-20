FROM docker:28.5.2-cli AS dockercli
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates procps && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.277 @openai/codex@0.155.1 opencode-ai@1.18.31 && npm cache clean --force
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /data /workspaces/projects /workspaces/runs /home/node/.claude /home/node/.codex /home/node/.local/share/opencode /home/node/.config/opencode && chown -R node:node /data /workspaces /home/node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATA_DIR=/data WORKSPACE_ROOT=/workspaces
USER node
EXPOSE 4317
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
