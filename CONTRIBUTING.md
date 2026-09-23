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

## Publicar una versión

Una release son dos commits y un tag; el workflow `release.yml` hace el resto (compila los
cinco binarios, firma `SHA256SUMS`, verifica la firma con el `minisign` real y publica). Lo que
no puede comprobar la máquina va en esta lista, en este orden:

1. **`npm test` en verde en las tres plataformas.** Localmente pasa en una; el CI de la PR
   cubre las otras dos. No se etiqueta con la matriz en rojo.
2. **Si cambia el protocolo:** dentro de la 1.x `PROTOCOL_VERSION` no se sube. Lo nuevo va
   como campo opcional, marco que el otro ignora o capacidad anunciada en `features`, con las
   reglas de [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md). Algo que no quepa ahí es una
   2.0: se sube el número, se anuncia en el `CHANGELOG` con una versión menor de antelación y
   se cambia a la vez `test/compat.test.mjs`. Un cambio de protocolo sin subir el número deja
   dos versiones entendiéndose a medias, que es peor que rechazarse.
3. **`CHANGELOG.md`:** mueve *Sin publicar* a una sección `[X.Y.Z] — AAAA-MM-DD` y deja
   *Sin publicar* vacía.
4. **`README.md`:** los enlaces de descarga apuntan a la versión nueva
   (`test/version.test.mjs` lo comprueba). La prosa que nombra versiones concretas ("a partir de
   la v0.5.2") se deja como está.
5. **`ROADMAP.md`:** marca lo que entra y quita lo que ya no aplica.
6. Commit de docs (`docs: enlaces de descarga y changelog para la vX.Y.Z`) y, encima, el de
   versión con el tag:

   ```bash
   npm version X.Y.Z -m "chore(release): v%s"
   git push --follow-tags
   ```

7. Cuando el workflow termine, **`drop update` desde la versión anterior** en al menos una
   máquina real: es la única prueba de extremo a extremo de la firma y de que el binario
   arranca fuera del CI. `minisign -Vm SHA256SUMS -P <clave del README>` sobre lo descargado
   también vale como comprobación independiente.
8. Abre la web en producción y haz una transferencia entre dos pestañas. El deploy es
   automático con el push a `main`, pero nadie lo ha mirado hasta que alguien lo mira.
9. **Homebrew y Scoop** se ponen al día solos en menos de seis horas: los workflows de
   [`Oloxx/homebrew-tap`](https://github.com/Oloxx/homebrew-tap) y
   [`Oloxx/scoop-bucket`](https://github.com/Oloxx/scoop-bucket) comprueban la firma del
   `SHA256SUMS`, regeneran el manifiesto e instalan de verdad. Para no esperar:
   `gh workflow run update.yml -R Oloxx/homebrew-tap` (y lo mismo con `scoop-bucket`). Si uno se
   pone en rojo, la release no llega a ese gestor hasta arreglarlo.

## Seguridad

Si encuentras un fallo con impacto en seguridad, **no abras una issue pública**: escribe por
[advisory privado](https://github.com/Oloxx/drop/security/advisories/new). El modelo de
amenazas, con lo que cubre y lo que no, está en [SECURITY.md](SECURITY.md).

## Licencia

Al contribuir aceptas que tu código se publique bajo la [Apache License 2.0](LICENSE), que es la
del proyecto.
