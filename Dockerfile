FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# `public/` no es solo estatico: dentro vive `public/shared/`, el modulo de
# codigos de sala que importan a la vez el servidor, el CLI y la web. Si se
# recorta esta copia, `server/index.js` no arranca.
COPY server ./server
COPY public ./public

EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "server/index.js"]
