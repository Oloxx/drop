# Drop

Enviar archivos a un amigo desde el navegador, sin cuentas y sin subirlos a ninguna nube.
Los bytes van **directos de un navegador a otro** por WebRTC; el servidor solo hace de
"guía telefónica" para que los dos navegadores se encuentren.

```
  Tú                     servidor                  tu amigo
  │  1. crear sala ──────► (devuelve un token)
  │                             ▲
  │  2. le pasas el enlace ─────┼── 3. lo abre
  │◄── 4. SDP + ICE (el servidor solo los reenvía) ───►│
  │                                                    │
  └────────── 5. los archivos, P2P cifrado ───────────►│
```

## 📖 Guía de Uso

Drop ofrece dos formas de transferir archivos según lo que necesites:

1. **Drop Web (Fricción Cero):** Ideal para enviar archivos desde o hacia móviles, tablets y PCs al instante. Solo abres el navegador, sin instalar absolutamente nada.
2. **Drop CLI / `drop.exe` (Máxima Velocidad):** Un ejecutable independiente que no requiere instalar nada y transfiere a **100+ MB/s** mediante sockets TCP directos y descubrimiento LAN automático.

---

### Modo 1: Uso desde la Web (Navegador)

> Disponible en vivo en **https://drop.oloxx.dev** (o en local con `npm run dev`).

#### Para enviar archivos (Emisor):
1. Abre **Drop** en tu navegador.
2. **Arrastra los archivos** al recuadro (o pulsa para seleccionarlos).
3. Pulsa el botón **Crear enlace**.
4. Se generará un enlace único con un token secreto (ejemplo: `https://drop.oloxx.dev/#oEwhOqPWDixlEyHK`).
5. Pulsa **Copiar enlace** y pásaselo al receptor (por chat, correo, etc.).
6. Mantén la pestaña abierta mientras se realiza el envío.

#### Para recibir archivos (Receptor):
1. Abre el enlace que te han compartido en cualquier navegador.
2. Verás la lista de archivos que te van a enviar y el tamaño total.
3. Pulsa **Descargar**:
   * Si el archivo es grande o son varios (en Chrome/Edge), el navegador te pedirá elegir una carpeta y los guardará directamente a disco en streaming continuo.
   * En archivos individuales o en navegadores como Safari y Firefox, se descargará automáticamente a tu carpeta de Descargas.
4. Al terminar, la barra marcará `received` y el archivo estará listo en tu disco.

#### Diagnóstico de velocidad (`/speed`):
Puedes entrar en `https://drop.oloxx.dev/speed` para medir la velocidad de conexión directa con otra persona, ver el ping (RTT), el caudal de subida y bajada, y comprobar si la conexión es **directa P2P** o si pasa por un servidor **TURN**.

---

### Modo 2: Uso con el Ejecutable / CLI (`drop` a máxima velocidad)

Para mover archivos pesados entre ordenadores saturando tu red local (Wi-Fi 6 o cable Gigabit a **80–115 MB/s**), usa el ejecutable independiente.

> **Nota para los usuarios:** Los binarios son 100% autónomos. Quien use `drop` **no necesita tener Node.js instalado**.

#### 💡 Instalación en el sistema y adición al PATH:

* **En Windows:** Simplemente **descarga `drop.exe` y haz doble clic sobre él** (o ejecuta `drop install` en terminal). El ejecutable se auto-instalará en tu sistema y se añadirá de forma permanente al `PATH` de tu usuario.
* **En Linux / macOS:** Ejecuta `./drop install` o mueve el binario a tu ruta de sistema:
  ```bash
  chmod +x drop
  sudo mv drop /usr/local/bin/drop
  ```

Una vez instalado, abre cualquier terminal (PowerShell, CMD, Terminal) y usa directamente el comando `drop` desde cualquier carpeta:

#### 1. Enviar archivos (`drop send`)

Abre cualquier terminal:

```bash
# Enviar un único archivo
drop send pelicula.mkv

# Enviar múltiples archivos a la vez
drop send foto1.jpg foto2.jpg documento.pdf
```

Verás una salida como esta:
```text
Preparando envío: 1 archivo(s) · 1.5 GB
  ✔ Canal abierto.
  Código:  oEwhOqPWDixlEyHK
  Enlace:  https://drop.oloxx.dev/#oEwhOqPWDixlEyHK

  Esperando a que el receptor se conecte...
```

#### 2. Recibir archivos (`drop recv`)

En el otro ordenador, el receptor ejecuta el comando pasando el **código** o el **enlace completo**:

```powershell
# Recibir usando el código corto
.\drop.exe recv oEwhOqPWDixlEyHK

# O pegando el enlace web directamente
.\drop.exe recv https://drop.oloxx.dev/#oEwhOqPWDixlEyHK

# Opcional: especificar dónde guardar los archivos con -o o --out
.\drop.exe recv oEwhOqPWDixlEyHK -o D:\Descargas
```

#### 3. ¿Cómo conecta? (LAN vs Internet)
- **En la misma red local (Wi-Fi o cable):** Drop CLI utiliza *UDP Broadcast*. Se detectan en menos de 10 milisegundos y se transfieren por IP privada a **100–115 MB/s** sin gastar datos de internet.
- **A través de Internet:** Si no están en la misma red local, se comunican automáticamente a través del servidor de señalización para establecer la conexión TCP directa y cifrada con AES-256-GCM.

Durante la transferencia, ambos verán la barra de progreso en tiempo real:
```text
  [██████████████████████████████] 100% · 1.5 GB / 1.5 GB · 109.8 MB/s (878 Mbit/s)
  ✔ ¡Descarga completada con éxito!
```

---

### Compilar los ejecutables tú mismo

Si deseas recompilar los binarios independientes desde el código fuente para cualquier sistema operativo, ejecuta:

```bash
npm run build:exe     # Compila para Windows x64 (dist/drop.exe)
npm run build:linux   # Compila para Linux x64 (dist/drop-linux-x64)
npm run build:arm     # Compila para Linux ARM64 (dist/drop-linux-arm64, Raspberry Pi / VPS ARM)
npm run build:macos   # Compila para macOS Apple Silicon (dist/drop-macos-arm64)
npm run build:all     # Compila todas las plataformas de golpe
```

---

## Arrancar la Web en desarrollo

```bash
npm install
npm run dev          # http://localhost:3000
```

Tests del servidor de emparejamiento, y banco de pruebas de velocidad (los dos necesitan el
servidor arrancado en otra terminal):

```bash
npm test
npm run bench                 # transferencia real entre dos pestañas de Chrome
SIZE_MB=256 npm run bench     # payload mayor
npm run bench:fanout          # varios receptores a la vez, con la cadena
PEERS=5 npm run bench:fanout  # cadena más larga
```

Y para medir la conexión con otra persona sin tocar la terminal, la app trae una página:
**`/speed`**. Uno abre el canal, pasa el enlace, y los dos ven latencia, velocidad en cada
dirección, y si la conexión va directa o rebotando por el TURN.

`bench` conduce dos pestañas contra la app real y mide MB/s de punta a punta. Las dos viven en
la misma máquina, así que el número es el techo de la app —troceado, cifrado, SCTP, control de
flujo—, no el ancho de banda entre dos casas.

`bench:fanout` es el de varios receptores: comprueba el SHA-256 de lo que guarda cada uno y
cuenta **cuántas copias del payload salen por el uplink del emisor**. Con tres receptores son
1,05 copias con la cadena y 3,14 sin ella (`STAGGER_MS=2500`, que separa los *accept* para que no
se agrupen). El tiempo de esa prueba no dice nada: todas las pestañas comparten la misma CPU.

## Cómo funciona

| Pieza | Qué hace |
|---|---|
| `server/index.js` | WebSocket de señalización. Genera tokens de sala, los guarda en memoria y reenvía SDP/ICE a ciegas. Nunca ve un archivo. |
| `public/app.js` | Toda la lógica de cliente: WebRTC, troceado, control de flujo y escritura a disco. |
| `public/index.html` / `style.css` | Interfaz de dos pantallas: enviar (la de inicio) y recibir (solo se llega abriendo un enlace). |

Sobre el `RTCDataChannel` viaja un protocolo mínimo:

- **texto** → control en JSON: `manifest`, `accept`, `start`, `end`, `done`, `ack`, `complete`
- **binario** → trozos de 64 KiB del archivo en curso, en orden

Detalles que importan:

- **Control de flujo.** El emisor pausa cuando `bufferedAmount` pasa de 8 MB y reanuda al bajar
  de 1 MB. Sin esto, un archivo de 4 GB se leería entero en RAM antes de salir.
- **Progreso real.** La barra se mueve con los `ack` del receptor, no con lo que el emisor ha
  entregado a la red: `bufferedAmount` mentiría al final de cada archivo.
- **Por dónde va.** Cada fila dice el camino real y la latencia —`direct 20ms`, `turn 84ms`,
  `via peer · direct 12ms`—, sacados de los candidatos ICE. Si una transferencia va lenta, lo
  primero que quieres saber es si está rebotando por el TURN, y ahora se ve sin abrir nada.
- **Escritura a disco.** Con varios archivos o más de 128 MB se pide una carpeta
  (File System Access API, Chrome/Edge) y se escribe en streaming. Para un archivo suelto se usa
  la descarga normal del navegador, que también funciona en Firefox y Safari.
- **Varios receptores, en cadena.** La sala aguanta abierta y cada amigo que entra tiene su
  propia barra. Pero mandarle a cada uno una copia entera parte el uplink del emisor entre
  todos, así que si varios aceptan a la vez se encadenan —`emisor → A → B → C`— y cada uno va
  reenviando los trozos según le llegan. El emisor sube **una sola copia** y el límite pasa a
  ser el peor uplink de la cadena en vez de el suyo dividido entre N. Nadie guarda nada para
  reenviarlo, así que solo se puede encadenar a quien empieza a la vez: el que llega tarde se
  sirve directo, como siempre. Si un eslabón cierra la pestaña, los de abajo piden al emisor
  seguir desde el byte exacto que tenían y la cadena se deshace en conexiones directas.
- **Cifrado y enlaces.** DTLS es obligatorio en WebRTC, así que el tráfico va cifrado de extremo
  a extremo por defecto. El token de la sala son 96 bits aleatorios (`crypto.randomBytes`): como
  nadie lo teclea, no hace falta que sea corto, y así no se puede adivinar a fuerza bruta. Viaja
  en el **fragmento** de la URL (`#...`), que el navegador nunca envía al servidor: no aparece en
  sus logs ni en la cabecera `Referer`. En los logs de la app solo se registra un prefijo.
  Aun así el enlace *es* la llave: quien lo tenga entra mientras la sala siga abierta.

## Logs

El servidor escribe una línea por evento de sala, con hora ISO:

```
2026-08-25T15:45:34.020Z sala abierta Uj6y... | salas activas: 1
2026-08-25T15:45:34.023Z receptor 1 entra en Uj6y... | receptores en la sala: 1
2026-08-25T15:45:34.036Z sala cerrada Uj6y... | vivio 0s con 2 receptores | salas activas: 0
```

Del token solo se registra el prefijo: es la llave de la sala, no debe acabar escrita en disco.
Y ahí no verás nada del progreso de una transferencia, porque el servidor no la ve: los errores
de WebRTC salen en la **consola del navegador** de cada uno de los dos lados.
`GET /healthz` devuelve el número de salas abiertas en ese momento.

## Desplegar

Requisitos del sitio donde lo pongas, en orden de importancia:

1. **WebSockets** (la señalización va por ahí).
2. **HTTPS**. Sin contexto seguro no hay portapapeles ni escritura directa a disco, y los
   navegadores restringen WebRTC.
3. **Una sola instancia.** Las salas viven en la memoria del proceso: con dos réplicas, el emisor
   puede caer en una y el receptor en la otra, y el enlace daría "caducado". Para escalar de
   verdad haría falta mover las salas a Redis y relevar los mensajes por pub/sub.

### Fly.io (la vía más corta desde aquí)

Ya tienes `Dockerfile` y `fly.toml` listos. No necesitas Docker en local: Fly construye la imagen
en su propio builder.

```powershell
# 1. instalar flyctl (una vez)
iwr https://fly.io/install.ps1 -useb | iex

# 2. cuenta (te abre el navegador)
fly auth signup      # o: fly auth login

# 3. edita fly.toml y pon un nombre libre en `app`, luego:
fly launch --no-deploy --copy-config    # crea la app respetando este fly.toml
fly deploy --ha=false                   # --ha=false = una sola maquina, ver punto 3 de arriba
```

Queda en `https://<tu-app>.fly.dev`. Para ver los logs en vivo: `fly logs`.

### Render (si prefieres desplegar desde GitHub)

Necesita el proyecto en un repositorio. `git init`, súbelo, y en Render: *New → Web Service*,
`Build Command: npm ci`, `Start Command: npm start`. Deja **una sola instancia**. Aviso: el plan
gratuito duerme el servicio tras 15 minutos de inactividad y tarda ~50 s en despertar, así que el
primer enlace del día puede hacerse esperar.

### Tu propio VPS (la opción completa, y gratis si es un Always Free de Oracle)

La mejor de todas si ya tienes máquina: siempre encendida, una sola instancia por definición
—así que las salas en memoria funcionan como fueron diseñadas— y puedes alojar tu propio TURN
al lado, que es la parte que de verdad cuesta dinero en cualquier otro sitio.

```bash
cp .env.example .env    # dominio, IPs y contraseña del TURN
docker compose up -d --build
```

Levanta la app, un Caddy que saca el certificado HTTPS solo y un coturn como servidor TURN.
Los pasos completos, incluida la trampa de los puertos de Oracle (hay que abrirlos en dos
sitios) están en **[DEPLOY-VPS.md](DEPLOY-VPS.md)**.

### TURN (recomendado en cuanto salga de tu red)

Entre un 10 % y un 15 % de las conexiones no logran hablar directamente (NAT simétrica, redes
corporativas, algunos móviles). Un servidor TURN reenvía esos casos. El cliente lee la
configuración de `/config`, así que basta con definir las variables de entorno:

```bash
fly secrets set TURN_URL=turn:... TURN_USER=... TURN_PASS=...   # en Fly
cp .env.example .env                                            # en local
```

Opciones: coturn en un VPS, o un TURN gestionado (Twilio, Metered, Cloudflare Calls).

## Límites conocidos

- Si el emisor cierra la pestaña, la transferencia se corta: no hay reanudación ni troceado
  persistente (es lo que un torrent sí hace).
- El receptor sin File System Access API acumula cada archivo en memoria antes de descargarlo;
  para archivos enormes conviene Chrome o Edge.
- No hay carpetas (solo archivos sueltos) ni cola de reintentos.

## Ideas para después

- Reanudar transferencias interrumpidas guardando el offset por archivo.
- Soporte de carpetas con `webkitdirectory` + rutas relativas en el manifiesto.
- Código QR junto al enlace, para enviar del portátil al móvil.
- PIN opcional además del enlace, para lo que se comparte en grupos grandes.
- Caducidad de sala por tiempo, además de por cierre de pestaña.
