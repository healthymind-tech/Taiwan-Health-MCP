# Multi-stage build for the Node (TypeScript) MCP backend.
# Stage 1 compiles TS -> dist/; stage 2 ships a slim runtime image.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
# No lockfile yet during scaffolding; switch to `npm ci` once package-lock.json exists.
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# MCP transport port (overridden by MCP_PORT at runtime).
EXPOSE 8000
# Metrics port.
EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
