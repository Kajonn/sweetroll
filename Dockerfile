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
ENV NODE_ENV=production
WORKDIR /app
# I7b Task 1: validated image originals live on local disk. The directory is
# created writable for the runtime user and declared as a volume below so
# container restarts never drop uploaded bytes.
RUN mkdir -p /app/data/media && chown node:node /app/data/media
USER node
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=web-build /app/web/dist ./web/dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node migrations ./migrations
VOLUME /app/data/media
EXPOSE 3000
CMD ["npm", "run", "start:http"]
