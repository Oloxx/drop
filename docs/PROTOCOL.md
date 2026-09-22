# Protocolo web de drop (señalización + DataChannel)

Lo que hablan dos pestañas de `drop` entre sí, y con el servidor, para mover un lote de archivos.
Es la referencia del código de `public/app.js` y `server/index.js`: si algo de aquí y algo de allí
no cuadran, es un bug en uno de los dos, y esta página es la que dice cuál.

Lo que **no** está aquí: el protocolo del CLI (TCP directo y relay `cli-*`), que se describe en un
solo sitio, encima de `receiveFromRelay` en [`cli/src/transfer.js`](../cli/src/transfer.js). Las
dos cosas se tocan solo en un punto: una pestaña que recibe de un `drop send`, o que envía a un
`drop recv`, deja de usar lo que sigue y pasa a hablar `cli-*` por el WebSocket. Se dice dónde.

Todo lo de aquí es lo que se congela con la 1.0 (ver [ROADMAP](../ROADMAP.md)). Cambiar el
formato de un mensaje, quitar uno o cambiar cuándo se manda cuesta una versión mayor. Añadir un
mensaje nuevo no: los dos lados ignoran los `k` que no conocen (abajo, "Compatibilidad").

## 1. Las tres capas

```
 pestaña emisora                servidor                    pestaña receptora
 ───────────────                ────────                    ─────────────────
   WebSocket  ───── señalización (JSON, ciego) ─────────────  WebSocket
       │                                                            │
   RTCPeerConnection ═══ DTLS/SCTP, directo o por TURN ═══ RTCPeerConnection
       │                                                            │
   DataChannel "drop" ── control (JSON) + trozos (binario) ── DataChannel "drop"
```

1. **Señalización.** Un WebSocket por pestaña contra `server/index.js`. El servidor sólo
   empareja: reparte identificadores de sala y reenvía SDP/ICE de uno a otro sin mirarlos.
   Nunca ve un byte de archivo.
2. **WebRTC.** Una `RTCPeerConnection` por pareja. Los bytes van cifrados por DTLS entre las dos
   pestañas; si no hay ruta directa pasan por coturn (TURN), que tampoco puede leerlos.
3. **DataChannel.** Un canal `drop`, `ordered: true`, por conexión. Encima va el protocolo de
   transferencia de la sección 4.

## 2. El código y la sala

El código es `4271-lemon-radar-tiger-orbit`:

- `4271` es el **identificador de sala**. Lo reparte el servidor y es lo único que le llega.
- Las cuatro palabras son el **secreto**. Las sortea la pestaña emisora (`randomSecretWords`),
  viajan en el fragmento del enlace (`/#<código>`, que el navegador nunca manda al servidor) y
  sirven para dos cosas: demostrarle al emisor que el receptor las conoce (§4.2) y, con el CLI,
  derivar la clave de cifrado. Entre dos pestañas no cifran nada más: el cifrado ya lo pone DTLS.

El diseño completo, con el porqué de cada decisión, está en
[`public/shared/codes.js`](../public/shared/codes.js).

## 3. Señalización (WebSocket)

Todos los mensajes son JSON con un campo `t`. El servidor rechaza y cierra con `error` cualquier
cosa fuera de lo que sigue, y tiene cuotas por IP y por socket ("Server limits" en [CLAUDE.md](../CLAUDE.md)).

### 3.1 Cliente → servidor

| `t`         | Campos                     | Quién     | Qué hace |
|-------------|----------------------------|-----------|----------|
| `host`      | `v: 2`                     | emisor    | Abre una sala. Sin `v: 2` el servidor contesta `error VERSION`: es el cliente diciendo "sé de códigos memorizables". `/speed` manda además `link: true` y recibe un id largo. |
| `join`      | `token`, `name?`           | receptor  | Entra en la sala `token` (el identificador de 4 dígitos). `name` es informativo; `'cli'` es cómo se presenta un `drop recv` y el emisor lo sirve por otro camino (§7). |
| `signal`    | `to?`, `data`              | ambos     | Reenvío ciego de `data` (SDP o ICE). El emisor pone `to` con el `guestId` destino; un receptor sin `to` habla con el emisor, y con `to` con **otro receptor de la misma sala** (así se abren los eslabones de la cadena, §6). El servidor sólo comprueba que `to` esté en la sala. |
| `bad-guest` | `guestId`                  | emisor    | Ese receptor ha fallado la prueba del secreto. El servidor le manda `error BAD_SECRET`, lo echa, y al quinto fallo en la sala (`BAD_GUEST_MAX`) la quema: `BURNED` para todos. |

`data` de un `signal` es `{ sdp: RTCSessionDescription }` o `{ ice: RTCIceCandidate }`. Con un
CLI en la sala también viajan los `cli-*` de `transfer.js`, y los frames **binarios** del
WebSocket son trozos cifrados de ese relay: el servidor los reenvía por la cabecera de 4 bytes
(`guestId`) y nunca los interpreta.

### 3.2 Servidor → cliente

| `t`          | Campos                          | A quién     | Qué significa |
|--------------|----------------------------------|-------------|---------------|
| `hosted`     | `token`, `room`, `v: 2`, `publicIp` | emisor   | La sala está abierta; `token` es el identificador de 4 dígitos. |
| `joined`     | `guestId`, `publicIp`            | receptor    | Estás dentro; `guestId` es tu número en la sala (el emisor es siempre el `0`). |
| `guest`      | `guestId`, `name`, `ip`          | emisor      | Ha entrado alguien. El emisor crea una conexión para él (§4.1). |
| `guest-gone` | `guestId`                        | emisor      | Se ha ido. Llega **al instante**, mucho antes de que WebRTC se entere: es lo que dispara la reparación de la cadena (§6.4). |
| `host-gone`  | —                                | receptores  | El emisor ha cerrado. La sala muere con él; lo que ya esté en vuelo por la cadena puede terminar. |
| `signal`     | `from`, `data`                   | ambos       | Un `signal` reenviado; `from` es `0` (emisor) o el `guestId` de otro receptor. |
| `error`      | `reason`                         | ambos       | Rechazo, y normalmente cierre. `reason` ∈ `NOT_FOUND`, `RATE_LIMITED`, `BAD_SECRET`, `BURNED`, `ROOM_FULL`, `TOO_MANY_ROOMS`, `NO_ROOMS`, `EXPIRED`, `FLOOD`, `VERSION`. Los textos viven en `JOIN_ERRORS`/`HOST_ERRORS` de `app.js` y en `ERRORS` de `cli/src/signaling.js`; un motivo nuevo tiene que existir en los tres sitios o el usuario ve el token pelado. |

### 3.3 Conexiones y quién ofrece

- **El emisor es el host:** una `RTCPeerConnection` **por receptor**, crea el DataChannel y hace
  la oferta. El receptor contesta. `routeSignal()` elige la conexión por `body.dataset.view`.
- Un receptor crea una conexión bajo demanda cuando le llega un `signal` de un `from` que no
  conoce y trae `sdp`: es otro receptor ofreciéndose como su eslabón de arriba (§6). Un `ice`
  huérfano de un `from` desconocido se ignora.
- **ICE antes de la descripción remota se encola** (`conn.pendingIce`) y se aplica después de
  `setRemoteDescription`. Sin la cola, en redes rápidas las candidatas llegan antes y
  `addIceCandidate` falla en silencio.
- La configuración ICE (STUN, y TURN con credencial efímera si el servidor tiene
  `TURN_SECRET`) sale de `GET /config` y se refresca cada hora.

### 3.4 La huella (SAS)

Cada lado calcula, sin mandarla, `sasWords(sha256(sasInput('webrtc', fingerprints)))` con los
fingerprints DTLS de **las dos** descripciones (local y remota), ordenados. Tres palabras. Si el
servidor sustituyera los fingerprints para ponerse en medio, cada extremo vería un certificado
distinto y las huellas no coincidirían. Se enseña antes de aceptar; se compara de viva voz.
Detalle en [`public/shared/sas.js`](../public/shared/sas.js).

## 4. El DataChannel

### 4.1 Marcos

Dos tipos de mensaje, distinguidos por el tipo del `DataChannel`:

- **string** → marco de control, JSON con un campo `k`.
- **binario** (`ArrayBuffer`) → un trozo del archivo abierto por el último `start`, en orden.

El tamaño de trozo lo elige **el emisor** con `chunkFor(pc)`: `pc.sctp.maxMessageSize` acotado a
`[64 KiB, 256 KiB]`. El receptor sólo cuenta bytes, así que el tamaño no se negocia, los límites
de trozo no significan nada y cualquiera puede repartirlos de otra forma (un eslabón lo hace,
§6.2). Lo único que no se puede hacer es mandar un mensaje mayor de lo que anunció SCTP del otro
lado: se pierde sin error.

### 4.2 Secuencia de una transferencia

```
 emisor                                        receptor
   │  ── challenge {nonce} ───────────────────▶  │   canal abierto
   │  ◀── proof {proof} ───────────────────────  │   sha256("drop-proof-v2|nonce|secreto")
   │  ── manifest {files} ─────────────────────▶  │   (sólo si la prueba cuadra)
   │  ◀── accept {files?} ─────────────────────  │   el humano ha pulsado
   │  ── start {index:0, …} ───────────────────▶  │
   │  ── trozos ───────────────────────────────▶  │
   │  ◀── ack {bytes} ─────────────────────────  │   cada 2 MB (ACK_EVERY)
   │  ── end {index:0, sha256} ────────────────▶  │   el receptor compara
   │  ── start {index:1, …} … end …               │
   │  ── done ─────────────────────────────────▶  │
   │  ◀── complete ────────────────────────────  │   con todo escrito y verificado
```

- **Nada antes de `proof`.** El emisor no enseña el manifiesto (los nombres ya son información) a
  quien no demuestre que conoce las palabras. La prueba es un hash rápido, y por tanto un
  verificador offline del secreto: se acepta porque va dentro de DTLS y el código es de un uso.
  Un `proof` malo cierra el canal y avisa al servidor (`bad-guest`). Cualquier otro marco
  recibido antes de una prueba buena se ignora.
- **El receptor puede elegir.** Con `files` en el `accept` el emisor salta lo que no se ha
  pedido, y todo lo que se mide contra el total — `ack`, la barra, `delivered` — se mide contra
  lo pedido: quien baja tres fotos de quince termina al 100 % con las tres.
- **`accept` no arranca al instante:** el emisor puede esperar hasta 1,5 s a más receptores para
  encadenarlos (§6.1). Con un solo receptor conectado arranca en el acto.
- **El progreso del emisor sale de los `ack`**, no de `bufferedAmount`, que sólo dice lo que se ha
  entregado a SCTP.
- **`complete` se manda con todo en disco**, no al recibir `done`. Es lo que permite al emisor
  poner `delivered` y saber que puede cerrar la pestaña.

### 4.3 Marcos de control

`E→R` es emisor a receptor. **Canal** dice por dónde viaja cuando hay cadena (§6): *en banda*
baja con los trozos, salto a salto; *control* va siempre directo entre ese receptor y el emisor.

| `k`         | Dir. | Campos | Canal | Notas |
|-------------|------|--------|-------|-------|
| `challenge` | E→R  | `nonce` (32 hex) | control | Nuevo por receptor. |
| `proof`     | R→E  | `proof` (64 hex) | control | `sha256Hex("drop-proof-v2\|" + nonce + "\|" + secreto)`; `secreto` son las cuatro palabras con guiones. Misma fórmula en `cli/src/crypto.js`. |
| `manifest`  | E→R  | `files: [{ name, size, type, path? }]` | control | `path` es la ruta relativa con `/` cuando se envía una carpeta. `size` es `null` cuando el emisor no lo sabe (hoy sólo un CLI leyendo de stdin, §7): el receptor no da porcentaje y cierra el archivo con el `end`, no contando bytes. |
| `accept`    | R→E  | `files?` | control | `files` son los índices del manifiesto que quiere el receptor (las casillas de la oferta). Sin el campo, el lote entero. El emisor limpia la lista (enteros dentro del manifiesto, sin repetir, en orden: `pickedFiles` en `public/shared/protocol.js`) y manda sólo esos; los demás no tienen `start` ni `end`. Sólo cuenta el primer `accept`. |
| `start`     | E→R  | `index`, `name`, `size`, `type`, `from`, `path?` | **en banda** | Abre el archivo `index`. `from` > 0 sólo al retomar (§5): el receptor no recrea el destino, sigue escribiendo. |
| `end`       | E→R  | `index`, `sha256` | **en banda** | SHA-256 del archivo **entero** (prefijo retomado incluido). El receptor compara con el suyo; si no cuadra, aborta el destino y ofrece `retry`. |
| `done`      | E→R  | — | **en banda** | No quedan archivos. |
| `ack`       | R→E  | `bytes` | control | Total **acumulado** de la transferencia, no del archivo. Cada `ACK_EVERY` (2 MB) y al último byte. Monótono: el emisor se queda con el mayor. |
| `complete`  | R→E  | — | control | Todo verificado y cerrado. |
| `bye`       | R→E  | — | control | El receptor abandona. El emisor lo marca `aborted by peer` y despierta el bucle si estaba en `hold`. (Hoy la pestaña no lo manda; se acepta por si un cliente lo hace.) |
| `resume`    | R→E  | `index`, `offset` | control | "Sígueme desde aquí, directo". §5 y §6.4. |
| `relay`     | E→R  | `to` (guestId) | control | "Abre un canal hacia `to` y reenvíale lo que te llegue". §6. |
| `linked`    | R→E  | — | control | El canal hacia mi eslabón de abajo está abierto. |
| `unrelay`   | E→R  | — | control | Deja de reenviar; cierra tu canal de abajo. |
| `orphaned`  | E→R  | — | control | Tu eslabón de arriba ha muerto: suelta lo que tengas debajo y pide `resume`. |
| `hold`      | R→E, R→R | — | **un salto** | Mi buffer de salida ha pasado `HIGH_WATER`: para. |
| `go`        | R→E, R→R | — | **un salto** | Ha bajado a `LOW_WATER`: sigue. |

Un `k` desconocido se ignora en los dos lados (no cierra nada, no se escribe en ningún archivo).

### 4.4 Control de flujo

- El emisor deja de leer del disco cuando `dc.bufferedAmount > HIGH_WATER` (8 MB) y sigue en
  `bufferedamountlow`, con `bufferedAmountLowThreshold = LOW_WATER` (1 MB). Sin esto un archivo
  grande se lee entero a memoria.
- Lee en bloques de 2 MB (`READ_BLOCK`) y los trocea a `chunkFor(pc)`. Medido: quitar las lecturas
  por trozo no cambia nada; bajar las marcas de agua lo empeora. Los números están en
  [CLAUDE.md](../CLAUDE.md).
- El receptor **serializa las escrituras** en una cadena de promesas (`rx.writes`): `onmessage` es
  síncrono y el sumidero es asíncrono; sin la cola los trozos aterrizan desordenados.
- `hold`/`go` son la contrapresión de la cadena (§6.3); entre emisor y un receptor directo no hacen
  falta y no se mandan.

### 4.5 Dónde acaban los bytes

Lo decide el receptor al pulsar `accept` (`supportsDirectPicker`): varios archivos, una carpeta,
más de 128 MB o tamaño desconocido → pide directorio (File System Access, Chrome/Edge) y escribe a
disco en streaming. Sin la API (Firefox, Safari, iOS), un archivo de 32 MB o más, o sin tamaño, se
sirve como descarga HTTP en streaming a través de un Service Worker (`public/sw.js`): la página lo
alimenta trozo a trozo con contrapresión por créditos y el navegador escribe a Descargas según
llega; si el hash no cuadra la respuesta se rompe y la descarga queda marcada como fallida. Lo que
quede por debajo, o donde no haya worker (contexto no seguro), se acumula en memoria y baja como
Blob. Nada de esto toca el protocolo: son sumideros distintos para los mismos trozos. Con carpetas
cada tramo de `path` pasa por `safeName` (que convierte `..` en `_`) y `getDirectoryHandle(…,
{ create: true })`. El picker tiene que pedirse **dentro** del click: la activación de usuario se
pierde tras un `await`.

## 5. Retomar dentro de una sesión

`resume {index, offset}` del receptor pide al emisor que le sirva **directo** desde ese byte de ese
archivo. El emisor contesta con un `start` con `from = offset` y sigue; el receptor no recrea el
sumidero (`makeSink` trunca) y el `sha256` del `end` sigue siendo el del archivo entero, así que el
emisor rehashea el prefijo si aún no lo tenía.

Dos cosas lo disparan:

1. **Se cayó el eslabón de arriba** (§6.4). El `offset` es `rx.fileGot` **leído después de que
   `rx.writes` se vacíe**: el contador sube al recibir, la escritura sólo se encola, y pedir antes
   deja un agujero en medio del archivo.
2. **`retry` tras un hash que no cuadra:** `resume {index, offset: 0}`.

El bucle de envío está guardado por `conn.epoch`: cada `sendAllFiles` lo incrementa y el anterior,
si estaba a medio `await`, sale al verlo. Sin esto dos bucles entrelazan dos flujos de bytes por
el mismo canal.

Esto **no** es reanudar una descarga cortada en otra sesión: al cerrar la pestaña no queda `.part`
ni offset. Eso es #58, y sólo es posible con receptor en disco.

## 6. La cadena de reenvío

Con N receptores el emisor subía N copias por un uplink. En su lugar los encadena
(`emisor → A → B → C`): cada receptor reenvía lo que le llega, sin almacenar nada, y el emisor sube
**una** copia. El techo pasa a ser el peor uplink de la cadena.

De "un eslabón no guarda nada" salen las cuatro reglas de abajo.

### 6.1 Sólo se encadena a quien empieza a la vez

Un eslabón sólo puede servir a alguien que está en su mismo byte. Por eso los `accept` se agrupan:
tras el primero, el emisor espera hasta `RELAY_WINDOW` (1,5 s) por si hay más, y arranca antes en
cuanto **todos los receptores conectados** han aceptado (un receptor solo no espera nada). Quien
acepta después se sirve directo, como siempre. **Un rezagado no se encadena nunca**; hacerlo
necesitaría que los pares guardasen y resirviesen trozos, que es otro protocolo.

Y sólo con quien ha **elegido los mismos archivos**: un eslabón reenvía lo que le llega y nada
más. El emisor agrupa el lote de `accept` por selección y monta una cadena por grupo; con todos
bajando el lote entero, que es lo normal, sale una sola.

Orden de la cadena: el de aceptación. No se sabe nada de los uplinks como para afinar más.

### 6.2 Montaje

```
 emisor                A                    B                    C
   │ ── relay{to:B} ─▶ │                    │                    │
   │ ── relay{to:C} ───┼──────────────────▶ │                    │
   │                   │ ── signal(sdp) ──▶ │  (vía servidor, to:B)
   │                   │                    │ ── signal(sdp) ──▶ │
   │ ◀── linked ────── │ (canal A→B abierto)│                    │
   │ ◀── linked ───────┼─────────────────── │ (canal B→C abierto)│
   │ ── start, trozos ▶│ ── reenvía ──────▶ │ ── reenvía ──────▶ │
```

- El emisor manda `relay {to}` a cada eslabón salvo el último. El eslabón abre una conexión con
  `to` (señalización guest→guest, §3.1) y un DataChannel `drop`, y al abrirse contesta `linked`.
- **El emisor no manda un byte hasta recibir todos los `linked`.** Si mandase antes, el primero
  reenviaría a un canal a medio abrir y esos bytes se perderían: nadie los guarda.
- Si un `linked` no llega en `RELAY_LINK_TIMEOUT` (8 s) se deshace **toda** la cadena: `unrelay` a
  cada uno y servicio directo a todos. Lento, pero es el comportamiento antiguo y funciona.
- Lo que reenvía un eslabón: los trozos binarios y los marcos `start`/`end`/`done`, **en el orden
  en que le llegan** (reenvía antes de escribir: un salto menos de latencia). Todo lo demás
  (`manifest`, `ack`, `complete`, `resume`…) va por su canal directo con el emisor, que cada
  receptor mantiene abierto aunque los bytes le entren por otro sitio. Por eso el progreso, el
  hash y la cancelación funcionan igual con o sin cadena.
- **Un eslabón re-trocea lo que reenvía**: el trozo venía medido para el enlace de arriba, y si el
  de abajo anunció un `maxMessageSize` menor, SCTP lo tira sin decir nada. Trocear es gratis, el
  receptor sólo cuenta bytes.
- El emisor **no enseña RTT** de un receptor encadenado, sólo `via peer N`: su enlace con él
  lleva control, no datos, y su latencia no dice nada de cómo llegan los bytes.

### 6.3 Contrapresión: `hold` / `go`, un salto

Un eslabón no puede frenar lo que le entra. Cuando su buffer de salida pasa `HIGH_WATER` manda
`hold` **a quien le alimenta** (el emisor, o el eslabón de arriba); un eslabón que recibe `hold`
de abajo lo pasa hacia arriba tal cual. Llega al emisor, cuyo bucle se para en `waitForResume`.
`go` (en `bufferedamountlow`) hace el camino inverso. El emisor también se despierta si la
conexión falla o el receptor se va, para no dormirse para siempre.

### 6.4 Reparación: la dirige el emisor

Cuando se cierra una pestaña, los DataChannels de sus vecinos siguen `open` **decenas de
segundos** (medido: 48 s y nada disparado). Pero el servidor manda `guest-gone` al instante, y
con eso el emisor repara:

```
   A muere.  emisor ── unrelay ──▶ (eslabón de arriba de A, si lo hay)
             emisor ── orphaned ─▶ B
             B cierra su canal hacia C  (C se queda sin fuente y hará lo mismo)
             B vacía rx.writes, y manda  resume {index, offset: rx.fileGot}
             emisor ── start{from} + trozos ──▶ B, directo
```

La cadena se colapsa en flujos directos: nunca peor que el comportamiento antiguo.
`pc.onconnectionstatechange` de la conexión de arriba es sólo el respaldo para cuando el emisor
también se ha ido (entonces nadie manda `orphaned`).

## 7. Cuando un extremo es el CLI

Un `drop recv` no habla WebRTC. Entra con `join { name: 'cli' }` y el emisor web lo sirve por el
**relay del servidor**, cifrado, con el mismo protocolo `cli-*` que usa `drop send` hacia una
pestaña: reto y prueba HMAC con la clave scrypt, manifiesto y marcos sellados, trozos AES-256-GCM,
ventana de acuses de 8 MB. Nada de esta página aplica a esa conexión: no hay `RTCPeerConnection`,
no entra en cadenas, `probePaths` la salta.

Al revés, una pestaña que recibe de `drop send` procesa `cli-manifest`/`cli-start`/`cli-end`/
`cli-done` traduciéndolos a los `manifest`/`start`/`end`/`done` de §4.3 (`onControl`), y acusa con
`cli-ack` en vez de `ack`. La elección de la oferta viaja igual, como `files` dentro de
`cli-accept`, y es lo mismo que manda `drop recv --only`. Con `drop send -` el manifiesto trae `size: null`: la fila pinta el
archivo como `stream`, sin porcentaje ni ETA, y el total se sabe al `done`.

Los dos casos están descritos, mensaje a mensaje, en `cli/src/transfer.js`, y
`PROTOCOL_VERSION` ([`public/shared/protocol.js`](../public/shared/protocol.js), la 5 desde la
selección de archivos) se comprueba en la oferta: una pestaña y un CLI de versiones distintas se rechazan con un
mensaje, no se entienden a medias. Esa versión es del protocolo **del CLI**; el de esta página no
lleva número, porque las dos pestañas sirven siempre el mismo `app.js`.

## 8. Compatibilidad

- **Congelado con la 1.0:** la forma de cada mensaje de §3 y §4.3, el orden de §4.2, la fórmula
  de `proof`, la semántica de `ack` (acumulado, monótono, de lo pedido), `files` en `accept`
  (ausente es todo, presente es exactamente eso), lo que baja en banda y lo que no,
  `from` en `start`, y que un eslabón pueda re-trocear.
- **Extensible sin versión mayor:** marcos de control con un `k` nuevo (se ignoran), campos nuevos
  en marcos existentes (se ignoran), y las constantes (`CHUNK`, `HIGH_WATER`, `LOW_WATER`,
  `ACK_EVERY`, `RELAY_WINDOW`, `RELAY_LINK_TIMEOUT`), que son decisiones de un solo lado.
- **No es protocolo:** el `name` del `join`, los textos de estado, los mensajes de `/config`.

Los cambios que rompan esto se anuncian en el [CHANGELOG](../CHANGELOG.md).
