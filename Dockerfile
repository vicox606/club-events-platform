FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
# Vite is a build dependency, so install all dependencies for the build stage.
RUN npm install --no-save vite @vitejs/plugin-react --no-audit --no-fund
COPY . .
RUN npm run build && mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4000
CMD ["node","server/index.js"]
