# build from the repo root, not web/: the build step syncs prompt
# templates from ../shared/prompts
#   docker build -f web/Dockerfile -t wd-web .

FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
# dev deps stay: the react compiler plugin runs at build time
RUN cd web && npm ci
COPY shared ./shared
COPY web ./web
RUN cd web && npm run build

# the runtime image carries only the standalone server: no npm, no
# source, nothing writable. all config comes in through the environment
FROM node:22-alpine
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
