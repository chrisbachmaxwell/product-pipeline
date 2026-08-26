FROM node:20
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Copy all source files
COPY . .

# migration-admin verifies that operator commands run from the ProductPipeline
# repository root. Railway excludes Git metadata from the Docker build context,
# so retain the reviewed root marker without copying repository history.
RUN mkdir -p .git && chmod 700 .git

# Nonsecret, exact-scope production migration-store configuration. The server
# opens it only for an authenticated read-only status request; schema changes
# still require the standalone operator CLI and exact scope confirmation.
ENV MIGRATION_STATE_CONFIG_PATH=/app/config/migration-state.production.json

# Build (TypeScript + Vite client bundle)
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/server/index.js"]
