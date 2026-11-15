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
- [x] **Reanudación en todas las combinaciones que puedan** (#58): Web→CLI sigue desde el
      `.part` con el prefijo comprobado; explicado en el README junto con el motivo por el que el
      receptor web (Service Worker / Blob) empieza de cero entre sesiones.
- [x] **IPv6 en rutas directas y descubrimiento LAN** (#37): desde la v0.9.0 las IPv6 entran
      en `ips` y el emisor escucha en dual-stack; completado el descubrimiento local por multicast
      UDP IPv6 (`ff02::1`, puerto `42424`) en [`cli-rs/src/discovery.rs`](cli-rs/src/discovery.rs)
      en paralelo al broadcast IPv4.
- [x] **Descubrimiento local por mDNS / DNS-SD** (#38): [`cli-rs/src/mdns.rs`](cli-rs/src/mdns.rs)
      anuncia y consulta `_drop._tcp.local` (`224.0.0.251:5353` y `[ff02::fb]:5353`) con `PTR`,
      `SRV` y `TXT` (`h=<roomHash>`, `p=<puerto>`) en paralelo al broadcast UDP `42424`, sin
      dependencias externas ni filtrar el secreto de cuatro palabras, degradando limpio si el
      puerto `5353` está ocupado sin `SO_REUSEPORT`.

## Robustez de lo que ya existe

- [x] **Descarga en streaming sin File System Access** (#55): Service Worker en `public/sw.js`
      que sirve la descarga como respuesta HTTP en streaming, desde la v0.9.0. Probado en
      Chrome; falta pasarlo por Firefox y Safari/iOS de verdad (ver el punto de abajo).
- [x] **CLI a CLI por WAN** (#11): además de UPnP y la IP vista por el servidor de señalización,
      `cli-rs/src/stun.rs` consulta servidores STUN (RFC 5389) en paralelo para descubrir la IP
      pública IPv4 incluso cuando la señalización entra por IPv6 o UPnP no responde,
      `cli-rs/src/natpmp.rs` añade respaldo automático por NAT-PMP (RFC 6886) en `map_port` cuando
      UPnP no responde o falla, y el README documenta honestamente la velocidad real en cada ruta
      (LAN, WAN directo, relay y WebRTC).
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
- [x] **Copia de seguridad y rotación** del `.env` de valhalla (`TURN_SECRET`,
      `DROP_SIGNING_KEY`), con el procedimiento escrito en [`DEPLOY-VPS.md`](DEPLOY-VPS.md).
- [x] **`npm audit` y actualización de dependencias en CI**: job `audit` en `ci.yml`, solo
      producción y a partir de `moderate`, y falla si `dependencies` deja de tener dos entradas.
      Desde la v0.8.0.

## Distribución del CLI

- [x] **macOS firmado** (#24): tras migrar el CLI a Rust, el build firma el binario nativo con `codesign --sign - --force`
      ad hoc, así que el binario arranca en Apple Silicon (`aarch64-apple-darwin`). **Sin notarizar, a
      propósito:** el Apple Developer Program cuesta dinero cada año. El README explica cómo
      pasar Gatekeeper y recomienda descargar con `curl`, que no marca el archivo.
- [x] **Windows sin Authenticode, a propósito** (#57): un certificado cuesta dinero cada año. El
      README explica el aviso de SmartScreen, `Unblock-File` y la descarga con `curl.exe`. La firma
      minisign del `SHA256SUMS` sigue siendo la que dice quién publicó el binario.
- [ ] **Gestores de paquetes** (#40). Hechos **Homebrew** (`Oloxx/homebrew-tap`) y **Scoop**
      (`Oloxx/scoop-bucket`): se regeneran solos tras comprobar la firma del `SHA256SUMS` y
      se prueban instalando en macOS, Linux y Windows. Y `cli-rs/src/pkgmgr.rs` ya detecta
      **Homebrew**, **Scoop** y **WinGet** (`WinGet\Packages` / `WinGet\Links`) para evitar
      que `drop` instalado por un gestor se autoinstale o se autoactualice. Quedan
      **winget** (publicar/automatizar el PR a `microsoft/winget-pkgs` por versión) y
      decidir **npm**.
- [ ] **`drop update` probado contra una release real** en las tres plataformas antes de cada
      release (hoy está cubierto por tests unitarios de `cli-rs/src/minisign.rs`, no por un
      flujo de extremo a extremo).
- [x] **Autocompletado de shell** (`drop completion bash|zsh|fish|powershell`, en
      `cli-rs/src/completion.rs`) y `drop --help` completo: `test/version.test.mjs` saca del parser
      todos los flags y falla si alguno falta en la ayuda o en la tabla del autocompletado.

## Seguridad

- [x] **Documento de modelo de amenazas**: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md),
      enlazado desde [`SECURITY.md`](SECURITY.md), con qué ve el servidor y TURN, el coste
      contra fuerza bruta de `scrypt`, qué protege el SAS y qué queda fuera de cobertura.
- [x] **Revisión externa o pasada formal sobre la criptografía**: pasada formal sobre
      [`public/shared/`](public/shared/) (`e2ee.js`, `scrypt.js`, `sas.js`, `sha256.js`) y
      [`cli-rs/src/`](cli-rs/src/) (`crypto.rs`, `minisign.rs`, `shared/sas.rs`) —comparación
      en tiempo constante `verifyProof`, validación de parámetros en `scrypt` / `e2ee`, y
      vectores oficiales FIPS 180-4, RFC 4231, RFC 6070 y RFC 7914 en
      [`test/e2ee.test.mjs`](test/e2ee.test.mjs) y
      [`cli-rs/tests/shared_vectors_test.rs`](cli-rs/tests/shared_vectors_test.rs)—.
      Sigue sin auditoría externa pagada, documentado en `SECURITY.md` y `docs/THREAT-MODEL.md`.
- [x] **`SECURITY.md`** con cómo reportar, qué versiones tienen soporte y el modelo de
      amenazas completo enlazado en [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
- [x] **Comprobar que el servidor sirve el código del repositorio.** No por release sino por
      commit, porque la web se despliega desde `main`: `/version` dice el commit (lo pone el
      despliegue) y `drop verify-web` compara cada archivo servido con el árbol de `public/` de
      ese commit en GitHub. SRI no servía: el HTML con los `integrity` lo sirve el mismo servidor.

## Web

- [x] **Selección de archivos en el receptor** (#10): con un lote de 15 fotos, poder bajar
      tres. Casillas en la oferta web y `drop recv --only <patrones>`; la elección viaja como
      `files` (índices del manifiesto) en `accept`, `ready` y `cli-accept`, protocolo 5.
- [x] **Accesibilidad básica**: foco visible (también en la zona de soltar), avisos
      `aria-live` del final de cada transferencia, barras `progressbar`, contraste AA
      comprobado en `test/a11y.test.mjs` (el gris de texto era 2,8:1 y ahora 4,7:1) y el
      selector de archivos alcanzable con Tab.
- [x] **Página de error para navegadores sin WebRTC** en vez de un fallo silencioso. Desde la
      v0.8.0: vista `unsupported`, con el código del enlace a la vista para abrirlo en otro sitio.

## Documentación y proceso

- [x] **README en inglés** además del español: [`README.en.md`](README.en.md) enlazado desde
      [`README.md`](README.md) y comprobado en `test/version.test.mjs` para que los enlaces de
      descarga no se queden atrás.
- [x] **Servidor web y de señalización embebido** (#39): [`cli-rs/src/commands/serve.rs`](cli-rs/src/commands/serve.rs)
      implementa `drop serve [-p <puerto>] [-H <dir>]` con los archivos de `public/` embebidos en
      compilación ([`cli-rs/build.rs`](cli-rs/build.rs)), `/config`, `/healthz`, `/version`,
      cabeceras de seguridad y el servidor WebSocket de señalización y relay sin depender de Node.
- [x] **Checklist de release** en `CONTRIBUTING.md` ("Publicar una versión"). Desde la v0.8.0.

## Lo que la 1.0 no necesita

Para que no se cuele por inercia:

- Redis y multi-instancia, si se decide arriba que una instancia basta.
- Cuentas, historial, enlaces persistentes. drop es efímero a propósito.
- Vista previa de archivos en el receptor (la segunda mitad de #10). Es bonito, no es 1.0.
- Cualquier petición a un tercero desde la web. Sigue siendo cero.
