FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm --prefix web run build

FROM node:24-alpine
RUN apk add --no-cache su-exec
COPY --chmod=755 scripts/container-entrypoint.sh /usr/local/bin/sweetroll-entrypoint
ENV NODE_ENV=production
WORKDIR /app
# Railway mounts persistent media storage at runtime. Keep the mount point in
# the image so the service also starts cleanly when no volume is attached.
RUN mkdir -p /app/data/media /app/data/display && chown node:node /app/data/media /app/data/display
USER node
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=web-build /app/web/dist ./web/dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node database ./database
EXPOSE 3000
ENTRYPOINT ["sweetroll-entrypoint"]
CMD ["npm", "run", "start:http"]
