# Contribuir a drop

Gracias por querer echar una mano. Este documento es lo que hace falta saber para que un
cambio entre sin ida y vuelta: cómo montar el entorno, cómo probar lo que tocas y qué
convenciones sigue el repositorio.

## Montar el entorno

Solo hace falta **Node.js >= 18** (el CI y los binarios usan la 22).

```bash
git clone https://github.com/Oloxx/drop.git
cd drop
npm install

npm run dev        # http://localhost:3000, recarga sola al guardar
```

No hay base de datos, ni servicios externos, ni claves que pedir: las salas viven en memoria
del proceso y los archivos nunca pasan por el servidor.

Para probar el CLI sin compilar nada:

```bash
npm run cli -- send fichero.zip
npm run cli -- recv 4271-lemon-radar-tiger-orbit
```

## Tests

```bash
npm test
```

La suite arranca su propio servidor de señalización en un puerto libre y lo apaga al terminar,
así que **no hay que levantar nada antes**. Un caso suelto:

```bash
node --test --test-name-pattern "NOT_FOUND" test/signaling.test.mjs
```

Todo cambio de comportamiento necesita un test. Los que hay ya marcan el tono: cada uno explica
en un comentario **qué se rompió o qué se rompería** si eso dejara de cumplirse, no lo que hace
la línea de abajo.

Si tocas rendimiento (troceado, contrapresión, el bucle de acuses), los números salen de los
benchmarks, y **hay que comparar medianas de tres ejecuciones**: la dispersión entre ejecuciones
es de ~1 MB/s y una sola no dice nada.

```bash
npm run bench        # transferencia real entre dos pestañas de Chrome
npm run bench:cli    # TCP nativo entre dos procesos del CLI
npm run bench:fanout # cadena de reenvío con varios receptores
```

Los benchmarks necesitan un servidor levantado (`npm run dev`) y, los de navegador, Chrome
instalado (`CHROME_PATH` si no está donde se espera).

## Convenciones

**Idiomas.** El código, los comentarios, los commits, las issues y los PR van en **español**.
Cada superficie habla un solo idioma, decidido y sin mezclar:

- la **web** va en **inglés**, en minúscula y escueta (`open channel`, `transmitting…`,
  `delivered`);
- el **CLI** va en **español**, incluidos sus errores;
- el código compartido que produce texto para el usuario (`public/shared/codes.js`) recibe
  el idioma como parámetro (`parseCode(input, { lang })`) en vez de imponer uno: la web pasa
  `en` y el CLI usa el `es` por defecto.

No es capricho: mezclarlo ya pasó y quedó a medias (#41).

**Comentarios.** Se comenta el *porqué*, no el *qué*. Un comentario que repite el nombre de la
función sobra; uno que dice "esto no puede ir en el canal directo porque adelanta a los últimos
trozos y cierra el archivo a medias" es el que evita que alguien lo simplifique dentro de seis
meses. Si algo parece rebuscado y no lo es, explica el caso que lo justifica.

**Commits.** [Conventional Commits](https://www.conventionalcommits.org/es/), en español y en
imperativo:

```
fix(cli): cerrar el descriptor en finally para no filtrarlo al fallar

Cuerpo opcional: qué pasaba antes, por qué se arregla así y no de otra
forma. Las referencias a issues, al final.

Cierra #21.
```

Tipos en uso: `feat`, `fix`, `sec`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.

**Pull requests.** Uno por tema, contra `main`. En el cuerpo: qué problema resuelve, qué se ha
verificado y cómo. Si cierra issues, usa las palabras clave en inglés (`closes #21`) — GitHub no
entiende "cierra #21" y la issue se queda abierta.

El CI ejecuta la suite en Linux, macOS y Windows, y tiene que estar en verde antes de mezclar:
un push a `main` despliega a producción.

**Dependencias.** La web hace **cero peticiones a terceros** y así se queda: la fuente está
servida desde `public/fonts/`, no hay CDN ni analítica. En el servidor hay dos dependencias
(`express` y `ws`) y en el CLI ninguna. Añadir una tiene que justificarse; casi siempre la
respuesta es la biblioteca estándar de Node.

**Antes de tocar el protocolo o la cadena de reenvío**, lee las cabeceras de
[`public/app.js`](public/app.js) y [`cli/src/transfer.js`](cli/src/transfer.js). Documentan las
decisiones que parecen simplificables y no lo son -- por qué los trozos y los mensajes de
control van por canales distintos, por qué un relay tiene que volver a trocear lo que reenvía --
y cada una está ahí porque romperla costó una tarde.

## Seguridad

Si encuentras un fallo con impacto en seguridad, **no abras una issue pública**: escribe por
[advisory privado](https://github.com/Oloxx/drop/security/advisories/new). Lo que trata el
proyecto como parte de su modelo de amenazas está en el README; en resumen: el
servidor no ve los archivos, el token de sala es un secreto que viaja en el fragmento de la URL,
y las releases van firmadas.

## Licencia

Al contribuir aceptas que tu código se publique bajo la [Apache License 2.0](LICENSE), que es la
del proyecto.
