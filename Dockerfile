FROM node:22.22.2-alpine3.22

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && mkdir -p /data \
  && chown -R node:node /app /data

COPY --chown=node:node src ./src

ENV PORT=3000
ENV DATABASE_PATH=/data/misskey-to-x.sqlite

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
