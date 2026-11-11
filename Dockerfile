FROM node:24-alpine

# Install chromium
RUN apk add --no-cache \
    chromium \
    nss \
    ca-certificates \
    ttf-freefont

# Tell Puppeteer to skip installing Chrome. We'll be using the installed package.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DOCKER=true \
    NODE_ENV=production

# Add user for puppeteer to run under (non-root)
RUN addgroup -S pptruser && adduser -S -G pptruser pptruser \
    && mkdir -p /home/pptruser/Downloads /app \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# Run everything after as non-privileged user
USER pptruser

# Set working directory
WORKDIR /app

# Install app dependencies (no install scripts: fewer packages that can run code at build time)
COPY --chown=pptruser package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production --ignore-scripts && yarn cache clean

# Bundle app source (never .env: .dockerignore is a whitelist)
COPY src ./src

CMD [ "node", "src/app.js"]
