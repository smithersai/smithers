FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/tutorial-executor/src/executor.ts /app/executor.ts
COPY apps/tutorial-executor/src/regression.mjs /app/regression.mjs
COPY apps/app/src/mainview/state/practice/hello-server/snapshot.json /app/snapshot.json
RUN mkdir /workspace && chown 10001:10001 /workspace
USER 10001:10001
EXPOSE 3001
CMD ["node", "--experimental-strip-types", "/app/executor.ts"]
