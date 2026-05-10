# ─────────────────────────────────────────────────────────────────────────────
# Estonian Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t estonian-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 estonian-data-protection-mcp
#
# The image expects a pre-built database at /app/data/aki.db.
# Override with AKI_DB_PATH for a custom location.
#
# Multi-stage build pattern preserves the better-sqlite3 native binding:
# the production stage copies node_modules from the builder rather than
# re-running `npm ci --ignore-scripts` (which would strip the postinstall
# step that fetches/builds the .node native binding).
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + install full dependencies ---
FROM node:20-slim AS builder

WORKDIR /app

# Install build toolchain for better-sqlite3 native binding
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Run full install WITH lifecycle scripts so better-sqlite3 builds its native binding
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune dev dependencies but keep the compiled native binding
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV AKI_DB_PATH=/app/data/aki.db

# Bring node_modules (with native binding intact) from the builder
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY package.json ./

# Database baked in by CI from GitHub Release asset (database.db.gz → data/database.db)
COPY data/database.db data/aki.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
