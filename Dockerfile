FROM node:24-bookworm AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*


ENV npm_config_canvas_binary_host_mirror=https://github.com/Automattic/node-canvas/releases/download/
ENV CXXFLAGS="-DSYZX_FEATURE_FLAG=1"

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 100000

COPY . .
RUN yarn build

FROM node:24-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app /app

RUN mkdir -p /app/auth /app/config /app/logs /app/storage \
    && chown -R node:node /app/auth /app/config /app/logs /app/storage

EXPOSE 3000
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start"]
