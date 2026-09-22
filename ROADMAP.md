# Camino a la 1.0

Lo que falta para que **drop** pase de `0.x` a `1.0`. La regla de SemVer es simple: a partir
de la 1.0 el protocolo, el formato de los códigos y la interfaz del CLI no cambian sin subir
la versión mayor. Así que la lista no es "todas las funciones que se nos ocurren", sino lo
que hay que **cerrar o decidir** antes de prometer eso.

Cada punto enlaza a su issue cuando lo tiene. Lo que no tiene número todavía no está abierto.

## Protocolo y compatibilidad

Lo que se congela con la 1.0. Cualquier cambio aquí después cuesta una versión mayor.

- [x] **Congelar `PROTOCOL_VERSION`** y escribir la política de compatibilidad: qué versiones
      del CLI se hablan entre sí y con la web, y durante cuánto tiempo. La 5 para toda la 1.x,
      en [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md), con `features` reservado para
      capacidades nuevas y `test/compat.test.mjs` como candado.
- [x] **Especificar el protocolo del DataChannel en un documento**: [`docs/PROTOCOL.md`](docs/PROTOCOL.md),
      con la señalización, los marcos JSON y binarios, la cadena de relay, qué va en banda y qué
      por control, y qué se congela con la 1.0 frente a qué se puede añadir sin versión mayor.
- [x] **Quitar el camino de la v0.3.5** (`@deprecated` en `server/index.js`, `cli/src/cli.js`,
      `cli/src/crypto.js`). Hecho en la v0.8.0: el servidor contesta `VERSION` a quien no pide
      `v:2`, y `parseCode` ya no reconoce el token largo.
- [x] **Tabla de interoperabilidad en el README**: Web↔Web, CLI↔CLI, CLI→Web, Web→CLI, con
      qué transporte usa cada una (TCP directo, relay cifrado, DataChannel) y qué reanuda.
      Hecho en la v0.8.0, con la columna de reanudación y la fila de "Dos modos" corregida.
- [ ] **Reanudación en todas las combinaciones que puedan** (#58): Web→CLI respetando el
      `offset` de `cli-accept`, receptor web con File System Access escribiendo a `.part`. Y
      dejar por escrito dónde no hay reanudación posible (receptor web sin disco).
- [x] Decidir si **IPv6** (#37) entra en las rutas directas antes de congelar el formato de
      `cli-offer`. Decidido y hecho en la v0.9.0: las IPv6 van en `ips` como cadenas sueltas,
      sin campo de familia, y el emisor escucha en las dos. Lo que queda de #37 (multicast IPv6
      en el descubrimiento local) no toca la oferta, así que puede ir después.

## Robustez de lo que ya existe

- [x] **Descarga en streaming sin File System Access** (#55): Service Worker en `public/sw.js`
      que sirve la descarga como respuesta HTTP en streaming, desde la v0.9.0. Probado en
      Chrome; falta pasarlo por Firefox y Safari/iOS de verdad (ver el punto de abajo).
- [ ] **CLI a CLI por WAN** (#11): hoy el TCP directo solo funciona en la misma LAN o con UPnP;
      fuera de eso cae al relay del servidor. Como mínimo, STUN para conocer la IP pública y
      documentar honestamente qué velocidad se obtiene en cada caso.
- [x] **Tuberías** (#29): `drop send -` desde stdin con tamaño desconocido (`size: null` en el
      manifiesto, protocolo 4). Hecho en la v0.9.0; `--stdout` ya existía.
- [ ] **Safari de escritorio y iOS probados de verdad** con transferencia web completa (SCTP,
      `maxMessageSize`, sin `showDirectoryPicker`). Hoy solo hay medición en Chrome.
- [x] **Tests del cliente web en CI**: `test/web.test.mjs` (un archivo, dos pestañas, huella
      igual en las dos, SHA-256) corre dentro de `npm test` con el Chrome del runner y el CI
      lo exige en Linux (`DROP_REQUIRE_CHROME=1`). `bench` y `bench:fanout` siguen siendo
      benches.
- [x] **Errores con mensaje en todos los cortes conocidos**: en la web todos pasan por
      `recvDead()` — emisor que cierra antes o después de aceptar, ICE que falla sin TURN,
      servidor caído antes de que abra el canal — y con el canal ya abierto la transferencia
      termina sin servidor (probado en `test/web.test.mjs`). El CLI ya decía qué pasa con un
      rechazo del emisor y con un `.part` conservado.

## Servidor y despliegue

- [x] **Cuota de caudal para el relay WebSocket** (#56): `DROP_RELAY_LIMIT` por sala y
      `DROP_RELAY_LIMIT_TOTAL` por proceso desde la v0.8.0. Pausa el socket, no corta.
- [x] **Métricas mínimas** en `/healthz`: salas, invitados, bytes y frames relayed, pausas
      por cuota y rechazos por motivo. Desde la v0.8.0.
- [x] **Decidir la escala**: una sola instancia, aceptado. Una sala es poco más que dos
      WebSockets y los bytes de WebRTC no pasan por el servidor, así que un proceso sobra; está
      escrito en `DEPLOY-VPS.md`. `fly.toml`, que nunca se probó, se ha quitado.
- [ ] **Copia de seguridad y rotación** del `.env` de valhalla (`TURN_SECRET`,
      `DROP_SIGNING_KEY`), con el procedimiento escrito en `DEPLOY-VPS.md`.
- [x] **`npm audit` y actualización de dependencias en CI**: job `audit` en `ci.yml`, solo
      producción y a partir de `moderate`, y falla si `dependencies` deja de tener dos entradas.
      Desde la v0.8.0.

## Distribución del CLI

- [ ] **macOS firmado y notarizado** (#24): en arm64 la inyección SEA invalida la firma y el
      sistema mata el binario; Gatekeeper bloquea el resto. Además falta `build:macos-x64`.
- [ ] **Windows con Authenticode** (#57) para que SmartScreen deje de asustar.
- [ ] **Gestores de paquetes** (#40): Homebrew, Scoop o winget, npm. `install.ps1` y el
      `curl | sh` valen para probar, no para pedir a alguien que lo instale en el trabajo.
- [ ] **`drop update` probado contra una release real** en las tres plataformas antes de cada
      release (hoy está cubierto por tests unitarios de `minisign.js` y `shasums.js`, no por un
      flujo de extremo a extremo).
- [x] **Autocompletado de shell** (`drop completion bash|zsh|fish|powershell`, en
      `cli/src/completion.js`) y `drop --help` completo: `test/version.test.mjs` saca del parser
      todos los flags y falla si alguno falta en la ayuda o en la tabla del autocompletado.

## Seguridad

- [ ] **Documento de modelo de amenazas**: qué ve el servidor, qué ve el TURN, qué protege el
      código de cuatro palabras y contra cuántos intentos, qué protege la huella (SAS), y qué
      no está cubierto (un servidor malicioso que sirve otro `app.js`). El README tiene partes;
      falta el documento que se pueda enlazar.
- [ ] **Revisión externa** o al menos una pasada formal sobre `crypto.js`, `e2ee.js`,
      `scrypt.js`, `sas.js` y la derivación de claves. Son implementaciones propias y la 1.0
      las promete.
- [x] **`SECURITY.md`** con cómo reportar, qué versiones tienen soporte y el modelo de
      amenazas en corto. Desde la v0.8.0; el documento largo del punto de arriba sigue pendiente.
- [ ] **Subresource integrity o hash publicado de `app.js`** por release, para que quien
      quiera pueda comprobar que el servidor sirve el código del repositorio.

## Web

- [x] **Selección de archivos en el receptor** (#10): con un lote de 15 fotos, poder bajar
      tres. Casillas en la oferta web y `drop recv --only <patrones>`; la elección viaja como
      `files` (índices del manifiesto) en `accept`, `ready` y `cli-accept`, protocolo 5.
- [ ] **Accesibilidad básica**: foco visible, `aria-live` en la fila de progreso, contraste
      del tema Tokyo Night verificado, todo operable con teclado.
- [x] **Página de error para navegadores sin WebRTC** en vez de un fallo silencioso. Desde la
      v0.8.0: vista `unsupported`, con el código del enlace a la vista para abrirlo en otro sitio.

## Documentación y proceso

- [ ] **README en inglés** además del español, o al menos la parte de instalación y uso. La
      web ya es en inglés; el proyecto se anuncia en un idioma y se documenta en otro.
- [x] **Checklist de release** en `CONTRIBUTING.md` ("Publicar una versión"). Desde la v0.8.0.
- [ ] **Cerrar o descartar** cada issue abierto con `P3` que no entre: #38 (mDNS), #39
      (servidor de señalización embebido). Una 1.0 con quince issues de "algún día" abiertos
      no dice nada; una con cinco decididos, sí.

## Lo que la 1.0 no necesita

Para que no se cuele por inercia:

- Redis y multi-instancia, si se decide arriba que una instancia basta.
- Cuentas, historial, enlaces persistentes. drop es efímero a propósito.
- Vista previa de archivos en el receptor (la segunda mitad de #10). Es bonito, no es 1.0.
- Cualquier petición a un tercero desde la web. Sigue siendo cero.
