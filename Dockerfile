FROM node:22.22.2-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && mkdir -p /data \
  && chown -R node:node /app /data

COPY src ./src
RUN chown -R node:node /app/src

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/misskey-to-x.sqlite
ENV PATH=/app/node_modules/.bin:$PATH

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
