# Drop 📦⚡

Transferencia de archivos P2P cifrada de extremo a extremo, sin cuentas y sin límites de tamaño.

Los archivos viajan **directamente entre dispositivos**: el servidor actúa exclusivamente como señalizador para que ambos extremos se encuentren.

```
  Tú                     Servidor                   Receptor
  │  1. Crear sala ──────► (devuelve un token)          ▲
  │                                                     │
  │  2. Pasas el enlace / código ───────────────────────┤ 3. Abre enlace o ejecuta CLI
  │◄── 4. Señalización (SDP/ICE o IPs locales) ────────►│
  │                                                     │
  │  5. TRANSFERENCIA P2P DIRECTA CIFRADA (E2EE) ──────►│
  └─────────────────────────────────────────────────────┘
```

---

## 🚀 Dos Modos de Uso

| Característica | 🌐 Drop Web | 💻 Drop CLI (`drop`) |
|---|---|---|
| **Ideal para** | Amigos, móviles, tablets, envíos rápidos | Archivos gigantes (ISOs, backups, vídeos) |
| **Instalación** | **Cero**. Solo abrir el navegador | **Auto-instalable** (1 clic) sin dependencias |
| **Protocolo** | WebRTC DataChannel | Sockets TCP directos + LAN UDP Broadcast |
| **Velocidad** | ~15 MB/s (límite SCTP del navegador) | **100–115 MB/s** (satura Gigabit / Wi-Fi 6) |
| **Compatibilidad** | Navegador a Navegador | **CLI a CLI** y **CLI a Web Browser** |

---

## 📥 Descargas (Versión v0.2.0)

Descarga directa de los binarios autónomos (sin necesidad de tener Node.js instalado) desde la [Release v0.2.0](https://github.com/Oloxx/drop/releases/tag/v0.2.0):

* **Windows (x64):** [`drop.exe`](https://github.com/Oloxx/drop/releases/download/v0.2.0/drop.exe)
* **Linux (x64):** [`drop-linux-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.2.0/drop-linux-x64.tar.gz)
* **Linux (ARM64):** [`drop-linux-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.2.0/drop-linux-arm64.tar.gz) *(Raspberry Pi, VPS Oracle ARM, AWS Graviton)*
* **macOS (Apple Silicon):** [`drop-macos-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.2.0/drop-macos-arm64.tar.gz) *(M1, M2, M3, M4)*
* **macOS (Intel):** [`drop-macos-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.2.0/drop-macos-x64.tar.gz)

---

## 🛠️ Instalación en el Sistema

### Windows
Simplemente **descarga [`drop.exe`](https://github.com/Oloxx/drop/releases/download/v0.2.0/drop.exe) y haz doble clic sobre él**.
1. Se abrirá una ventana que lo copiará automáticamente a tu carpeta de programas (`%LOCALAPPDATA%\Programs\drop\`).
2. Añadirá de forma automática y permanente la ruta a tu variable de entorno `PATH`.
3. Ya podrás abrir cualquier terminal (**PowerShell, CMD o Windows Terminal**) y usar directamente el comando `drop`.

### Linux / macOS
Descarga el archivo correspondiente, extráelo y ejecútalo con `install`:
```bash
tar -xzf drop-linux-x64.tar.gz
./drop-linux-x64 install
```
*(O muévelo manualmente a tu ruta del sistema: `sudo mv drop-linux-x64 /usr/local/bin/drop && chmod +x /usr/local/bin/drop`)*

---

## 📖 Guía de Uso

### Modo 1: Desde la Web (Navegador)

> Web en producción: **[https://drop.oloxx.dev](https://drop.oloxx.dev)**

1. **Enviar:**
   * Abre la web, arrastra tus archivos y pulsa **Crear enlace**.
   * Copia el enlace único generado (ej. `https://drop.oloxx.dev/#T_9q_4uzB9iJAf8x`) y compártelo.
   * Mantén la pestaña abierta mientras se transfieren los archivos.
2. **Recibir:**
   * El receptor abre el enlace en su navegador.
   * Pulsa **Descargar**. Con la *File System Access API* (Chrome/Edge), se guardan en streaming directo a la carpeta elegida; en navegadores sin esta API, se descargan a la carpeta habitual de Descargas.
3. **Test de velocidad P2P (`/speed`):**
   * Abre `https://drop.oloxx.dev/speed` para medir latencia (RTT), velocidad simétrica de subida/bajada y si la ruta es directa o rebotada por TURN.

---

### Modo 2: Desde la Terminal (`drop` a máxima velocidad)

#### 1. Enviar archivos (`drop send`)
Abre cualquier terminal y pasa los archivos que quieras enviar:
```bash
# Enviar un archivo
drop send pelicula.mkv

# Enviar múltiples archivos a la vez
drop send foto1.jpg foto2.jpg documento.pdf "C:\Descargas\backup.iso"
```

Salida en terminal:
```text
Preparando envío: 1 archivo(s) · 5.8 GB

  ✔ Canal abierto.
  Código:  T_9q_4uzB9iJAf8x
  Enlace:  https://drop.oloxx.dev/#T_9q_4uzB9iJAf8x

  Esperando a que el receptor se conecte...
```

#### 2. Recibir archivos (`drop recv`)
En otro ordenador con `drop` instalado:
```bash
# Usando el código corto
drop recv T_9q_4uzB9iJAf8x

# O pegando el enlace web completo
drop recv https://drop.oloxx.dev/#T_9q_4uzB9iJAf8x

# Opcional: especificar carpeta de destino (-o o --out)
drop recv T_9q_4uzB9iJAf8x -o D:\Descargas
```

#### 3. Interoperabilidad total (CLI ↔ Web Browser)
Si envías un archivo con `drop send` y el destinatario **no tiene instalada la terminal**, ¡no pasa nada!
* Puede abrir el enlace generado (`https://drop.oloxx.dev/#...`) directamente en **Chrome, Edge, Firefox o Safari**.
* El receptor verá los archivos y el botón **Descargar**.
* El CLI detecta automáticamente la conexión web y transmite los archivos en streaming continuo por WebSocket.

#### 4. Comandos de gestión del CLI
```bash
drop --help       # Muestra la ayuda de comandos
drop --version    # Muestra la versión instalada
drop install      # Instala o actualiza drop en el sistema y en el PATH
drop uninstall    # Desinstala drop del sistema y limpia el PATH
```

---

## ⚙️ ¿Cómo funciona por dentro?

### 1. Transferencia Nativa CLI (TCP + AES-256-GCM)
* **Descubrimiento LAN instantáneo:** Emite pings por broadcast UDP (puerto `42424`). En la misma red Wi-Fi o cable, los equipos se encuentran en **< 10 milisegundos** y transfieren por IP privada local sin salir a internet.
* **Sockets TCP Directos:** Utiliza `socket.setNoDelay(true)` con búferes de lectura/escritura de 2–4 MB en streaming continuo.
* **Cifrado E2EE nativo:** Cifrado simétrico AES-256-GCM con claves derivadas por HKDF a partir del token de la sala, con aceleración hardware `AES-NI`.

### 2. Transferencia Web (WebRTC DataChannel)
* **Protocolo mínimo:** Control en JSON (`manifest`, `accept`, `start`, `ack`, `end`, `done`) y datos en trozos binarios continuos.
* **Control de flujo reactivo:** Evita desbordar la memoria pausando la lectura al superar 8 MB en el búfer de envío y reanudando al bajar de 1 MB.
* **Cadena multi-receptor (Fanout Chain):** Cuando varios amigos descargan a la vez, se organizan en cadena (`Emisor → A → B → C`). El emisor sube **una sola copia** de los datos, ahorrando ancho de banda de subida.

---

## 💻 Desarrollo y Compilación Local

### Requisitos
* Node.js >= 18

```bash
# Instalar dependencias
npm install

# Iniciar servidor local de desarrollo (http://localhost:3000)
npm run dev

# Ejecutar el CLI en modo desarrollo
npm run cli -- send mi_archivo.zip

# Ejecutar la suite de tests
npm test

# Benchmarks de velocidad
npm run bench:cli   # Benchmark del motor TCP nativo (~110 MB/s)
npm run bench       # Benchmark WebRTC en navegador (~15 MB/s)
npm run bench:fanout # Benchmark de cadena multi-receptor
```

### Compilar ejecutables autónomos (Cross-Compilation)
El script [`scripts/build-cross.mjs`](scripts/build-cross.mjs) permite compilar los binarios de todas las plataformas desde cualquier sistema operativo utilizando Node SEA (*Single Executable Application*):

```bash
npm run build:exe     # Compila dist/drop.exe (Windows x64)
npm run build:linux   # Compila dist/drop-linux-x64 (Linux x64)
npm run build:arm     # Compila dist/drop-linux-arm64 (Linux ARM64 / Raspberry Pi)
npm run build:macos   # Compila dist/drop-macos-arm64 (macOS Apple Silicon)
npm run build:all     # Compila todas las plataformas a la vez
```

---

## 🌐 Despliegue del Servidor

El servidor actúa únicamente como guía de señalización (emparejamiento) y nunca almacena archivos.

Para desplegar tu propia instancia en un VPS (ej. Oracle Cloud Always Free):
```bash
cp .env.example .env
docker compose up -d --build
```
Levanta el servidor Node.js, un reverse proxy Caddy con certificados SSL automáticos y un servidor TURN (coturn) para sortear NATs estrictas. Guía detallada en **[DEPLOY-VPS.md](DEPLOY-VPS.md)**.
