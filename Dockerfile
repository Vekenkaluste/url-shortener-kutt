# syntax=docker/dockerfile:1
#
# Multi-stage build for the Veke platform. The image bakes in no environment
# configuration: every value arrives as an environment variable at container
# start-up, so one artifact is promoted from test to production.
#
# The image starts the server only. Database migrations are a separate step,
# run with the same image before the new version rolls out:
#   node node_modules/knex/bin/cli.js migrate:latest

# ---------- dependencies ----------
# Pinned by version and digest: two builds of the same commit must produce the
# same image. Node 22 is the version upstream Kutt builds and tests with.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps

WORKDIR /kutt

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---------- runtime ----------
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

WORKDIR /kutt

ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps /kutt/node_modules ./node_modules
COPY package.json knexfile.js ./
COPY server ./server
COPY static ./static
COPY custom ./custom

# The base image provides this user; the platform enforces runAsNonRoot.
USER node

EXPOSE 3000

# node runs as pid 1 and exits on SIGTERM through the handler in server.js.
# Started directly rather than through npm, which writes outside /tmp.
CMD ["node", "server/server.js", "--production"]
