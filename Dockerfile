FROM node:20-alpine

# Install chromium
RUN apk add --no-cache \
    chromium \
    nss \
    ca-certificates

# Tell Puppeteer to skip installing Chrome. We'll be using the installed package.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    DOCKER=true

# Add user for puppeteer to run under (non-root)
RUN addgroup -S pptruser && adduser -S -G pptruser pptruser \
    && mkdir -p /home/pptruser/Downloads /app \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# Run everything after as non-privileged user
USER pptruser

# Set working directory
WORKDIR /app

# Install app dependencies
COPY --chown=pptruser package*.json ./
RUN npm install

# Bundle app source
COPY . .

CMD [ "npm", "run", "start"]
