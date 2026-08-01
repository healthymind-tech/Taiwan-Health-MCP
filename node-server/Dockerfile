# Multi-stage build for the Node (TypeScript) MCP backend.
# Stage 1 compiles TS -> dist/; stage 2 ships a slim runtime image.
# Build context is the repo root (see compose.yaml `app.build`).

FROM node:20-slim AS build
WORKDIR /app
COPY node-server/package.json node-server/package-lock.json ./
RUN npm ci
COPY node-server/tsconfig.json ./
COPY node-server/src ./src
RUN npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY node-server/package.json node-server/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# The Analysis LM system prompts ship with the code and are read at analysis
# time; the services resolve them from /src/prompts (dist/../../src/prompts).
COPY src/prompts/ /src/prompts/

# MCP transport port (overridden by MCP_PORT at runtime).
EXPOSE 8000
# Metrics port.
EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
