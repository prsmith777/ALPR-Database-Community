FROM node:24-bookworm AS builder
WORKDIR /app

ENV CXXFLAGS="-DSYZX_FEATURE_FLAG=1"

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 100000

COPY . .
RUN yarn build

FROM node:24-bookworm-slim
WORKDIR /app

COPY --from=builder --chown=node:node /app /app

RUN mkdir -p /app/auth /app/config /app/logs /app/storage \
    && chown -R node:node /app/auth /app/config /app/logs /app/storage

EXPOSE 3000
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start"]
