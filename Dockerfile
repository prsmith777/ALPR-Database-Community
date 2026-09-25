FROM node:24-bookworm AS builder
WORKDIR /app

ENV CXXFLAGS="-DSYZX_FEATURE_FLAG=1"
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --network-timeout 100000

COPY scripts/install-openvino-runtime.mjs ./scripts/install-openvino-runtime.mjs
RUN (cd node_modules/bcrypt && PREBUILDS_ONLY=1 node ../node-gyp-build/build-test.js) \
    && (cd node_modules/bufferutil && PREBUILDS_ONLY=1 node ../node-gyp-build/build-test.js) \
    && node scripts/install-openvino-runtime.mjs

COPY . .
RUN node scripts/write-release-metadata.mjs \
    && rm -rf .git \
    && yarn build

FROM node:24-bookworm-slim
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The builder needs the complete source tree, tests, and validation fixtures.
# The runtime image intentionally receives only the standalone server, static
# assets, and the model files used by the application.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/models/visual-search ./models/visual-search

# Execute all pinned models against the final standalone runtime. Keeping this
# gate in the Dockerfile also protects an update launched by an older updater.
COPY --from=builder /app/scripts/openvino-runtime-probe.cjs /tmp/openvino-runtime-probe.cjs
RUN node /tmp/openvino-runtime-probe.cjs \
    && rm -f /tmp/openvino-runtime-probe.cjs

RUN mkdir -p /app/auth /app/config /app/logs /app/storage /app/update-control \
    && chown -R node:node /app/auth /app/config /app/logs /app/storage /app/update-control

EXPOSE 3000
USER node
CMD ["node", "server.js"]
