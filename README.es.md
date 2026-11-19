<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
  <img alt="Logotipo de drop" src="docs/assets/logo-dark.svg" width="230">
</picture>

<p>
  <strong>Transferencia de archivos P2P cifrada de extremo a extremo</strong> — en navegador o terminal.<br>
  Sin cuentas, sin almacenamiento en la nube y sin límites de tamaño.
</p>

<p>
  <a href="https://github.com/Oloxx/drop/releases/latest"><img src="https://img.shields.io/github/v/release/Oloxx/drop?style=flat-square&color=22c55e&labelColor=111113" alt="Última release"></a>
  <a href="https://github.com/Oloxx/drop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Oloxx/drop/ci.yml?branch=main&style=flat-square&label=CI&labelColor=111113" alt="Estado CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f4f4f5?style=flat-square&labelColor=111113" alt="Licencia Apache 2.0"></a>
</p>

<p>
  <a href="https://drop.oloxx.dev"><strong>Probar Web en Vivo</strong></a> ·
  <a href="#inicio-rápido">Inicio rápido</a> ·
  <a href="#instalación">Instalación</a> ·
  <a href="#guía-de-uso">Uso</a> ·
  <a href="#arquitectura-y-seguridad">Seguridad</a> ·
  <a href="#autoalojamiento-y-desarrollo">Autoalojamiento</a>
</p>

<p><a href="README.md">English</a> · <strong>Español</strong></p>

</div>

---

## Inicio Rápido

### Opción 1 · Navegador (sin instalar nada)

Abre **[`drop.oloxx.dev`](https://drop.oloxx.dev)** — arrastra, selecciona o pega (`Ctrl+V` / `Cmd+V`) archivos, capturas o texto, y comparte el código de un solo uso, el enlace o el QR.

### Opción 2 · CLI en terminal (máxima velocidad)

```bash
# Instala por Homebrew (macOS / Linux) o WinGet / Scoop (Windows)
brew install oloxx/tap/drop      # o: winget install Oloxx.drop
```

```bash
# Enviar un archivo, carpeta o portapapeles
drop send pelicula.mkv

# Recibir en otro equipo (o desde el navegador)
drop recv 4271-lemon-radar-tiger-orbit
```

### Web frente a CLI

| | Web ([`drop.oloxx.dev`](https://drop.oloxx.dev)) | Terminal CLI (`drop`) |
|---|---|---|
| **Ideal para** | Móviles, tablets, envíos rápidos en navegador | Archivos grandes (ISOs, backups, vídeos, carpetas) |
| **Instalación** | Cero — solo abrir cualquier navegador moderno | Binario estático único (~5,4 MB, sin dependencias) |
| **Transporte** | WebRTC DataChannel (o TURN) | TCP directo + LAN UDP/mDNS + UPnP/NAT-PMP/STUN (o relay E2EE) |
| **Velocidad típica** | ~15 MB/s (techo SCTP del navegador) | **100–115 MB/s** en LAN; en WAN según tu línea |
| **Interoperabilidad** | Habla con Web y CLI | Habla con CLI y Web (las 4 combinaciones) |
| **Autoalojamiento** | Docker Compose / Node.js | `drop serve` integrado (web embebida + relay WebSocket) |

---

## Cómo Funciona

* **Directo por defecto:** Los equipos se envían los archivos directamente por WebRTC DataChannels (navegador) o TCP directo (CLI, con descubrimiento LAN en < 10 ms por broadcast IPv4, multicast IPv6 y mDNS). Cuando las NAT impiden conexión directa, el tráfico pasa por relay cifrado extremo a extremo con AES-256-GCM: el servidor solo ve texto cifrado.
* **Sin secretos en el servidor:** El código separa enrutamiento y criptografía. Solo los 4 dígitos de sala llegan al servidor; las cuatro palabras BIP-39 derivan la clave localmente y **no salen nunca de tu equipo**.
* **Varios receptores sin subir varias copias:** En web se forma una cadena de reenvío (`Emisor → A → B → C`) para que enviar a 5 personas solo consuma una subida desde tu conexión.
* **Compilación y web verificables:** Cada release se firma con Minisign y SHA-256, y `drop verify-web` comprueba byte a byte que la web servida coincide con el árbol `public/` de GitHub.

```text
  Emisor                 Servidor                   Receptor
  │  1. Crear sala ──────► (devuelve "4271")            ▲
  │     + sortea 4 palabras en local                    │
  │                                                     │
  │  2. Comparte 4271-lemon-radar-tiger-orbit ──────────┤ 3. Escribe el código o abre el enlace
  │◄── 4. Señalización (SDP/ICE o IPs locales/STUN) ───►│
  │                                                     │
  │  5. TRANSFERENCIA P2P DIRECTA CIFRADA (E2EE) ──────►│
  └─────────────────────────────────────────────────────┘
```

---

## Instalación

### Instalación rápida (un comando)

Descarga la última release, verifica su hash en `SHA256SUMS`, instala `drop` y lo añade a tu `PATH`:

```powershell
# Windows (PowerShell)
irm https://drop.oloxx.dev/install.ps1 | iex
```

```cmd
:: Windows (CMD)
curl -fsSL https://drop.oloxx.dev/install.cmd -o "%TEMP%\drop-install.cmd" && "%TEMP%\drop-install.cmd" && del "%TEMP%\drop-install.cmd"
```

```bash
# macOS y Linux
curl -fsSL https://drop.oloxx.dev/install.sh | sh
```

### Gestores de Paquetes

```bash
# macOS y Linux (Homebrew)
brew install oloxx/tap/drop
```

```powershell
# Windows (WinGet — microsoft/winget-pkgs)
winget install Oloxx.drop

# Windows (Scoop)
scoop bucket add oloxx https://github.com/Oloxx/scoop-bucket
scoop install oloxx/drop
```

Las instalaciones gestionadas se actualizan desde su gestor (`brew upgrade drop`, `winget upgrade Oloxx.drop` o `scoop update drop`) en lugar de `drop update`: `drop` detecta su ruta de instalación y te indica el comando exacto. Todos los manifiestos se generan únicamente tras comprobar `SHA256SUMS.minisig` ([homebrew-tap](https://github.com/Oloxx/homebrew-tap), [scoop-bucket](https://github.com/Oloxx/scoop-bucket), [`scripts/winget.mjs`](scripts/winget.mjs)).

### Descargas Directas (`v0.14.1`)

Binarios estáticos autónomos sin dependencias externas (ni Node.js ni Visual C++ Redistributable) desde la [Release v0.14.1](https://github.com/Oloxx/drop/releases/tag/v0.14.1):

| Plataforma | Binario | Instalación |
|---|---|---|
| **Windows (x64)** | [`drop-v0.14.1-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-windows-x64.exe) | Doble clic o ejecutar `install` (copia a `%LOCALAPPDATA%\Programs\drop\` y añade al `PATH`) |
| **Linux (x64)** | [`drop-v0.14.1-linux-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-linux-x64.tar.gz) | `tar -xzf drop-v0.14.1-linux-x64.tar.gz && ./drop-v0.14.1-linux-x64 install` |
| **Linux (ARM64)** | [`drop-v0.14.1-linux-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-linux-arm64.tar.gz) | `tar -xzf drop-v0.14.1-linux-arm64.tar.gz && ./drop-v0.14.1-linux-arm64 install` |
| **macOS (Apple Silicon)** | [`drop-v0.14.1-macos-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-macos-arm64.tar.gz) | `tar -xzf drop-v0.14.1-macos-arm64.tar.gz && ./drop-v0.14.1-macos-arm64 install` |

<details>
<summary><strong>Verificar descargas con Minisign y SHA-256</strong></summary>

Cada release incluye `SHA256SUMS` y su firma Ed25519 `SHA256SUMS.minisig`. Comprobar ambas verifica quién publicó la release y que el binario llegó íntegro:

```bash
# 1. Verificar firma (releases v0.5.2+) con minisign
minisign -Vm SHA256SUMS -P RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp

# 2. Verificar hash del binario (Linux / macOS)
sha256sum -c SHA256SUMS --ignore-missing
```

```powershell
# 2. Verificar hash del binario (Windows PowerShell)
Get-FileHash drop-v0.14.1-windows-x64.exe -Algorithm SHA256
```

`drop update` ejecuta automáticamente la verificación Minisign + SHA-256 antes de sustituir el ejecutable y aborta ante cualquier fallo (exige `--allow-unsigned` en versiones previas a `v0.5.2`). Los binarios instalados directamente también comprueban actualizaciones en segundo plano (como máximo cada 24 h) e instalan las releases verificadas para el próximo comando; si lo gestiona Homebrew/WinGet/Scoop, solo muestra un aviso con el comando de actualización. Usa `DROP_NO_AUTO_UPDATE=1` para desactivarlo.

</details>

<details>
<summary><strong>Avisos de macOS Gatekeeper y Windows SmartScreen</strong></summary>

Los binarios están firmados con la clave Minisign del proyecto, no con certificados comerciales de pago de Apple o Microsoft, por lo que descargar desde navegador dispara un aviso en el primer arranque. Descargar con `curl` / `curl.exe` (o instalar vía Homebrew / WinGet / Scoop) evita la marca de cuarentena:

```bash
# macOS (Apple Silicon)
curl -LO https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-macos-arm64.tar.gz
tar -xzf drop-v0.14.1-macos-arm64.tar.gz && ./drop-v0.14.1-macos-arm64 install
```

```powershell
# Windows (curl.exe viene preinstalado en Windows 10 y 11)
curl.exe -LO https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-windows-x64.exe
.\drop-v0.14.1-windows-x64.exe
```

Si ya descargaste desde un navegador:
- **macOS:** ejecuta `xattr -d com.apple.quarantine ./drop-v0.14.1-macos-arm64`, o abre **Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente**.
- **Windows:** pulsa **Más información → Ejecutar de todas formas** en SmartScreen, o ejecuta `Unblock-File .\drop-v0.14.1-windows-x64.exe` en PowerShell.

</details>

---

## Guía de Uso

### Navegador Web (`https://drop.oloxx.dev`)

1. **Enviar:** Arrastra, selecciona o pega (`Ctrl+V` / `Cmd+V`) archivos, capturas o texto (`clipboard.txt`) y pulsa **open channel**. Comparte el código, enlace directo (`#codigo`) o **qr** local ([`public/shared/qr.js`](public/shared/qr.js)). Mantén la pestaña abierta mientras descargan; pueden entrar varios receptores a la vez.
2. **Recibir:** Abre el enlace o introduce el código en **receive · enter a code**. Desmarca archivos para omitirlos o activa **download as .zip** (activo automáticamente desde 4 archivos o carpetas del CLI, generando ZIP64 al vuelo con [`public/shared/zip.js`](public/shared/zip.js)).
   * **< 32 MB:** se guarda en memoria (`Blob`) y descarga tras verificar SHA-256.
   * **>= 32 MB o `.zip` en streaming:** se escribe directo a disco por *Service Worker* ([`public/sw.js`](public/sw.js)) con memoria constante; si el SHA-256 falla al terminar, se aborta el flujo HTTP de descarga.
3. **Test de velocidad (`/speed`):** Abre [`https://drop.oloxx.dev/speed`](https://drop.oloxx.dev/speed) entre dos navegadores para medir RTT, caudal bidireccional y ruta directa vs. TURN.

### Terminal CLI (`drop`)

| Comando | Descripción |
|---|---|
| `drop send <rutas...>` | Enviar archivos, carpetas, `--text`, `--clipboard` o `stdin` (`-`) |
| `drop recv <código\|url>` | Recibir con filtros glob, escritura atómica `.part` y reanudación |
| `drop speed [código\|url]` | Medir RTT, velocidad bidireccional y ruta (TCP directo vs. relay) |
| `drop serve` | Levantar web estática + servidor WebSocket de señalización y relay |
| `drop config` | Menú interactivo de configuración inicial y preferencias persistentes (`config.json`) |
| `drop verify-web [url]` | Verificar una web Drop contra el árbol de GitHub del commit servido |
| `drop update` | Autoactualizar desde GitHub Releases verificando Minisign + SHA-256 |
| `drop install` / `uninstall` | Instalar o retirar el binario del `PATH` de usuario |
| `drop completion <shell>` | Generar autocompletado (`bash`, `zsh`, `fish`, `powershell`) |

#### Enviar (`drop send`)

```bash
drop send pelicula.mkv                       # un archivo
drop send a.jpg b.pdf fotos/                 # varios archivos y árboles de carpetas
drop send pelicula.mkv --limit 10M --once    # limitar ancho de banda (500K, 10M, 1.5G) y cerrar tras 1 envío
drop send backup.tar -y --expire 30m --no-qr # aceptar pares sin preguntar, caducar en 30m, ocultar QR
drop send --text "clave wifi"                # enviar texto como message.txt
drop send --clipboard                        # enviar portapapeles del sistema como clipboard.txt
tar czf - src/ | drop send - --name src.tgz  # enviar desde stdin (un receptor, implica --once)
```

* Las carpetas conservan rutas relativas omitiendo enlaces simbólicos y directorios vacíos; los receptores cortan ante saltos `../`.
* Antes de enviar metadatos o bytes, `drop` muestra IP del par, transporte y la huella de 3 palabras (`SAS`) y pide confirmación `(S/n)` salvo con `-y` / `--yes` (o si `stdin` no es interactivo).

#### Recibir (`drop recv`)

```bash
drop recv 4271-lemon-radar-tiger-orbit
drop recv "4271 LEMON Radar tiger orbit"     # admite espacios, mayúsculas o prefijos de 4 letras
drop recv https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit
drop recv 4271-lemon-radar-tiger-orbit -o ./descargas --only "*.jpg,fotos/**"
drop recv 4271-lemon-radar-tiger-orbit --overwrite --limit 2M --no-resume
drop recv 4271-lemon-radar-tiger-orbit --stdout | tar xzf -
```

* **Escritura segura y atómica:** descarga a `<nombre>.part` y solo renombra al verificar SHA-256. No sobrescribe existentes salvo con `--overwrite` (guarda `nombre (2).ext`).
* **Reanudación automática:** tras un corte, comprueba el SHA-256 del prefijo `.part` contra el emisor (CLI o Web) y retoma desde ese byte (`--no-resume` empieza de cero).
* **Tuberías (`--stdout` / `-o -`):** el progreso sale por `stderr` y los bytes verificados salen por `stdout`.

#### Preferencias por Defecto (`drop config`)

```bash
drop config                                  # menú interactivo para editar tus opciones por defecto
drop config init                             # asistente guiado paso a paso para la configuración inicial
drop config show                             # ver configuración activa y origen de cada valor (config / env / defecto)
drop config set out ~/Downloads              # fijar una preferencia rápida (también: get, unset, reset, path)
```

* Se guarda en `%APPDATA%\drop\config.json` (Windows) o `$XDG_CONFIG_HOME/drop/config.json` / `~/.config/drop/config.json` (Linux/macOS); puedes cambiar la ruta con `DROP_CONFIG` o `DROP_CONFIG_DIR`.
* Precedencia estricta: **flags CLI > variables de entorno (`DROP_SERVER`, `DROP_NO_AUTO_UPDATE`) > `config.json` > valores por defecto**. Puedes anular cualquier preferencia puntualmente con `--no-config`, `--no-once`, `--no-yes`, `--qr`, `--no-overwrite`, `--resume`, `--no-relay`, `--no-expire`, `--no-direct-only` o `--limit 0`.

#### Servidor Local, Test de Velocidad y Verificación Web

```bash
drop serve                                   # web embebida + relay WS en el puerto 3000 (0.0.0.0 y ::)
drop serve -p 8080 -H 127.0.0.1              # en pares pasar -s http://<ip-local>:8080 (o DROP_SERVER)

drop speed                                   # test bidireccional en terminal (--direct-only, --relay, -t <s>)
drop verify-web https://drop.oloxx.dev       # valida public/ contra el commit de /version (usa GITHUB_TOKEN si existe)
```

<details>
<summary><strong>Autocompletado de shell y gestión del CLI</strong></summary>

```bash
eval "$(drop completion bash)"                                  # ~/.bashrc
eval "$(drop completion zsh)"                                   # ~/.zshrc
drop completion fish > ~/.config/fish/completions/drop.fish     # fish
drop completion powershell | Out-String | Invoke-Expression     # $PROFILE
```

```bash
drop update       # descargar y verificar la última release firmada
drop install      # instalar el binario en PATH
drop uninstall    # eliminar binario y entrada de PATH
drop --help       # ayuda completa de comandos y flags
```

</details>

---

## Compatibilidad y Velocidades

Las cuatro combinaciones emisor/receptor funcionan entre sí bajo el **Protocolo 5** congelado ([`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md), [`docs/PROTOCOL.md`](docs/PROTOCOL.md)):

| Emisor → Receptor | Transporte | Cifrado | Reanudación tras corte |
|---|---|---|---|
| **Web → Web** | WebRTC DataChannel (directo o TURN) | DTLS | Empieza de cero (recupera en sesión si cae un eslabón de la cadena) |
| **CLI → CLI** | TCP directo (LAN, UPnP/NAT-PMP, STUN, IPv4/IPv6) o relay WS | AES-256-GCM (scrypt) | Sí (TCP directo y relay; no en `stdin`) |
| **CLI → Web** | Relay WebSocket cifrado | AES-256-GCM (scrypt) | No (el navegador no puede continuar archivos previos en Descargas) |
| **Web → CLI** | Relay WebSocket cifrado | AES-256-GCM (scrypt) | Sí (prefijo `.part` verificado con SHA-256) |

### Velocidades Esperadas

| Ruta | Cómo conectan los pares | Velocidad típica |
|---|---|---|
| **CLI ↔ CLI (LAN)** | Broadcast IPv4 + multicast IPv6 (`ff02::1:42424`) + mDNS (`_drop._tcp.local`) + `TCP_NODELAY` | **100–115 MB/s** (satura Gigabit / Wi-Fi 6) |
| **CLI ↔ CLI (WAN directo)** | IPv6 global, UPnP / NAT-PMP (`5351`) o puerto `-p` abierto | Ancho de banda completo de tu ISP |
| **CLI ↔ CLI (relay) / CLI ↔ Web** | Relay WebSocket `AES-256-GCM` | Limitada por el VPS y `DROP_RELAY_LIMIT` |
| **Web ↔ Web** | WebRTC DataChannel directo (o respaldo TURN) | **~15 MB/s** directo (techo SCTP del navegador) |

---

## Arquitectura y Seguridad

### Modelo del Código Dividido

| Parte | Papel | ¿Sale del dispositivo? |
|---|---|---|
| `4271` | ID público y efímero de sala | Sí (al servidor, y como hash `roomHash` en LAN) |
| `lemon-radar-tiger-orbit` | Secreto compartido sorteado localmente (BIP-39, 2048 palabras) | **Nunca** (ni en claro ni hasheado) |

* **Derivación y verificación:** 4 palabras BIP-39 (**44 bits**) se estiran con **`scrypt`** (`N = 32768`, `r = 8`, `p = 1`, 32 MiB RAM) con sal `SHA-256("drop-code-v2|" + roomId)`. Los extremos validan el conocimiento mutuo antes de enviar metadatos y muestran la huella **SAS** de 3 palabras (`beef-grit-two`) calculada desde los *fingerprints* DTLS o la clave derivada.
* **Motores de transporte:** el CLI en Rust (`cli/`) descubre pares LAN en < 10 ms y usa aceleración hardware `AES-NI`; el cliente web (`public/app.js`) regula el flujo por marcas de agua (`HIGH_WATER = 8 MB`, `LOW_WATER = 1 MB`) sobre DataChannels ordenados.
* **Límites conocidos:** sin auditoría criptográfica externa pagada; sin PAKE (depende de límites por IP y cierre de sala ante intentos fallidos); y un servidor web comprometido puede servir JS alterado a un navegador aunque `drop verify-web` pase en otro (usa el CLI nativo o `drop serve` local si necesitas garantía absoluta). Ver [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) y [`SECURITY.md`](SECURITY.md).

---

## Autoalojamiento y Desarrollo

### Docker Compose (Pila Completa)

```bash
cp .env.example .env
docker compose up -d --build
```

Arranca el servidor Node.js sin estado, **Caddy** (HTTPS automático con Let's Encrypt) y **coturn** (credenciales TURN efímeras con HMAC). Ver [`DEPLOY-VPS.md`](DEPLOY-VPS.md) para puertos, `DROP_RELAY_LIMIT` y rotación de secretos.

### Compilación y Tests Locales

Requiere **Node.js >= 22.9** y **Rust / Cargo (estable)**:

```bash
npm install
npm run dev           # servidor local en http://localhost:3000
npm run build:cli     # compila CLI release en cli/target/release/drop(.exe)
npm run cli -- send archivo.bin

cargo test --manifest-path cli/Cargo.toml
npm test              # suite completa de integración, serve, cabeceras y E2E en Chrome
```

Los scripts multiplataforma (`build:exe`, `build:linux`, `build:arm`, `build:macos`) y benchmarks (`bench`, `bench:cli`, `bench:speed`, `bench:fanout`, `bench:webrelay`) están en [`package.json`](package.json).

---

## Documentación y Licencia

| Documento | Contenido |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Entorno, benchmarks, convenciones y checklist de release |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | Protocolo 5 congelado, cuotas, E2EE y control de flujo |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) | Matriz de compatibilidad entre versiones y CLI/Web |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Modelo de amenaza completo, vectores y mitigaciones |
| [`docs/RUST-MIGRATION.md`](docs/RUST-MIGRATION.md) | Arquitectura del CLI en Rust y comparativa frente a Node.js SEA |
| [`DEPLOY-VPS.md`](DEPLOY-VPS.md) | Despliegue en VPS, firewall, Caddy, TURN y monitorización |
| [`SECURITY.md`](SECURITY.md) | Política de divulgación de vulnerabilidades |
| [`CHANGELOG.md`](CHANGELOG.md) | Historial de versiones |
| [`ROADMAP.md`](ROADMAP.md) | Camino hacia la `v1.0` |

Licenciado bajo [Apache License 2.0](LICENSE).
