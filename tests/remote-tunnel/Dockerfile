FROM node:22-alpine

RUN apk add --no-cache openssh-server

COPY entrypoint.sh /usr/local/bin/remote-tunnel-test-entrypoint
COPY server.mjs /opt/remote-tunnel-test/server.mjs

RUN chmod 755 /usr/local/bin/remote-tunnel-test-entrypoint

EXPOSE 22 3456

HEALTHCHECK --interval=1s --timeout=2s --retries=30 \
  CMD wget -q -O /dev/null "http://127.0.0.1:3456/api/auth?token=test-token"

ENTRYPOINT ["remote-tunnel-test-entrypoint"]
