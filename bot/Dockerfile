FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# Headless Chromium for infographic re-rendering (INFOGRAPHIC_TRANSLATION=1),
# plus fonts for every mirrored script: Noto Sans (Latin/Cyrillic/Vietnamese)
# and Noto CJK (Chinese, Japanese, Korean). Sora is embedded from node_modules.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates font-noto font-noto-cjk fontconfig \
 && fc-cache -f
ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium-browser
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Images the bot attaches at runtime, such as the UID guide.
COPY --from=build /app/assets ./assets
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
