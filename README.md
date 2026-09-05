# Drop 📦⚡

Transferencia de archivos P2P cifrada de extremo a extremo, sin cuentas y sin límites de tamaño.

Los archivos viajan **directamente entre dispositivos**: el servidor actúa exclusivamente como señalizador para que ambos extremos se encuentren.

```
  Tú                     Servidor                   Receptor
  │  1. Crear sala ──────► (devuelve "4271")            ▲
  │     + sorteas las palabras aquí mismo               │
  │                                                     │
  │  2. Dictas 4271-lemon-radar-tiger-orbit ────────────┤ 3. Lo teclea, o abre el enlace
  │◄── 4. Señalización (SDP/ICE o IPs locales) ────────►│
  │                                                     │
  │  5. TRANSFERENCIA P2P DIRECTA CIFRADA (E2EE) ──────►│
  └─────────────────────────────────────────────────────┘
```

El código tiene dos mitades con papeles distintos: **`4271` identifica la sala** y es lo
único que viaja al servidor; **las cuatro palabras son el secreto** del que sale la clave
de cifrado y no salen nunca de tu equipo. Detalle completo en
[Modelo de seguridad del código](#-modelo-de-seguridad-del-código).

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

## 📥 Descargas (Versión v0.4.0)

Descarga directa de los binarios autónomos (sin necesidad de tener Node.js instalado) desde la [Release v0.4.0](https://github.com/Oloxx/drop/releases/tag/v0.4.0):

* **Windows (x64):** [`drop-v0.4.0-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.4.0/drop-v0.4.0-windows-x64.exe)
* **Linux (x64):** [`drop-v0.4.0-linux-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.4.0/drop-v0.4.0-linux-x64.tar.gz)
* **Linux (ARM64):** [`drop-v0.4.0-linux-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.4.0/drop-v0.4.0-linux-arm64.tar.gz) *(Raspberry Pi, VPS Oracle ARM, AWS Graviton)*
* **macOS (Apple Silicon):** [`drop-v0.4.0-macos-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.4.0/drop-v0.4.0-macos-arm64.tar.gz) *(M1, M2, M3, M4)*
* **macOS (Intel):** [`drop-v0.4.0-macos-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.4.0/drop-v0.4.0-macos-x64.tar.gz)

---

## 🛠️ Instalación en el Sistema

### Windows
Simplemente **descarga [`drop-v0.4.0-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.4.0/drop-v0.4.0-windows-x64.exe) y haz doble clic sobre él**.
1. Se abrirá una ventana que lo copiará automáticamente a tu carpeta de programas (`%LOCALAPPDATA%\Programs\drop\`).
2. Añadirá de forma automática y permanente la ruta a tu variable de entorno `PATH`.
3. Ya podrás abrir cualquier terminal (**PowerShell, CMD o Windows Terminal**) y usar directamente el comando `drop`.

### Linux / macOS
Descarga el archivo correspondiente, extráelo y ejecútalo con `install`:
```bash
tar -xzf drop-v0.4.0-linux-x64.tar.gz
./drop-v0.4.0-linux-x64 install
```
*(O muévelo manualmente a tu ruta del sistema: `sudo mv drop-linux-x64 /usr/local/bin/drop && chmod +x /usr/local/bin/drop`)*

---

## 📖 Guía de Uso

### Modo 1: Desde la Web (Navegador)

> Web en producción: **[https://drop.oloxx.dev](https://drop.oloxx.dev)**

1. **Enviar:**
   * Abre la web, arrastra tus archivos y pulsa **Crear enlace**.
   * Comparte el **código** (ej. `4271-lemon-radar-tiger-orbit`), que se puede dictar por teléfono,
     o el enlace equivalente (`https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit`).
   * Mantén la pestaña abierta mientras se transfieren los archivos.
2. **Recibir:**
   * El receptor abre el enlace en su navegador, **o** entra en la web y teclea el código
     en el campo *«…or receive: type the code you were given»*.
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
  Código:  4271-lemon-radar-tiger-orbit
  Enlace:  https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit

  Díctaselo tal cual, o pásale el enlace. En el otro equipo:
    drop recv 4271-lemon-radar-tiger-orbit

  Esperando a que el receptor se conecte...
```

#### 2. Recibir archivos (`drop recv`)
En otro ordenador con `drop` instalado:
```bash
# Usando el código que te han dictado
drop recv 4271-lemon-radar-tiger-orbit

# Da igual cómo lo teclees: mayúsculas, espacios en vez de guiones o prefijos de
# 4 letras. Todo esto es el mismo código:
drop recv "4271 LEMON Radar tiger orbit"
drop recv 4271-lemo-rada-tige-orbi

# O pegando el enlace web completo
drop recv https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit

# Opcional: especificar carpeta de destino (-o o --out)
drop recv 4271-lemon-radar-tiger-orbit -o D:\Descargas
```

#### 3. Test de velocidad entre terminales (`drop speed`)
Mide la latencia (RTT), velocidad simétrica de subida/bajada y ruta de red (TCP directa o Relay) entre dos clientes CLI:
```bash
# En el primer equipo (Anfitrión)
drop speed

# En el segundo equipo (Invitado)
drop speed <código>
```

#### 4. Interoperabilidad total (CLI ↔ Web Browser)
Si envías un archivo con `drop send` y el destinatario **no tiene instalada la terminal**, ¡no pasa nada!
* Puede abrir el enlace generado (`https://drop.oloxx.dev/#...`) directamente en **Chrome, Edge, Firefox o Safari**,
  o entrar en la web y teclear el código.
* El receptor verá los archivos y el botón **Descargar**.
* El CLI detecta automáticamente la conexión web y transmite los archivos en streaming continuo por WebSocket.

#### 5. Comandos de gestión del CLI
```bash
drop update       # Comprueba y actualiza automáticamente a la última versión de GitHub
drop install      # Instala drop en el sistema y lo añade al PATH
drop uninstall    # Desinstala drop del sistema y limpia el PATH
drop --version    # Muestra la versión instalada
drop --help       # Muestra la ayuda de comandos
```

---

## ⚙️ ¿Cómo funciona por dentro?

### 1. Transferencia Nativa CLI (TCP + AES-256-GCM)
* **Descubrimiento LAN instantáneo:** Emite pings por broadcast UDP (puerto `42424`). En la misma red Wi-Fi o cable, los equipos se encuentran en **< 10 milisegundos** y transfieren por IP privada local sin salir a internet.
* **Sockets TCP Directos:** Utiliza `socket.setNoDelay(true)` con búferes de lectura/escritura de 2–4 MB en streaming continuo.
* **Cifrado E2EE nativo:** Cifrado simétrico AES-256-GCM con aceleración hardware `AES-NI`. La clave
  sale de las cuatro palabras del código pasadas por `scrypt` (ver abajo), nunca del identificador de sala.

### 2. Transferencia Web (WebRTC DataChannel)
* **Protocolo mínimo:** Control en JSON (`manifest`, `accept`, `start`, `ack`, `end`, `done`) y datos en trozos binarios continuos.
* **Control de flujo reactivo:** Evita desbordar la memoria pausando la lectura al superar 8 MB en el búfer de envío y reanudando al bajar de 1 MB.
* **Cadena multi-receptor (Fanout Chain):** Cuando varios amigos descargan a la vez, se organizan en cadena (`Emisor → A → B → C`). El emisor sube **una sola copia** de los datos, ahorrando ancho de banda de subida.

---

## 🔐 Modelo de seguridad del código

El código es `4271-lemon-radar-tiger-orbit` y son **dos cosas distintas pegadas con un guion**:

| Parte | Qué es | ¿Sale de tu equipo? |
|---|---|---|
| `4271` | Identificador **público** de sala, lo reparte el servidor | Sí: al servidor y, hasheado, al broadcast UDP de la LAN |
| `lemon-radar-tiger-orbit` | **Secreto** compartido, lo sortea tu cliente | **Nunca.** Ni en claro, ni hasheado, ni al servidor, ni por UDP |

* **Entropía:** 4 palabras de la lista **BIP-39 en inglés** (2048 palabras, licencia CC0,
  copia íntegra en [`public/shared/wordlist.js`](public/shared/wordlist.js)) = **44 bits exactos**.
  Se eligió BIP-39 porque 2048 = 2¹¹ da 11 bits limpios por palabra y porque sus prefijos de
  4 letras son únicos, que es lo que permite corregir erratas al teclear.
* **Derivación de clave:** la clave AES-256-GCM sale de las palabras por **`scrypt`**
  (N=2¹⁵, r=8, p=1 → 32 MB y ~62 ms medidos), con el identificador de sala como sal.
  No se usa HKDF a propósito: con 44 bits, un hash rápido se rompería por fuerza bruta en
  horas; con scrypt haría falta ~3,5 × 10¹⁰ años-CPU.
* **Lo que ve el servidor:** `4271` y nada más. No puede descifrar, y tampoco puede atacar
  el secreto offline porque no tiene ningún verificador de él.
* **Lo que ve tu vecino de Wi-Fi:** el paquete de descubrimiento UDP lleva un hash del
  identificador **público**. Aprende que hay una sala `4271` en tal IP y puerto; sin las
  palabras, AES-GCM le rechaza el primer paquete.
* **Lo que NO cubre:** los identificadores de sala son 10.000 y se pueden probar. El servidor
  limita los intentos fallidos por IP y cierra la sala si el emisor denuncia varios receptores
  que no saben el secreto, pero eso encarece el barrido, no lo impide. Quien acierte una sala
  no obtiene ni los archivos ni sus nombres: el emisor le pide antes una prueba de conocimiento
  del secreto. Tampoco hay defensa contra un *man in the middle* activo con control del servidor:
  eso exigiría un PAKE (SPAKE2/CPace) y no se implementa a mano sin auditar.

El diseño completo, con el razonamiento y los límites, está comentado en la cabecera de
[`public/shared/codes.js`](public/shared/codes.js).

### Compatibilidad con la v0.3.5

Los binarios ya distribuidos usan tokens de 96 bits (`T_9q_4uzB9iJAf8x`), donde el token entero
**era** la clave de cifrado. Darles un identificador de 4 dígitos les dejaría el AES en 13 bits,
así que el servidor **sigue sirviéndoles el formato viejo**: solo entrega códigos nuevos a los
clientes que lo piden explícitamente (`v:2`). Un cliente v0.4.0 también sabe *recibir* con un
código antiguo. Emparejar una v0.3.5 con una v0.4.0 no funciona (los formatos de código son
distintos) y no se puede arreglar sin debilitar a una de las dos. Todo el camino antiguo está
marcado `@deprecated` y se elimina en la v0.5.0.

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
npm run build:exe     # Compila dist/drop-windows-x64.exe (Windows x64)
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
