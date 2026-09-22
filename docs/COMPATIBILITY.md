# Compatibilidad

Qué promete drop a partir de la 1.0: qué versiones se hablan entre sí, qué no va a cambiar
sin una versión mayor y cómo se añaden cosas sin romper los binarios que ya están instalados.

La regla es [SemVer](https://semver.org/lang/es/): dentro de la 1.x nada de lo que está en la
sección 1 cambia de forma incompatible. Lo que no está en la lista no es promesa.

## 1. Qué se congela con la 1.0

- **El protocolo del CLI, versión 5** (`PROTOCOL_VERSION` en
  [`public/shared/protocol.js`](../public/shared/protocol.js)). Es el mismo número en toda la
  1.x. Cubre el TCP directo (marcos `[longitud][IV][tag][cifrado]`, `manifest` → `ready` →
  `start`/datos/`end` → `done`), el relay cifrado (`cli-offer`, `cli-proof`, `cli-manifest`,
  `cli-accept`, `cli-start`, `cli-ack`, `cli-end`, `cli-done`, `cli-complete`, `cli-retry`,
  `cli-error`, `cli-denied`), la derivación de la clave con scrypt, la fórmula de la prueba y de
  la huella, y `files` para elegir archivos. La descripción canónica está encima de
  `receiveFromRelay` en [`cli/src/transfer.js`](../cli/src/transfer.js).
- **El protocolo web** (señalización y DataChannel): lo que marca como congelado la sección 8 de
  [`PROTOCOL.md`](PROTOCOL.md).
- **La señalización con el servidor:** `host` con `v: 2`, `join`, `signal` y `bad-guest` hacia el
  servidor; `hosted`, `joined`, `guest`, `guest-gone`, `host-gone`, `signal` y `error` de vuelta.
- **El código:** `4271-lemon-radar-tiger-orbit`, cuatro dígitos de sala y cuatro palabras de la
  lista BIP-39 inglesa, en el fragmento del enlace (`/#<código>`), con la tolerancia de siempre al
  teclearlo (mayúsculas, espacios, prefijos de cuatro letras). Un código que vale en una 1.x vale
  en todas.
- **La interfaz del CLI:** las órdenes (`send`, `recv`, `speed`, `update`, `install`,
  `uninstall`, `completion`) y los flags que salen en `drop --help` siguen existiendo y
  significando lo mismo; el código de salida es `0` cuando todo ha ido bien y distinto de `0` si
  no; con `--stdout` (o `-o -`) por la salida estándar solo sale el contenido de los archivos.
- **El servidor autoalojado:** los nombres de las variables de entorno documentadas (`DROP_*`,
  `TURN_SECRET`, `TURN_TTL_SECONDS`) y las rutas `/config` y `/healthz`. `/healthz` puede ganar
  campos, no perderlos.

**No** es promesa: los textos que se enseñan (mensajes, barra de progreso, colores, idioma), el
aspecto de la web, los valores por defecto de los límites del servidor, las constantes de
rendimiento (tamaño de trozo, marcas de agua, cada cuánto se acusa) y todo lo que no sale en
`--help`.

## 2. Quién habla con quién

| | CLI 1.x | Web (la desplegada) | CLI 0.x |
|---|---|---|---|
| **CLI 1.x** | Sí, cualquier 1.x con cualquier 1.y, en los dos sentidos, por TCP y por relay | Sí: la web habla el protocolo 5 durante toda la 1.x | No: se rechazan con un mensaje que pide `drop update` |
| **Web** | Sí | Sí: las dos pestañas cargan el mismo `app.js` | No, mismo mensaje |

Antes de la 1.0 cada versión menor podía romper, y rompió: la 0.9.x habla el protocolo 4, la
0.7.x y la 0.8.x el 3. Ninguna habla con una 1.x. Lo dice el [CHANGELOG](../CHANGELOG.md) en cada
release.

## 3. Cómo se añade algo en la 1.x sin romper

El número no se mueve, así que un `drop` 1.0 y uno 1.3 se aceptan y se hablan. Lo que lo hace
posible son estas reglas, y [`test/compat.test.mjs`](../test/compat.test.mjs) comprueba que los
receptores y emisores de hoy las cumplen:

1. **Todo lo desconocido se ignora.** Un campo de más en un marco, un marco de control con un
   `k` (DataChannel, TCP) o un `type` (relay) que no se conoce, un `t` de señalización nuevo: ni se
   rechaza, ni se escribe en ningún archivo, ni corta nada. Lo cumplen los dos lados de cada
   camino y el servidor.
2. **Un campo nuevo es opcional y su ausencia es el comportamiento de la 1.0.** `files` ya
   funciona así: sin él se manda el lote entero.
3. **Lo que obliga al otro lado a hacer algo se anuncia antes en `features`.** Pedir algo que el
   otro ignoraría en silencio es peor que no pedirlo: un emisor 1.0 que no entiende una petición
   hace otra cosa. Por eso un campo nuevo que *cambia* lo que tiene que hacer el otro extremo
   (comprimir, cifrar de otra forma, saltarse algo) solo se usa si el otro lo ha anunciado:
   - `features` es una lista de cadenas. El emisor la pone en el manifiesto (`manifest` por TCP,
     `cli-manifest` por relay, `manifest` en el DataChannel); el receptor, en su respuesta
     (`ready`, `cli-accept`, `accept`).
   - Si no viene, es la lista vacía: eso es lo que manda cualquier 1.0.
   - La 1.0 no anuncia ninguna. El nombre del campo queda reservado para esto.
4. **El orden no cambia.** El primer marco del emisor por TCP es el manifiesto y la primera
   respuesta del receptor es `ready`; por relay la oferta va en claro y lo demás sellado. Algo
   nuevo va después, nunca delante.
5. **Un `t` de señalización nuevo entra primero en el servidor.** Los clientes y el servidor
   ignoran los `t` que no conocen, pero un cliente no puede contar con uno que el servidor no
   reenvía. Un motivo de `error` nuevo lo enseña una versión vieja con su texto genérico (la
   web) o con el motivo tal cual (el CLI): se nota, no rompe.
6. **Las constantes de un solo lado se tocan libremente** (trozo, marcas de agua, ventana de la
   cadena) mientras la semántica no cambie: el acuse es de bytes totales y monótono, y la ventana
   del emisor por relay tiene que seguir muy por encima de cada cuánto acusa el receptor.

## 4. Cuándo se rompe: la 2.0

Solo una versión mayor cambia `PROTOCOL_VERSION`, y cambiarlo es lo que la hace mayor.

- Se anuncia en el CHANGELOG con al menos una versión menor de antelación, diciendo qué cambia.
- Un `drop` 1.x contra uno 2.x se rechaza con el mensaje de siempre (`drop update`), nunca se
  entienden a medias.
- La web desplegada pasa al protocolo nuevo el día de la 2.0. Entre dos CLI 1.x todo sigue
  funcionando: el TCP directo no necesita el servidor, y el relay usa una señalización que el
  servidor público sigue aceptando al menos **seis meses** después de publicar la 2.0.

## 5. Qué versiones reciben arreglos

La última release. Como dentro de la 1.x el protocolo no cambia, actualizar con `drop update` a la
última 1.x no rompe nada con quien siga en una anterior. Los fallos de seguridad se publican como
dice [SECURITY.md](../SECURITY.md).
