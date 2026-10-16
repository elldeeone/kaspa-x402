FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app
COPY --chown=node:node dist/relay.mjs /app/relay.mjs
USER node
EXPOSE 8789
CMD ["node", "/app/relay.mjs"]
