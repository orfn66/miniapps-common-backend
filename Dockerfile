FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node admin ./admin

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
