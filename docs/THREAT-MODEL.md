# Modelo de amenazas de drop

Este documento detalla qué garantiza **drop** en cada ruta de transferencia y distribución, qué ve cada intermediario y qué queda explícitamente fuera del modelo. El resumen corto está en [`SECURITY.md`](../SECURITY.md).

---

## 1. Actores y qué ve cada uno

| Actor | Qué ve | Qué NO ve |
|---|---|---|
| **Servidor de señalización** (`server/index.js`) | Identificador público de sala (`4271`, 4 dígitos), direcciones IP de emisor y receptores, SDP/ICE en WebRTC, `cli-offer`/`cli-proof` y tráfico cifrado (`cli-sealed` + trozos AES-GCM) cuando se usa relay | Las cuatro palabras del código, la clave derivada, los nombres/tamaños de archivos del CLI ni ningún byte de archivo en claro |
| **Servidor TURN** (`coturn`) | IPs de los pares y paquetes DTLS ya cifrados extremo a extremo entre navegadores | Contenido del DataChannel ni contraseñas permanentes (usa credenciales HMAC temporales de duración `TURN_TTL_SECONDS`) |
| **Vecino de LAN** (UDP `42424`) | `roomHash = sha256(roomId).slice(0, 16)` y puerto TCP local del emisor | Las cuatro palabras del código, el manifiesto o los archivos: sin clave scrypt, AES-GCM rechaza el primer paquete TCP |
| **Observador pasivo en red / ISP** | IPs, horarios, volumen de tráfico y SNI/DNS; el contenido va dentro de DTLS (WebRTC) o AES-256-GCM (TCP y relay) | Nombres de archivo ni contenido en claro |
| **Otro extremo con el código** | Todo lo incluido en la oferta (y lo elegido con `--only` / casillas) una vez aceptado por el emisor | Otros archivos del equipo fuera del envío |

---

## 2. El código de cuatro palabras y la derivación de clave

El código `4271-lemon-radar-tiger-orbit` separa dos mitades ([`public/shared/codes.js`](../public/shared/codes.js)):

- **Identificador público (`4271`, 4 dígitos, 10.000 salas):** solo sirve para enrutar la señalización y calcular `roomHash` en LAN. **No aporta secreto.**
- **Secreto compartido (`lemon-radar-tiger-orbit`, 4 palabras BIP-39 de 2048):** $4 \times 11 = 44\text{ bits}$ de entropía exacta, sorteados en el cliente (`crypto.randomBytes` en Node / `crypto.getRandomValues` en navegador). Nunca se envía al servidor.

### Derivación (`scrypt`)

Tanto el CLI ([`cli/src/crypto.js`](../cli/src/crypto.js)) como el navegador ([`public/shared/e2ee.js`](../public/shared/e2ee.js), [`public/shared/scrypt.js`](../public/shared/scrypt.js)) derivan la clave AES-256 usando:

```text
salt = SHA-256("drop-code-v2|" + roomId)
key  = scrypt(secret, salt, N=32768, r=8, p=1, dkLen=32)
```

- **Coste por intento:** 32 MiB de RAM y ~62 ms en equipo moderno (~0,3 s en JS en navegador).
- **Resistencia a fuerza bruta offline:** si un atacante graba tráfico TCP o relay cifrado (o un `cli-proof`), probar el espacio de $2^{44}$ códigos contra `scrypt` supone $\sim 2^{44} \times 0{,}062\text{ s} \approx 3{,}5 \times 10^{10}$ años-CPU, con cuello de botella en ancho de banda de memoria.
- **Separación de dominios:** el `roomId` entra en la sal (`drop-code-v2|<roomId>`), así que las mismas cuatro palabras en dos salas distintas producen claves diferentes.

### Fuerza bruta online

Quien intente enumerar salas o adivinar palabras contra un emisor vivo se encuentra con límites en [`server/index.js`](../server/index.js):

1. **`JOIN_FAIL_MAX = 20` por IP cada 60 s (`RATE_LIMITED`):** barrer las 10.000 salas posibles desde una IP tarda del orden de ~8 horas, mientras las salas viven minutos (`DROP_ROOM_TTL_MS`, 30 min por defecto).
2. **`BAD_GUEST_MAX = 5` (`BURNED`):** si un emisor denuncia 5 pruebas de conocimiento fallidas (`bad-guest`), el servidor quema y cierra la sala entera.
3. **Verificación en tiempo constante:** el CLI valida `cli-proof` (`HMAC-SHA256(key, "drop-proof-v3|" + nonce)`) mediante `crypto.timingSafeEqual` (`verifyProof` en [`cli/src/crypto.js`](../cli/src/crypto.js)).
4. **Confirmación explícita del emisor:** incluso con las cuatro palabras, un receptor no recibe el manifiesto ni datos hasta superar la prueba de conocimiento y (salvo `--yes`) ser aceptado por el emisor.

---

## 3. Cifrado en tránsito, integridad y escritura en disco

- **TCP directo y Relay (CLI ↔ CLI y CLI ↔ Web):** cada marco de control y cada trozo binario va cifrado con **AES-256-GCM** usando un IV aleatorio de 96 bits (`12 bytes IV | 16 bytes tag | ciphertext`). Con IVs aleatorios de 96 bits, el límite seguro de NIST SP 800-38D es $2^{32}$ paquetes por clave (~256 TiB en trozos de 64 KiB), muy por encima de una transferencia efímera.
- **Web ↔ Web (WebRTC):** cifrado por **DTLS** del estándar WebRTC sobre SCTP.
- **Integridad de extremo a extremo:** además de la autenticación AEAD por paquete/trama, cada archivo lleva su **SHA-256** verificado al completarse dentro del canal autenticado (`end` / `cli-end`), de modo que cualquier pérdida, duplicación o reordenación de trozos por parte de un relay hostil hace fallar la verificación antes de confirmar la entrega.
- **Escritura segura en destino:** los receptores validan las rutas del manifiesto para evitar *path traversal* (escapar fuera del directorio de destino) y rechazan reanudar archivos `.part` cuyo hash de prefijo no coincida con el del emisor.

---

## 4. Huella de sesión (SAS)

El SAS son **3 palabras BIP-39** (33 bits) calculadas localmente en ambos extremos ([`public/shared/sas.js`](../public/shared/sas.js)):

- **WebRTC (`webrtc`):** `SHA-256("drop-sas-v1|webrtc|" + sorted(dtlsFingerprints))`. Detecta un ataque **MITM en el servidor de señalización** que sustituya los *fingerprints* DTLS en el SDP para interceptar el canal WebRTC: cada extremo negocia DTLS con el atacante y las huellas dejan de coincidir.
- **CLI (`tcp`):** `HMAC-SHA256(key, "drop-sas-v1|tcp|" + roomId)`. Confirma que ambos extremos comparten la misma clave scrypt en la misma sala sin exponer un verificador barato del secreto (las palabras en claro nunca entran en el SAS).

Los humanos deben comparar la huella por un canal independiente (voz, chat, presencial); el software la muestra pero no puede verificarla por ellos.

---

## 5. Integridad de distribución y cliente web

- **Binarios del CLI (`drop update`):** cada release publica `SHA256SUMS` y su firma Ed25519 `SHA256SUMS.minisig` ([`cli/src/minisign.js`](../cli/src/minisign.js)), verificadas contra la clave pública embebida en el binario. Un atacante que comprometa el DNS o sirva un espejo falso de GitHub Releases no puede falsificar la firma sin la clave privada (`DROP_SIGNING_KEY`).
- **Cliente web (`drop verify-web`):** [`cli/src/verifyweb.js`](../cli/src/verifyweb.js) consulta `/version` para obtener el commit declarado (`DROP_COMMIT`) y compara byte a byte los archivos servidos en `public/` contra el árbol de ese commit en GitHub.

---

## 6. Qué NO está cubierto (límites explícitos)

1. **Servidor web malicioso dirigido:** si un atacante controla el servidor que entrega el HTML y `public/app.js`, puede servir código alterado solo a la víctima mientras entrega el código legítimo a quien ejecute `drop verify-web`. (SRI tampoco resuelve esto si el propio HTML con los atributos `integrity` lo sirve el mismo servidor).
2. **Ausencia de PAKE (SPAKE2/CPace):** el código tiene 44 bits y no usa intercambio autenticado basado en contraseña en curva elíptica (decisión consciente para no escribir primitivas de curva sin auditar y mantener cero dependencias). Un atacante con **control activo de la señalización y capacidad de interceptar en tiempo real** podría intentar un ataque en vivo si el usuario no comprueba el SAS o acepta un par inesperado.
3. **Botnets distribuidas:** los límites por IP (`JOIN_FAIL_MAX`, `ROOM_RATE_MAX`) frenan escaneos desde una única IP, no desde miles de IPs coordinadas (aunque `BAD_GUEST_MAX = 5` sigue cerrando cualquier sala concreta bajo ataque).
4. **Metadatos de tráfico:** el servidor, TURN y observadores de red ven qué IPs se comunican, cuándo y cuántos bytes transfieren.
5. **Compromiso del código o del dispositivo:** quien escuche o reciba las cuatro palabras tiene acceso a la transferencia; un sistema operativo o navegador comprometido puede leer los archivos antes de cifrarlos o después de descifrarlos.
6. **Auditoría externa independiente:** la criptografía usa primitivas estándar de Node.js y WebCrypto combinadas con implementaciones propias verificadas contra vectores oficiales (FIPS 180-4, RFC 4231, RFC 6070, RFC 7914) en [`test/e2ee.test.mjs`](../test/e2ee.test.mjs) y [`test/minisign.test.mjs`](../test/minisign.test.mjs), pero **no cuenta con una auditoría externa pagada**.
