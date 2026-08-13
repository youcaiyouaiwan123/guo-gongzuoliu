FROM node:22-alpine
WORKDIR /app
COPY server.mjs collector.mjs ./
USER node
EXPOSE 8789
CMD ["node", "server.mjs"]
