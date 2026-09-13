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

## 📥 Descargas (Versión v0.6.0)

Descarga directa de los binarios autónomos (sin necesidad de tener Node.js instalado) desde la [Release v0.6.0](https://github.com/Oloxx/drop/releases/tag/v0.6.0):

* **Windows (x64):** [`drop-v0.6.0-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.6.0/drop-v0.6.0-windows-x64.exe)
* **Linux (x64):** [`drop-v0.6.0-linux-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.6.0/drop-v0.6.0-linux-x64.tar.gz)
* **Linux (ARM64):** [`drop-v0.6.0-linux-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.6.0/drop-v0.6.0-linux-arm64.tar.gz) *(Raspberry Pi, VPS Oracle ARM, AWS Graviton)*
* **macOS (Apple Silicon):** [`drop-v0.6.0-macos-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.6.0/drop-v0.6.0-macos-arm64.tar.gz) *(M1, M2, M3, M4)*
* **macOS (Intel):** [`drop-v0.6.0-macos-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.6.0/drop-v0.6.0-macos-x64.tar.gz)


### Verificar la descarga

Cada release publica un `SHA256SUMS` con el hash de todos los binarios y un `SHA256SUMS.minisig` con su firma. Son dos comprobaciones distintas y conviene hacer las dos: el hash dice que el binario ha llegado entero, la firma dice que lo publicó quien tiene la clave del proyecto.

**1. La firma** (a partir de la v0.5.2), con [minisign](https://jedisct1.github.io/minisign/):

```bash
minisign -Vm SHA256SUMS -P RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp
```

Esa clave pública es la del proyecto; la privada solo la usa el workflow de release. Si `minisign` responde `Signature and comment signature verified`, el `SHA256SUMS` es auténtico.

**2. El hash** del binario que has bajado:

```bash
# Linux / macOS
sha256sum -c SHA256SUMS --ignore-missing

# Windows (PowerShell)
Get-FileHash drop-v0.6.0-windows-x64.exe -Algorithm SHA256
```

`drop update` hace las dos por su cuenta antes de sustituir el ejecutable y aborta si algo no cuadra. Con una release anterior a la v0.5.2, que no lleva firma, avisa y exige `--allow-unsigned` para seguir: así, borrar la firma no basta para que se conforme con el hash.

---

## 🛠️ Instalación en el Sistema

### Windows
Simplemente **descarga [`drop-v0.6.0-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.6.0/drop-v0.6.0-windows-x64.exe) y haz doble clic sobre él**.
1. Se abrirá una ventana que lo copiará automáticamente a tu carpeta de programas (`%LOCALAPPDATA%\Programs\drop\`).
2. Añadirá de forma automática y permanente la ruta a tu variable de entorno `PATH`.
3. Ya podrás abrir cualquier terminal (**PowerShell, CMD o Windows Terminal**) y usar directamente el comando `drop`.

### Linux / macOS
Descarga el archivo correspondiente, extráelo y ejecútalo con `install`:
```bash
tar -xzf drop-v0.6.0-linux-x64.tar.gz
./drop-v0.6.0-linux-x64 install
```
*(O muévelo manualmente a tu ruta del sistema: `sudo mv drop-linux-x64 /usr/local/bin/drop && chmod +x /usr/local/bin/drop`)*

---

## 📖 Guía de Uso

### Modo 1: Desde la Web (Navegador)

> Web en producción: **[https://drop.oloxx.dev](https://drop.oloxx.dev)**

1. **Enviar:**
   * Abre la web, arrastra tus archivos **o carpetas** (o *pick a folder*) y pulsa **open channel**.
     Una carpeta viaja con su árbol; en el receptor, con la *File System Access API*
     (Chrome/Edge), se recrea tal cual en la carpeta elegida; en otros navegadores cada archivo
     baja suelto con su nombre.
   * Comparte el **código** (ej. `4271-lemon-radar-tiger-orbit`), que se puede dictar por teléfono,
     o el enlace equivalente (`https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit`).
   * Para un móvil, pulsa **qr**: enfoca la pantalla con la cámara y se abre el enlace, sin
     teclear nada ni pasárselo por otra aplicación. El QR se genera en la propia página
     ([`public/shared/qr.js`](public/shared/qr.js)): sigue sin haber peticiones a terceros.
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

# Enviar una carpeta entera: llega con su árbol (fotos/verano/playa.jpg)
drop send fotos/
```

Al enviar una carpeta viaja la ruta relativa de cada archivo y el receptor la recrea dentro de
su directorio de destino. Los enlaces simbólicos se saltan y las carpetas vacías no viajan (no
tienen bytes que verificar). El receptor acepta esas rutas **solo hacia abajo**: un manifiesto
con `../` no degrada al nombre suelto, corta la transferencia.

Salida en terminal:
```text
Preparando envío: 1 archivo(s) · 5.8 GB

  ✔ Canal abierto.
  Código:  4271-lemon-radar-tiger-orbit
  Enlace:  https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit
  Huella:  beef-grit-two (el receptor tiene que ver esta misma por TCP directo)

  Díctaselo tal cual, o pásale el enlace. En el otro equipo:
    drop recv 4271-lemon-radar-tiger-orbit

  █▀▀▀▀▀█ ▄▀ ▀▄█ █▀▀▀▀▀█
  █ ███ █ ▀▄▀▄ ▄  █ ███ █     (el QR del enlace, para abrirlo
  █ ▀▀▀ █ █ ▀ ▄▀█ █ ▀▀▀ █      desde el móvil con la cámara)
  ▀▀▀▀▀▀▀ ▀ █ ▀ ▀ ▀▀▀▀▀▀▀
  Escanéalo con el móvil para abrir el enlace. (--no-qr lo quita)

  Esperando a que el receptor se conecte...
```

El QR solo se pinta cuando la salida es una terminal (en un log o una tubería no lo lee
nadie) y va con los colores forzados, fondo blanco y tinta negra, para que la cámara vea la
polaridad normal tanto en un tema oscuro como en uno claro. `--no-qr` o `DROP_NO_QR=1` lo
quitan.

Cuando alguien se conecta, `drop` pregunta antes de servir nada:

```text
  Alguien quiere descargar: 192.168.1.42 (TCP directo)
  Huella de la sesión: beef-grit-two (tiene que coincidir con la que ve el receptor)
  ¿Le dejas descargar? (s/N):
```

Hasta que respondas que sí no sale del equipo ni el nombre de los archivos. Con
`--yes` (o `-y`) no pregunta, y en un script sin terminal interactiva se autoriza
solo: bloquear ahí sería colgar el proceso esperando una tecla que no va a llegar.
Qué es la huella y qué detecta, en
[Modelo de seguridad del código](#-modelo-de-seguridad-del-código).

**Acotar la ventana.** Un canal abierto sigue sirviendo a quien tenga el código hasta que lo
cierras; con códigos que se dictan (y se oyen de paso) conviene poder decir "esto es para
una descarga" o "esto caduca en diez minutos":

```bash
drop send backup.tar --once          # se cierra tras la primera descarga completa
drop send backup.tar --expire 10m    # caduca solo: 90s, 10m, 2h (un número suelto son minutos)
drop send backup.tar --once --expire 10m
```

Ninguno de los dos corta una descarga a medias: al caducar se deja de aceptar receptores
nuevos y el proceso sale cuando termina la que esté en curso. El servidor libera la sala en
ese momento, porque la sala vive lo que vive la conexión del emisor.

**Límite de ancho de banda.** El motor TCP satura Gigabit a propósito, lo cual está muy bien
salvo cuando hay alguien más usando la línea:

```bash
drop send pelicula.mkv --limit 10M      # 500K, 10M, 1.5G: bytes por segundo, en base 1024
drop recv 4271-lemon-radar-tiger-orbit --limit 2M
```

Vale en los dos lados. En el emisor es un solo cubo para todos los receptores (lo que sale de
este equipo); en el receptor frena la lectura, y el emisor se frena solo por contrapresión (TCP)
o por los acuses (relay). La barra y el ETA salen del caudal real, así que siguen siendo ciertos.

**Texto y portapapeles.** Para mandar un fragmento sin crear un archivo antes:

```bash
drop send --text "la clave del wifi es ..."     # viaja como message.txt
drop send --clipboard                            # el portapapeles, como clipboard.txt
drop recv 4271-lemon-radar-tiger-orbit --stdout  # lo recibido, a stdout (también: -o -)
drop recv 4271-lemon-radar-tiger-orbit --stdout | pbcopy
```

El portapapeles se lee con las herramientas del sistema (`Get-Clipboard`, `pbpaste`,
`wl-paste`/`xclip`/`xsel`) y si no hay ninguna se dice cuál instalar. Con `--stdout` los
mensajes y el progreso se van a stderr, y el contenido se vuelca solo cuando el SHA-256 ha
cuadrado: una tubería no se puede rebobinar.

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

# Opcional: sobrescribir los archivos que ya existan en el destino
drop recv 4271-lemon-radar-tiger-orbit --overwrite
```

**Qué pasa si el archivo ya existe:** por defecto no se pisa nada. Cada archivo se
escribe primero como `nombre.ext.part` y solo pasa a llamarse `nombre.ext` cuando su
SHA-256 cuadra; si ese nombre ya está ocupado, el archivo nuevo se guarda como
`nombre (2).ext`. Con `--overwrite` se reemplaza el archivo existente. Una transferencia
que se corta a medias no deja nada con el nombre definitivo: el `.part` se borra.

> **Compatibilidad:** desde la versión 0.5.0 el manifiesto lleva un número de versión de
> protocolo, así que un receptor 0.5.0+ **rechaza** con un mensaje explícito a un emisor
> 0.4.2 o anterior en lugar de escribir archivos corruptos. En sentido contrario (emisor
> nuevo, receptor viejo) todo sigue funcionando. Si ves un error de versión, actualiza
> `drop` en los dos equipos con `drop update`.

#### 3. Test de velocidad entre terminales (`drop speed`)
Mide la latencia (RTT), velocidad simétrica de subida/bajada y ruta de red (TCP directa o Relay) entre dos clientes CLI:
```bash
# En el primer equipo (Anfitrión)
drop speed

# En el segundo equipo (Invitado)
drop speed <código>
```

#### 4. Interoperabilidad total (CLI ↔ Web Browser)
Cualquiera recibe de cualquiera, en las cuatro combinaciones:

| Emisor → Receptor | Camino | Cifrado |
|---|---|---|
| Web → Web | WebRTC DataChannel, directo o por TURN | DTLS |
| CLI → CLI | TCP directo (LAN, UPnP) o, si no hay ruta, relay por el servidor | AES-256-GCM con la clave del código |
| CLI → Web | Relay por el servidor (el navegador no habla el TCP del CLI) | AES-256-GCM con la clave del código |
| Web → CLI | Relay por el servidor (el CLI no habla WebRTC) | AES-256-GCM con la clave del código |

* Si envías con `drop send` y el destinatario **no tiene la terminal**, abre el enlace en **Chrome,
  Edge, Firefox o Safari**, o entra en la web y teclea el código: verá los archivos y el botón
  **receive**.
* Si el canal se abre **desde la web** y el receptor prefiere la terminal, `drop recv <código>`
  funciona igual: el CLI se presenta como tal al entrar en la sala y la página le sirve por el
  relay, cifrado, en vez de mandarle una oferta WebRTC.
* Por el relay los bytes pasan por el servidor, pero cifrados con la clave que sale de las cuatro
  palabras: el servidor reenvía ruido. Ver [¿Cómo funciona por dentro?](#️-cómo-funciona-por-dentro).

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
* **El relay también va cifrado:** cuando no hay ruta TCP directa (NAT estricta, o el receptor es un
  navegador) los bytes pasan por el servidor, pero cifrados con la misma clave: cada trozo y cada
  marco de control van en AES-256-GCM y el servidor reenvía ruido. El navegador deriva la misma clave
  con una implementación propia de `scrypt` ([`public/shared/scrypt.js`](public/shared/scrypt.js)),
  y la prueba de conocimiento del código que le manda al emisor es un HMAC con esa clave, no un hash
  de las palabras: un servidor que la vea pasar no tiene nada barato que atacar offline.

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
  del secreto, y además tiene que autorizar la descarga a mano. Sigue sin haber PAKE
  (SPAKE2/CPace), que no se implementa a mano sin auditar: contra un *man in the middle* activo
  con control del servidor lo que hay es la huella de sesión, que se compara a ojo.

### La huella de sesión

Los dos extremos muestran tres palabras — `beef-grit-two` — sacadas de lo que se ha negociado
de verdad. **Si no coinciden, hay alguien en medio.** Se comparan por otro canal: una llamada,
un mensaje, estar en la misma habitación.

| Ruta | De dónde sale la huella | Qué detecta |
|---|---|---|
| **Web ↔ Web** (WebRTC) | Los *fingerprints* DTLS de los dos extremos | **Un servidor que sustituya el SDP** para hablar DTLS con cada lado por separado. Es el ataque real que cubre |
| **CLI ↔ CLI** (TCP directo) | La clave AES ya derivada con scrypt | Que los dos estén en la misma transferencia. Aquí un MITM ya era imposible: sin las palabras, AES-GCM rechaza el primer paquete |
| **Cualquier ruta por relay** (CLI → CLI o CLI → navegador) | La clave AES derivada con scrypt, igual que por TCP directo | Que los dos hayan derivado la misma clave: por esta ruta los bytes pasan por el servidor, pero cifrados con ella. El servidor no puede leerlos ni fabricar una huella que cuadre |

La huella **no viaja por el cable** (si viajase, el de en medio la cambiaría al vuelo) y **no
lleva dentro las palabras del código**: entra material de clave, no el secreto, para que leerla
en voz alta no regale un verificador offline de 44 bits. El diseño completo está en
[`public/shared/sas.js`](public/shared/sas.js).

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

# Ejecutar la suite de tests (levanta su propio servidor, no hace falta nada mas)
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

Los binarios base de Node se descargan de nodejs.org y **se comprueban contra el
`SHASUMS256.txt` que se publica junto a ellos** antes de inyectarles nada, también los que ya
están en la caché local. Si un hash no cuadra, el fichero se borra y la compilación se detiene:
ese binario es el que acaba en las releases.

---

## 🌐 Despliegue del Servidor

El servidor actúa únicamente como guía de señalización (emparejamiento) y nunca almacena archivos.

Para desplegar tu propia instancia en un VPS (ej. Oracle Cloud Always Free):
```bash
cp .env.example .env
docker compose up -d --build
```
Levanta el servidor Node.js, un reverse proxy Caddy con certificados SSL automáticos y un servidor TURN (coturn) para sortear NATs estrictas. Guía detallada en **[DEPLOY-VPS.md](DEPLOY-VPS.md)**.

El servidor solo acepta WebSockets de navegador desde su propio dominio (`DROP_DOMAIN`) y
localhost, para que una web cualquiera no pueda abrir salas con el navegador de quien la visita.
Si sirves el frontend desde otro sitio, añade el origen con `DROP_ALLOWED_ORIGINS`. Las
conexiones sin cabecera `Origin` —el CLI— no se ven afectadas.

Las respuestas llevan una **CSP** ajustada a lo que la web usa de verdad —ni scripts ni estilos
en línea, ni una sola petición a terceros—, además de `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` y `Permissions-Policy` sin cámara, micrófono ni ubicación. HSTS lo
pone Caddy, que es donde acaba el TLS. El contenedor corre como usuario sin privilegios y declara
un `HEALTHCHECK` contra `/healthz`.

---

## 🤝 Contribuir

Las convenciones del proyecto (idiomas, estilo de comentarios, formato de commits) y cómo montar
el entorno están en **[CONTRIBUTING.md](CONTRIBUTING.md)**. El historial de versiones, en
**[CHANGELOG.md](CHANGELOG.md)**.

## 📄 Licencia

[Apache License 2.0](LICENSE). Puedes usar, modificar y redistribuir drop, incluso
comercialmente, conservando el aviso de copyright y la licencia, e indicando los cambios que
hagas. La licencia incluye además una concesión expresa de patentes.
