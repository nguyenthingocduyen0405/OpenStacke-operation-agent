FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js rag.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 3000
CMD npm start
