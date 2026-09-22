# Seguridad

## Reportar un fallo

Si encuentras un fallo con impacto en seguridad, **no abras una issue pública**: escribe por
[advisory privado de GitHub](https://github.com/Oloxx/drop/security/advisories/new). Se
responde en pocos días, y el arreglo sale en una release antes de que el aviso se haga público.

Cuenta como fallo de seguridad todo lo que contradiga el modelo de amenazas de abajo: que el
servidor pueda leer un byte de un archivo, que alguien sin las cuatro palabras pueda descargar,
que un `path` del manifiesto escape del directorio de destino, que `drop update` acepte un
binario sin firma válida.

## Versiones con soporte

Solo la **última release** recibe arreglos. Los binarios instalados se actualizan con
`drop update`, que comprueba la firma de la release antes de sustituirse a sí mismo. La web se
despliega desde `main` y siempre está en la última versión. Dentro de la 1.x actualizar no rompe
nada con quien siga en una anterior: el protocolo no cambia ([COMPATIBILITY.md](docs/COMPATIBILITY.md)).

## Modelo de amenazas, en corto

Lo que protege drop y lo que no. La versión larga, con el razonamiento, está en el
[README](README.md#-modelo-de-seguridad-del-código) y en las cabeceras de
[`public/shared/codes.js`](public/shared/codes.js) y [`public/shared/sas.js`](public/shared/sas.js).

**Lo que ve el servidor de señalización:** el identificador público de sala (`4271`), las IPs
de los dos extremos, el SDP/ICE del WebRTC y, por el relay, ruido cifrado. **Nunca** las cuatro
palabras, ni un hash de ellas, ni un byte de archivo en claro. Por WebRTC los archivos no pasan
por él; por relay pasan cifrados con AES-256-GCM con una clave que no puede derivar.

**Lo que ve el TURN:** paquetes DTLS ya cifrados entre dos navegadores. Sus credenciales
caducan (`TURN_TTL_SECONDS`) y se firman por petición, así que no es un relay abierto.

**Lo que protege el código de cuatro palabras:** 44 bits de secreto, derivados a clave con
scrypt (N=2¹⁵, r=8, p=1: ~62 ms y 32 MB por intento). Contra un servidor o un vecino de red que
intente adivinar offline eso son ~3,5 × 10¹⁰ años-CPU. Contra intentos *online* los frena el
propio servidor: límite de fallos por IP, y la sala se cierra cuando el emisor denuncia varios
receptores que no saben el secreto. Quien acierta el identificador de sala pero no las palabras
no obtiene ni los nombres de los archivos.

**Lo que protege la huella de sesión (SAS):** las tres palabras que muestran los dos extremos
salen de lo negociado de verdad (fingerprints DTLS por WebRTC, la clave scrypt por TCP y relay).
Si un servidor sustituye el SDP para ponerse en medio, las huellas dejan de coincidir. Hay que
compararlas por otro canal; el software no puede hacerlo por ti.

**Lo que protegen las firmas de release:** `SHA256SUMS.minisig` (Ed25519, formato minisign)
dice quién publicó el binario, no solo que llegó entero. `drop update` rechaza una release sin
firma o con firma que no cuadra con la clave pública embebida en el binario.

**Lo que NO está cubierto:**

- Un servidor malicioso que sirva **otro `app.js`**. La web confía en el código que descarga,
  como toda web. `drop verify-web` compara lo que sirve un servidor con el commit del repositorio
  público que dice servir, archivo a archivo, pero solo prueba lo que te ha servido a ti: un
  servidor malicioso puede dar el código bueno a quien pregunta y el malo a un navegador concreto.
- **PAKE.** No hay SPAKE2/CPace: el código de cuatro palabras protege por entropía y coste de
  derivación, no por un intercambio autenticado. Implementarlo a mano sin auditar sería peor.
- **Auditoría externa.** `crypto.js`, `e2ee.js`, `scrypt.js`, `sas.js` y la derivación de
  claves son implementaciones propias sobre primitivas de Node y WebCrypto, sin revisión
  independiente todavía.
- **Metadatos.** El servidor y quien mire la red ven cuándo, entre qué IPs y cuántos bytes.
- **El otro extremo.** Quien tiene las cuatro palabras tiene los archivos; drop no puede
  proteger un código que se ha dictado a la persona equivocada.
