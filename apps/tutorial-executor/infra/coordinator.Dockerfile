FROM node:22.19.0-bookworm-slim
WORKDIR /app
COPY server.mjs /app/server.mjs
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 3000
CMD ["node", "/app/server.mjs"]
