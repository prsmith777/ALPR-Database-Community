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
RUN yarn build

FROM node:24-bookworm-slim
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /app /app

RUN mkdir -p /app/auth /app/config /app/logs /app/storage \
    && chown -R node:node /app/auth /app/config /app/logs /app/storage

EXPOSE 3000
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start"]
