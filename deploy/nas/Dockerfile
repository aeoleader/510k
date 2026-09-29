# 5-10-K in a container, for a home NAS (Synology Container Manager) or any Docker host.
# Build context: the folder made by deploy/nas/bundle.sh (app/ holds the game, no npm dependencies).
FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY app/ ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && mkdir -p /data
ENV NODE_ENV=production PORT=3200 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 3200
# SIGTERM makes the server save live rooms; they are restored on the next start.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/entrypoint.sh"]
