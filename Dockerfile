FROM oven/bun:1 AS base
WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lockb? /temp/dev/
# Install dev deps (allow resolver to update lockfile when deps change)
RUN cd /temp/dev && bun install

RUN mkdir -p /temp/prod
COPY package.json bun.lockb? /temp/prod/
# Install prod deps
RUN cd /temp/prod && bun install --production

FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

RUN bun run build

FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/dist ./dist
COPY --from=prerelease /usr/src/app/package.json .

RUN mkdir -p /usr/src/app/data

EXPOSE 3000/tcp

ENTRYPOINT [ "bun", "run", "dist/index.js" ]
