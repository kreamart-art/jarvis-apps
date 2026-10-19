# jarvis-apps on Coolify: one Node process, the data on a volume at /data (catalog, builds, icons).
# Set APPS_KEY (JARVIS reads with it) and APPS_PUBLISH_KEY (the owner's Mac publishes with it) in Coolify;
# without them every /v1 route answers 503.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
