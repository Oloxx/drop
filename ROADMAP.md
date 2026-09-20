# Camino a la 1.0

Lo que falta para que **drop** pase de `0.x` a `1.0`. La regla de SemVer es simple: a partir
de la 1.0 el protocolo, el formato de los códigos y la interfaz del CLI no cambian sin subir
la versión mayor. Así que la lista no es "todas las funciones que se nos ocurren", sino lo
que hay que **cerrar o decidir** antes de prometer eso.

Cada punto enlaza a su issue cuando lo tiene. Lo que no tiene número todavía no está abierto.

## Protocolo y compatibilidad

Lo que se congela con la 1.0. Cualquier cambio aquí después cuesta una versión mayor.

- [ ] **Congelar `PROTOCOL_VERSION`** y escribir la política de compatibilidad: qué versiones
      del CLI se hablan entre sí y con la web, y durante cuánto tiempo.
- [ ] **Especificar el protocolo del DataChannel en un documento**, como ya está el relay del
      CLI encima de `receiveFromRelay` en `cli/src/transfer.js`: marcos JSON, trozos binarios,
      cadena de relay (`relay`/`linked`/`orphaned`/`resume`/`hold`/`go`), qué va en banda y qué
      por el canal de control. Hoy vive repartido entre `CLAUDE.md` y `app.js`.
- [x] **Quitar el camino de la v0.3.5** (`@deprecated` en `server/index.js`, `cli/src/cli.js`,
      `cli/src/crypto.js`). Hecho en la v0.8.0: el servidor contesta `VERSION` a quien no pide
      `v:2`, y `parseCode` ya no reconoce el token largo.
- [x] **Tabla de interoperabilidad en el README**: Web↔Web, CLI↔CLI, CLI→Web, Web→CLI, con
      qué transporte usa cada una (TCP directo, relay cifrado, DataChannel) y qué reanuda.
      Hecho en la v0.8.0, con la columna de reanudación y la fila de "Dos modos" corregida.
- [ ] **Reanudación en todas las combinaciones que puedan** (#58): Web→CLI respetando el
      `offset` de `cli-accept`, receptor web con File System Access escribiendo a `.part`. Y
      dejar por escrito dónde no hay reanudación posible (receptor web sin disco).
- [ ] Decidir si **IPv6** (#37) entra en el descubrimiento y las rutas directas antes de
      congelar el formato de `cli-offer`, porque añadir direcciones después es un cambio de
      protocolo.

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
- [ ] **Tests del cliente web en CI**: `npm run bench` y `bench:fanout` pasan por Chrome real
      pero no se ejecutan en `ci.yml`; un cambio en `app.js` solo lo detecta quien lo prueba a
      mano. Un caso corto (un archivo, dos pestañas, SHA-256) en Playwright dentro de la suite.
- [ ] **Errores con mensaje en todos los cortes conocidos**: pestaña del emisor cerrada
      a mitad, receptor que rechaza, `.part` huérfano, servidor caído durante la señalización.
      Revisar que cada uno acaba en `fail()` con texto y no en un `transmitting…` eterno.

## Servidor y despliegue

- [x] **Cuota de caudal para el relay WebSocket** (#56): `DROP_RELAY_LIMIT` por sala y
      `DROP_RELAY_LIMIT_TOTAL` por proceso desde la v0.8.0. Pausa el socket, no corta.
- [x] **Métricas mínimas** en `/healthz`: salas, invitados, bytes y frames relayed, pausas
      por cuota y rechazos por motivo. Desde la v0.8.0.
- [ ] **Decidir la escala**: las salas viven en un `Map` y una sola instancia es una
      restricción documentada. Para la 1.0 o se acepta explícitamente (y se quita `fly.toml`
      y la alternativa Fly del README, que no se prueba) o se mueven las salas a Redis.
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
- [ ] **Autocompletado de shell** (`bash`, `zsh`, `fish`, PowerShell) y `drop --help` completo
      con todos los flags que existen (`--limit`, `--once`, `--expire`, `--text`, `--clipboard`,
      `--stdout`, `--no-qr`, `--relay`).

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

- [ ] **Selección de archivos en el receptor** (#10): con un lote de 15 fotos, poder bajar
      tres. El `accept` con índices es un cambio de protocolo, así que va antes de congelar.
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
