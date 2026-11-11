# Home Assistant add-on image. Build context: the repository root.
#   docker build -f ha-addon/Dockerfile .
FROM node:24-alpine

RUN apk add --no-cache chromium nss ca-certificates ttf-freefont tzdata \
      tinyproxy iptables ip6tables su-exec \
    && adduser -S -D -H -s /sbin/nologin app

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DOCKER=true \
    NODE_ENV=production \
    TZ=Asia/Jerusalem

WORKDIR /app
COPY package.json yarn.lock ./
# No install scripts, no optional MongoDB driver: fewer packages that can run code.
RUN yarn install --frozen-lockfile --production --ignore-optional --ignore-scripts \
    && yarn cache clean
COPY src ./src

COPY ha-addon/run.sh ha-addon/tinyproxy.conf ha-addon/allowlist /etc/shekel/
RUN chmod 0755 /etc/shekel/run.sh

CMD ["/etc/shekel/run.sh"]
