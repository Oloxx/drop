# Changelog

Todos los cambios publicados de **drop**, de más reciente a más antiguo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado es
[SemVer](https://semver.org/lang/es/). Mientras la versión mayor sea `0`, una versión menor
puede romper compatibilidad; cuando pasa, se dice aquí.

Las notas de cada release, con los binarios, están en
[Releases](https://github.com/Oloxx/drop/releases).

## [Sin publicar]

### Añadido
- Tests en Linux, macOS y Windows antes de desplegar a producción, y la suite arranca su propio
  servidor de señalización: `npm test` ya no necesita nada levantado a mano (#22, #23).
- `LICENSE` (Apache 2.0), `CONTRIBUTING.md` y este `CHANGELOG.md` (#31).
- Cabeceras de seguridad en todas las respuestas: CSP ajustada a lo que la web usa de verdad,
  `X-Content-Type-Options`, `Referrer-Policy` y `Permissions-Policy`; HSTS en Caddy (#30).

### Cambiado
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

[Sin publicar]: https://github.com/Oloxx/drop/compare/v0.5.2...HEAD
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
