# Stage 1: build the Expo web app (served at /app)
FROM oven/bun:1 AS web
WORKDIR /build
COPY mobile/package.json mobile/bun.lock ./
RUN bun install --frozen-lockfile
COPY mobile/ ./
RUN bunx expo export --platform web

# Stage 2: the walkie server
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
COPY --from=web /build/dist ./mobile/dist

ENV HOST=0.0.0.0 NODE_ENV=production
# Cloud Run injects PORT (8080); the server reads it.
EXPOSE 8080
CMD ["bun", "src/server.ts"]
