# Nothing made here is native, so this runs once, on the machine building, for every platform the image is for.
# Both by digest, so that the same build gives the same image; Dependabot moves them on.
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
WORKDIR /src
RUN npm install --global pnpm@11.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY packages/cli/package.json packages/cli/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/editor-model/package.json packages/editor-model/package.json
COPY packages/embed/package.json packages/embed/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY docs/api/openapi.yaml docs/api/openapi.yaml
COPY scripts/third-party-notices.mjs scripts/third-party-notices.mjs
COPY LICENSE LICENSE
RUN pnpm build && node scripts/third-party-notices.mjs > THIRD-PARTY-NOTICES.txt

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV NODE_ENV=production PANDOCS_WEB_DIR=/app/web PANDOCS_DATA_DIR=/data PORT=8080
# For keeping spaces in step with Git repositories.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/packages/server/dist ./
COPY --from=build /src/packages/web/dist ./web
COPY --from=build /src/THIRD-PARTY-NOTICES.txt ./web/
COPY LICENSE NOTICE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/readyz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "main.mjs"]
