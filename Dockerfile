FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json server.ts ./
RUN bun build server.ts --target=bun --outfile=server.js

FROM oven/bun:1-alpine
RUN addgroup -g 1001 app && adduser -u 1001 -G app -s /bin/sh -D app
WORKDIR /app
COPY --from=build /app/server.js .
USER app
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["bun", "run", "server.js"]
