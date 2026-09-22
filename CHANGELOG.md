# Changelog

Todos los cambios publicados de **drop**, de más reciente a más antiguo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado es
[SemVer](https://semver.org/lang/es/). Mientras la versión mayor sea `0`, una versión menor
puede romper compatibilidad; cuando pasa, se dice aquí.

Las notas de cada release, con los binarios, están en
[Releases](https://github.com/Oloxx/drop/releases).

## [Sin publicar]

> **Rompe compatibilidad con la v0.9.x:** el protocolo pasa a la versión 5 (selección de
> archivos). Un `drop` viejo y uno nuevo se rechazan con un mensaje que pide `drop update`.

### Añadido
- **Bajar solo parte del envío** (#10). En la web cada archivo de la oferta tiene su casilla,
  todas marcadas, con `select none`/`select all`; **receive** baja lo marcado y lo demás queda
  tachado. En el CLI, `drop recv <código> --only "*.jpg,fotos/**"`: un patrón sin `/` casa con
  el nombre en cualquier carpeta, con `/` con el final de la ruta, con `/` delante desde la raíz;
  `*` no cruza carpetas y `**` sí. Si no casa nada no se descarga y se enseña qué trae el envío.
  La elección viaja como índices del manifiesto (`files` en `accept`, `ready` y `cli-accept`), el
  emisor solo manda eso, y el progreso, los acuses y "entregado" cuentan lo pedido. Un `.part` de
  un archivo no pedido no se toca. En la cadena de reenvío solo se encadena a quien ha elegido
  lo mismo.
- **Rompe compatibilidad:** `PROTOCOL_VERSION` sube a 5. Un emisor v4 ignoraría `files` y
  mandaría el lote entero a quien ha pedido tres archivos.
- **Reanudar en las combinaciones con navegador** (#58).
  - **Web → CLI:** la pestaña ya no ignora los `.part` del `drop recv`. Comprueba cada prefijo contra
    su archivo (SHA-256, como el CLI) y sigue desde ahí; si no es suyo, lo manda entero y el receptor
    lo guarda con otro nombre sin tocar el `.part`. Mientras hashea un prefijo grande (en JS, ~80 MB/s)
    le manda `cli-wait` al receptor cada 5 s para que no salte su reloj de 60 s.
  - **Receptor web con carpeta elegida, desde la web o desde el CLI:** se retoma por archivo. Lo que ya
    está entero en la carpeta se hashea, se ofrece en el `resume` del `accept`/`cli-accept`, y si el
    emisor confirma que es el suyo no vuelve a bajar. A mitad de un archivo no se puede: File System
    Access solo escribe al nombre bueno al cerrar, así que un corte no deja nada. El README lo explica.
- **Accesibilidad básica en la web.**
  - El gris de texto secundario (`--muted`) pasa de `#565f89` (2,8:1 sobre el fondo) a `#828bb8`
    (4,7:1 o más), de la misma familia Tokyo Night. `test/a11y.test.mjs` calcula el contraste de
    todos los colores de texto sobre los tres fondos y falla por debajo de 4,5:1.
  - La zona de soltar se alcanza con Tab: el selector de archivos estaba `hidden` y ahora está
    oculto solo a la vista, con el foco pintado en la zona entera.
  - Un lector de pantalla oye lo importante aunque el foco esté en otra parte: la llegada de una
    oferta y el final o el fallo de cada transferencia (`aria-live`), sin los porcentajes. Las
    barras son `progressbar` con su valor, los errores `role="alert"` y cada × dice qué quita.
  - `prefers-reduced-motion` también para la animación de la barra de tamaño desconocido.
- **Política de compatibilidad** en `docs/COMPATIBILITY.md`: el protocolo 5 es el de toda la
  1.x, qué más se congela (señalización, formato del código, órdenes y flags del CLI, variables
  del servidor) y cómo se añaden cosas sin romper: lo desconocido se ignora, lo nuevo es
  opcional y lo que obliga al otro extremo se anuncia en `features`, un campo reservado desde ya.
  `test/compat.test.mjs` comprueba que los receptores y emisores de hoy ignoran campos, marcos y
  capacidades que no conocen, y falla si el número cambia antes de la 2.0.
- **El cliente web tiene un test de extremo a extremo en la suite** (`test/web.test.mjs`):
  dos pestañas de Chrome, un archivo de 6 MB, la misma huella en las dos y SHA-256 al final.
  Se salta sin Chrome; el CI lo exige en Linux con `DROP_REQUIRE_CHROME=1`.
- **`drop completion bash|zsh|fish|powershell`** imprime el autocompletado del shell: órdenes,
  los flags que valen para cada una, carpetas tras `-o` y archivos tras `send`. No toca ningún
  perfil por su cuenta. Un test saca todos los flags del parser y falla si alguno falta en
  `--help` o en la tabla del autocompletado.
- `docs/PROTOCOL.md`: el protocolo web entero (señalización, DataChannel, cadena de reenvío,
  reparación) en un documento, con lo que se congela en la 1.0 y lo que se puede extender.

### Eliminado
- `fly.toml`. Nunca se probó y ningún workflow lo usaba; el despliegue es el de `DEPLOY-VPS.md`,
  que ahora dice por qué es una sola instancia a propósito.

### Corregido
- **El receptor web podía comprobar un archivo con el hash del siguiente.** El `end` calculaba el
  SHA-256 dentro de la cola de escrituras, y si el `start` del archivo siguiente llegaba antes de que
  se vaciara, ya había cambiado el hasher. Con escrituras a disco lentas daba un falso error de
  integridad. Ahora se coge el hasher al recibir el `end`.
- **`retry` en la web contra un `drop send` por relay reenviaba con los índices corridos.** El
  emisor mandaba `files.slice(i)` y el `cli-start` del archivo `i` salía como índice 0, así que
  la pestaña marcaba como verificado el archivo equivocado. Ahora reenvía por índice del
  manifiesto, y solo lo que el receptor había pedido.
- **El receptor web ya no se queda en `handshake…` para siempre.** Si el emisor cierra la
  pestaña antes de que se acepte, si ICE falla sin ruta ni TURN, o si el servidor cae antes de
  que abra el DataChannel, se retira la oferta y se explica qué ha pasado, con el cuadro para
  teclear otro código. Con el canal ya abierto la transferencia sigue aunque el servidor
  desaparezca, y el emisor avisa de que el código ha dejado de valer para receptores nuevos.

## [0.9.0] — 2026-09-20

> **Rompe compatibilidad con la v0.8.x:** el protocolo pasa a la versión 4 (tamaño desconocido).
> Un `drop` viejo y uno nuevo se rechazan con un mensaje que pide `drop update`, y la web
> rechaza a un CLI de la v0.8 al recibir.

### Añadido
- **Enviar por tubería** con `drop send -` (#29). Lee de la entrada estándar y lo manda según
  llega, sin archivo temporal y sin saber cuánto va a ocupar: `tar czf - proyecto/ | drop send -
  --name proyecto.tgz` en un lado y `drop recv <código> -o - | tar xzf -` en el otro. `--name`
  pone el nombre con el que llega (por defecto `stdin`). Como una tubería no se rebobina, el
  envío sirve a un solo receptor y cierra el canal al terminar; si el receptor se cae a medias el
  emisor sale con error en vez de esperar a otro. El SHA-256 se calcula sobre la marcha y se
  verifica al final como siempre. Sin total, la barra del CLI enseña solo bytes y velocidad, y
  la web pinta el archivo como `stream` con una barra rayada.
- **Descarga en streaming sin File System Access** (#55). Donde no hay `showDirectoryPicker`
  (Firefox, Safari de escritorio y todo iOS) el receptor web acumulaba el archivo entero en
  memoria y una pestaña moría sin mensaje con un vídeo grande. Ahora un Service Worker
  (`public/sw.js`, sin dependencias) sirve la descarga como respuesta HTTP en streaming: la
  página lo alimenta trozo a trozo con contrapresión por créditos y el navegador escribe a
  Descargas según llega, con memoria constante. Se usa a partir de 32 MB o sin tamaño
  conocido; si el SHA-256 no cuadra la respuesta se rompe y el navegador marca la descarga
  como fallida. Sin worker (contexto no seguro, navegador antiguo) se sigue por Blob. El worker
  no cachea nada y solo contesta a `/__drop-download/…`; la CSP no cambia.
- **IPv6 en las rutas directas** (#37, primera mitad). Las direcciones IPv6 globales y únicas
  locales (`fc00::/7`, la de una VPN tipo Tailscale) van en las candidatas de la oferta junto a
  las IPv4, el emisor escucha en las dos familias (`::`, con vuelta a `0.0.0.0` si el sistema no
  tiene IPv6) y el receptor las ordena con las demás y las sondea escalonadas. En una red solo
  IPv6 ya hay ruta directa en vez de caer siempre al relay. El formato de `ips` no cambia:
  cadenas sueltas sin campo de familia, y así se queda para la 1.0. Falta el descubrimiento
  local por multicast IPv6 (sigue en #37).
- **Rompe compatibilidad:** `PROTOCOL_VERSION` sube a 4. Un archivo del manifiesto (por TCP y
  en `cli-manifest`/`cli-start` por relay) puede llevar `size: null`; un receptor v3 se creería
  el total y acabaría con `NaN` en la barra y sin mandar el último acuse, así que se rechaza.

## [0.8.0] — 2026-09-20

> **Rompe compatibilidad con la v0.3.5:** el token largo (`T_9q_4uzB9iJAf8x`) deja de existir
> en las tres partes. `PROTOCOL_VERSION` no cambia: una v0.7.x y una v0.8.0 se siguen hablando.

### Eliminado
- **El camino de la v0.3.5.** El servidor ya no sirve tokens de 96 bits a quien no pide
  `v:2`: contesta `VERSION` y cierra. `parseCode` y `splitForKey` no reconocen el token viejo
  (`legacy` desaparece de lo que devuelven), `deriveKey` pierde la rama HKDF y el CLI el aviso
  de "código en formato antiguo". Estaba marcado `@deprecated` desde la v0.4.0 para irse en la
  v0.5.0. `/speed` sigue teniendo un identificador largo, pero lo pide con `link: true`.

### Añadido
- **Cuota de caudal para el relay WebSocket** (#56). `DROP_RELAY_LIMIT` (por sala) y
  `DROP_RELAY_LIMIT_TOTAL` (todo el proceso), en `10M`, `500K`, `1.5G` como `--limit`. Al
  pasarse el servidor pausa el socket el tiempo justo y el emisor se frena por contrapresión:
  ninguna transferencia se corta, llega entera y más despacio. Sin definir no cambia nada.
  Están en `.env.example`, en `docker-compose.yml` y en `DEPLOY-VPS.md`.
- **Métricas en `/healthz`:** salas e invitados activos, salas abiertas desde el arranque,
  bytes y frames relayed, veces que ha saltado la cuota y rechazos por motivo (`NOT_FOUND`,
  `RATE_LIMITED`, `ROOM_FULL`, `VERSION`…). Viven en el proceso y vuelven a cero al reiniciar.
- **Vista para navegadores sin WebRTC.** Sin `RTCPeerConnection` (Tor Browser, Firefox con
  `media.peerconnection.enabled=false`) la web explica el motivo y enseña el código que venía
  en el enlace para abrirlo en otro navegador o con el CLI, en vez de fallar al abrir el canal.
- `SECURITY.md`: cómo reportar, qué versiones tienen soporte y el modelo de amenazas en corto.
- Checklist de release en `CONTRIBUTING.md`.
- `npm audit --omit=dev --audit-level=moderate` en el CI, y un guardia para que `dependencies`
  siga teniendo dos entradas.

### Cambiado
- La tabla de interoperabilidad del README dice qué combinación reanuda un corte, y la de
  "Dos modos de uso" ya no afirma que la compatibilidad es solo CLI → Web.
- `express` arrastraba un `qs` con dos avisos moderados; `package-lock.json` actualizado.

## [0.7.1] — 2026-09-14

### Corregido
- `drop --help` fallaba en los binarios de la 0.7.0 por un acento grave suelto en el texto de
  ayuda; el workflow de release lo detectó y la 0.7.0 no llegó a publicarse. Esta es la misma
  versión con ese arreglo y un test que arranca la ayuda.

## [0.7.0] — 2026-09-14

> **Rompe compatibilidad con la v0.6.x:** el protocolo pasa a la versión 3 (reanudación).
> Un `drop` viejo y uno nuevo se rechazan con un mensaje que pide `drop update`.

### Añadido
- **Reanudar transferencias cortadas** en el CLI (#21). Si se cae la conexión (o se mata el
  receptor) el `.part` se queda con lo que llegó, y el siguiente `drop recv` con el mismo código
  sigue desde ahí, por TCP directo y por relay. El emisor comprueba antes que el prefijo es de
  su archivo (SHA-256 de los primeros bytes) para no coser dos descargas distintas: si no
  cuadra, se manda entero a `nombre (2).ext` y el `.part` ajeno no se toca. `--no-resume`
  fuerza empezar de cero. La barra de progreso arranca donde se quedó y la velocidad media no
  cuenta lo que ya estaba en disco.
- **Rompe compatibilidad:** `PROTOCOL_VERSION` sube a 3. Por TCP directo el receptor contesta
  al manifiesto con `ready` (los `.part` que tiene) y el emisor abre cada archivo con `start` y
  su offset; por relay va lo mismo en `cli-accept` y `cli-start`. Un emisor web ignora la
  petición y manda desde cero, como hasta ahora.

## [0.6.0] — 2026-09-13

> **Rompe compatibilidad con la v0.5.x:** el protocolo pasa a la versión 2 (relay cifrado).
> Un `drop` viejo y uno nuevo se rechazan con un mensaje que pide `drop update`.

### Seguridad
- **El relay va cifrado de extremo a extremo.** Cuando no hay TCP directo (o el receptor es un
  navegador) los archivos pasaban por el servidor en claro; ahora cada trozo y cada marco de
  control viajan en AES-256-GCM con la clave scrypt del código. El navegador deriva esa clave con
  una implementación propia de scrypt (`public/shared/scrypt.js`) y la prueba de conocimiento del
  código pasa a ser un HMAC con la clave, no un hash de las palabras (#3).
- **Rompe compatibilidad:** `PROTOCOL_VERSION` sube a 2. Un `drop` anterior y uno nuevo se
  rechazan mutuamente con un mensaje que pide actualizar, en vez de entenderse a medias.

### Añadido
- **Carpetas enteras**, en el CLI (`drop send fotos/`) y en la web (arrastrar una carpeta o
  *pick a folder*): cada archivo viaja con su ruta relativa (`path` en el manifiesto) y el
  receptor recrea el árbol; el CLI acepta esas rutas solo hacia abajo (`safeOutputPath`) y
  la web las crea con `getDirectoryHandle` tramo a tramo (#5).
- **Web → CLI:** `drop recv` ya recibe de un canal abierto desde el navegador. El CLI se
  presenta como tal al entrar en la sala (`name: 'cli'` en el join) y la página le sirve por el
  relay del servidor con el mismo protocolo y cifrado que usa `drop send` hacia un navegador:
  la matriz de interoperabilidad queda completa (#27).
- Código QR del enlace, generado sin dependencias en `public/shared/qr.js` (ISO 18004, modo
  bytes, versiones 1-40, mascara por penalización): botón **qr** junto al enlace en la web (#4)
  y pintado con caracteres de bloque bajo el código en `drop send`, solo en una terminal y
  con `--no-qr` para quitarlo (#35).
- La web avisa al terminar una transferencia: una campanita sintetizada con la Web Audio API
  (sin ficheros de audio, sigue sin haber peticiones a terceros) y una notificación del
  sistema si la pestaña no está a la vista. Interruptor `alerts on/off` en la cabecera (#9).
- `--limit 10M` (`500K`, `1.5G`) limita el ancho de banda en el emisor y en el receptor, con un
  cubo de fichas que admite déficit para que un trozo mayor que la tasa no se atasque (#36).
- Progreso por archivo además del total, en el CLI (una línea `[2/5] foto.jpg 45% · 1,2 MB /
  5 MB` encima de la barra, solo con varios archivos) y en la web (en la fila de progreso). Sale
  del acumulado y del manifiesto, así que vale igual para emisor y receptor (#33).
- `drop send --text "..."` y `--clipboard` envían un fragmento sin crear un archivo antes, y
  `drop recv --stdout` (o `-o -`) vuelca lo recibido por la tubería con los mensajes en stderr
  (#34).
- `drop send --once` cierra el canal tras la primera descarga completa y `--expire 10m` lo
  hace caducar solo (`90s`, `10m`, `2h`). Ninguno corta una descarga en curso: se deja de
  aceptar gente y se sale al terminar (#28).
- `npm run bench:webrelay`: transferencia real `drop send --relay` → Chrome, comprobando el
  SHA-256 y que la huella coincide en los dos lados.
- Tests en Linux, macOS y Windows antes de desplegar a producción, y la suite arranca su propio
  servidor de señalización: `npm test` ya no necesita nada levantado a mano (#22, #23).
- `LICENSE` (Apache 2.0), `CONTRIBUTING.md` y este `CHANGELOG.md` (#31).
- El despliegue recrea Caddy cuando cambia su configuracion: el bind-mount de un fichero suelto
  ata el montaje al inode y el contenedor seguia sirviendo el Caddyfile viejo.
- Cabeceras de seguridad en todas las respuestas: CSP ajustada a lo que la web usa de verdad,
  `X-Content-Type-Options`, `Referrer-Policy` y `Permissions-Policy`; HSTS en Caddy (#30).

### Cambiado
- Un solo idioma por superficie: la web entera en inglés (se han ido los `verificado`,
  `reintentar` y `Discrepancia de integridad` sueltos) y el CLI en español; los errores de
  código inválido de `public/shared/codes.js` salen en el idioma de quien los pide
  (`parseCode(input, { lang })`) (#41).
- La versión del CLI sale solo del `package.json` y esbuild la mete en el binario al compilar:
  se acabó la constante escrita a mano que descuadraba `drop update` (#26).
- El contenedor corre como el usuario `node`, sin privilegios, y declara un `HEALTHCHECK` (#30).
- Una sola implementación de SHA-256, en `public/shared/sha256.js`, que comparten la web y sus
  tests: antes el test validaba una copia del código (#25).

## [0.5.2] — 2026-09-11

### Añadido
- **Releases firmadas con Ed25519** en formato minisign. Cada release lleva `SHA256SUMS` y
  `SHA256SUMS.minisig`: el hash dice que el binario llegó entero, la firma dice quién lo
  publicó (#16).
- `drop update` **rechaza una release sin firma**; `--allow-unsigned` es el escape para las
  anteriores a esta versión.

## [0.5.1] — 2026-09-10

### Añadido
- **TURN efímero**: `/config` firma credenciales que caducan (12 h por defecto) en vez de
  repartir un usuario y una contraseña perpetuos, con lo que el relay dejaba de ser propio
  (#2).
- **Cuotas en el servidor de señalización**: salas por IP y minuto, receptores por sala, salas
  totales, caducidad por inactividad y un cubo de mensajes por socket. `maxPayload` baja de los
  100 MiB que trae `ws` por defecto a 256 KiB (#7).
- **Huella corta de sesión (SAS)** para detectar a un intermediario comparando cuatro palabras
  por otro canal, y confirmación explícita del emisor antes de servir a un receptor (#14, #15).

### Corregido
- El CLI cierra el descriptor del archivo en `finally`, y deja de avisar de `DEP0137`.

## [0.5.0] — 2026-09-06

### Corregido
- **Path traversal y sobrescrituras en el receptor**: los nombres que llegan en el manifiesto se
  sanean antes de tocar el disco, cada archivo se escribe en `.part` y solo se renombra cuando
  el SHA-256 cuadra (#17, #18, #19).
- Errores legibles en lugar de volcados de pila: `EADDRINUSE`, código equivocado, versión de
  protocolo distinta.

## [0.4.2] — 2026-09-05

### Corregido
- El mapeo UPnP se renueva periódicamente, se limpia al salir y reintenta si el puerto está
  cogido.

## [0.4.1] — 2026-09-05

### Corregido
- Path traversal en el receptor del CLI.
- El relay se colgaba al pasar de 8 MB: el receptor no acusaba recibo y el emisor se quedaba
  esperando con la ventana llena.

## [0.4.0] — 2026-09-05

### Añadido
- **Códigos de sala memorizables** del tipo `4271-lemon-radar-tiger-orbit`, que se pueden dictar
  por teléfono.
- **Releases automáticas** al empujar un tag: los cinco binarios se compilan y **se ejecutan** en
  su plataforma nativa antes de publicarse, con checksums y firma ad-hoc en macOS.

### Corregido
- El blob SEA se genera con el Node exacto de los binarios base: mezclarlos producía ejecutables
  que morían al arrancar en todas las plataformas a la vez.

## [0.3.5] — 2026-09-04

### Añadido
- **Mapeo automático de puertos por UPnP** y detección de la IP pública, para conexiones
  directas por internet sin tocar el router.
- Sondeo concurrente al estilo *Happy Eyeballs*: se prueban en paralelo LAN, VPN y WAN y se
  adopta la primera que responde.
- `-p, --port` para fijar el puerto de escucha.

## [0.3.4] — 2026-09-04

### Corregido
- Condiciones de carrera en enlaces de 1 Gbps: cola de mensajes de control persistente para que
  el cambio de fase no se pierda bajo carga.

## [0.3.3] — 2026-09-04

### Cambiado
- El medidor de velocidad deja de cifrar el relleno, que era el cuello de botella en Raspberry
  Pi y equipos ARM: ahora mide la red y no la CPU.

## [0.3.2] — 2026-09-04

### Añadido
- Broadcast UDP por todas las interfaces, para equipos con varias tarjetas de red.

## [0.3.1] — 2026-09-04

### Corregido
- Solapamiento de texto en la consola al reportar la latencia.

## [0.3.0] — 2026-09-04

### Añadido
- **Verificación de integridad SHA-256** de cada archivo en las dos puntas.
- **`drop speed`**: medidor de velocidad entre dos terminales, con RTT, medición en los dos
  sentidos y elección automática entre TCP directo y relay.

## [0.2.4] — 2026-09-03

### Añadido
- Resumen y métricas al terminar una transferencia.

## [0.2.3] — 2026-09-03

### Añadido
- **`drop update`**: comprueba la última release en GitHub y sustituye el binario instalado.
- Los binarios llevan la versión en el nombre.

## [0.2.2] — 2026-09-03

### Cambiado
- El canal del emisor se queda abierto hasta `Ctrl+C`, para que varias personas descarguen a la
  vez o una detrás de otra.
- Ejecutar `drop recv` desde `System32` redirige la descarga a la carpeta de descargas del
  usuario, en vez de fallar con `EPERM`.

## [0.2.1] — 2026-09-03

### Corregido
- El receptor esperaba un mensaje con otro nombre que el que mandaba el emisor.
- Caída automática a relay por WebSocket cuando la ruta directa no es posible.

## [0.2.0] — 2026-09-03

Primera release con binarios autónomos.

### Añadido
- **CLI** de transferencia P2P por TCP con AES-256-GCM, a 100-115 MB/s.
- Ejecutables para las cinco plataformas, sin Node.js instalado, que se añaden solos al PATH.
- **Interoperabilidad CLI ↔ web**: lo enviado desde la terminal se descarga desde cualquier
  navegador.
- Descubrimiento en la red local por broadcast UDP.

[Sin publicar]: https://github.com/Oloxx/drop/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Oloxx/drop/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Oloxx/drop/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Oloxx/drop/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Oloxx/drop/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Oloxx/drop/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Oloxx/drop/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Oloxx/drop/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Oloxx/drop/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/Oloxx/drop/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Oloxx/drop/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Oloxx/drop/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/Oloxx/drop/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/Oloxx/drop/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Oloxx/drop/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Oloxx/drop/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Oloxx/drop/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Oloxx/drop/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/Oloxx/drop/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Oloxx/drop/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Oloxx/drop/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Oloxx/drop/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Oloxx/drop/releases/tag/v0.2.0
