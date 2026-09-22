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

# La imagen trae un usuario `node` sin privilegios que no se estaba usando: el
# proceso corria como root, asi que cualquier ejecucion de codigo dentro del
# contenedor empezaba con todo. Los ficheros se copian antes y quedan de root,
# que es justo lo que se quiere: el servidor solo tiene que leerlos, y no puede
# reescribir su propio codigo.
USER node

EXPOSE 3000

# `/healthz` hace que Docker sepa si el proceso sigue sirviendo, no solo si sigue vivo: un servidor colgado con el
# bucle de eventos bloqueado no responde y el contenedor pasa a `unhealthy`.
# Sin curl en la imagen, se pregunta con el propio Node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "server/index.js"]
