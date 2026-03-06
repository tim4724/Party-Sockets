FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json server.ts ./
RUN bun build server.ts --target=bun --outfile=server.js

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/server.js .
EXPOSE 3000
ENV PORT=3000
CMD ["bun", "run", "server.js"]
