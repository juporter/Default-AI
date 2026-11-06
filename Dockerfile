# Container image for hosting Default AI Prompt (used by fly.toml; works on any
# Docker host). No npm install step: the app has no dependencies.
# Node 22 (22.13 or newer) is needed for the built-in SQLite that billing uses.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app
COPY . .
RUN mkdir -p /data

EXPOSE 8080

# A freshly mounted volume (Fly.io mounts one at /data) is owned by root, so
# start as root just long enough to hand /data to the unprivileged "node"
# user, then run the app as "node".
CMD ["sh", "-c", "chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups node server.js"]
