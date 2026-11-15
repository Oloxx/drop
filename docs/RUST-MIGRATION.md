# Migración del CLI a Rust: comparativa y evaluación

Evaluación técnica y empírica del refactor del CLI de **Drop** desde **Node.js + SEA** (*Single Executable Application*, anterior directorio `cli/`) a **Rust nativo** ([`cli-rs/`](../cli-rs/), publicado en la versión `0.13.0`), manteniendo congelado el **Protocolo 5 (`1.x`)** e interoperabilidad total con la aplicación web ([`public/`](../public/)) y el servidor de señalización/relay ([`server/index.js`](../server/index.js)).

---

## Resumen ejecutivo

La migración sustituye el runtime completo de Node.js/V8 embebido en cada ejecutable por un binario nativo compilado con `cargo`:

- **Peso del binario (Windows x64):** baja de **`84,456,080 bytes` (`80.54 MiB`)** (binario base `node.exe` de SEA) a **`5,637,632 bytes` (`5.38 MiB`)** (~**15× más pequeño**, **−93.3 %**).
- **Arranque en frío (`--version`, 10 ejecuciones):** mejora de **`108.79 ms`** en Node a **`15.01 ms`** en Rust (**~7.2× más rápido**).
- **Memoria activa (`speed` en loopback):** baja de **`55.6–62.3 MB`** actuales (`82.9–105.5 MB` pico) en Node a **`9.9–10.0 MB`** actuales (`41.2–41.7 MB` pico) en Rust (**~5.5×–6.3× menos RAM activa**).
- **Throughput cifrado TCP en memoria:** pasa de **`661.7 / 650.3 MB/s`** en Node a **`2697.3 / 2728.4 MB/s`** en Rust (**>4× más rápido**), con RTT loopback de **`0.1 ms`** frente a **`0.4 ms`**.
- **Relay WebSocket CLI ↔ CLI:** sube de **`88.4 / 67.2 MB/s`** en Node a **`297.4 / 336.7 MB/s`** en Rust (**3.4×–5.0× más rápido**) usando exactamente el mismo servidor relay en Node.js.
- **Compromiso principal:** el código fuente del CLI crece de `6,237` a `12,241` líneas al duplicar tipado estricto y módulos compartidos antes heredados directamente desde [`public/shared/`](../public/shared/), además de requerir compilación nativa por plataforma en CI.

---

## Entorno de medición

Todas las mediciones comparativas de arranque, memoria y rendimiento se ejecutaron en el mismo equipo en local sobre loopback (`127.0.0.1` / `::1`):

- **CPU:** AMD Ryzen 7 5700X 8-Core Processor (8 núcleos / 16 hilos)
- **RAM:** 15.9 GiB
- **Sistema operativo:** Microsoft Windows 11 Pro 64 bits
- **Toolchains:** `rustc 1.100.0 (0ef1bc386 2026-11-09)` / `cargo 1.100.0 (3acc79c0c 2026-11-05)` y `Node.js v22.15.0`

> Las pruebas comparativas JS vs Rust se midieron contra el binario release de Rust (`5,639,168 bytes` en el momento del benchmark) y la implementación `v0.12.0` previa en `cli/src/` antes de retirar los ficheros Node del repositorio. Tras los últimos ajustes de documentación y comentarios, el binario recompilado en release pesa `5,637,632 bytes` (`5.38 MiB`).

---

## 1. Peso del binario, dependencias y código fuente

| Métrica | CLI anterior (Node.js SEA) | CLI nuevo (Rust) | Diferencia |
| :--- | :--- | :--- | :--- |
| **Binario ejecutable (`Windows x64`)** | `84,456,080 bytes` (`80.54 MiB`, base `node.exe` SEA) | `5,637,632 bytes` (`5.38 MiB`, `drop.exe` release) | **−93.3 % (~15× menor)** |
| **Dependencias en runtime (usuario)** | Runtime Node/V8/OpenSSL embebido por binario | `0` dependencias externas (binario nativo estático) | Sin runtime JS embebido |
| **Paquetes de compilación CLI** | `node` + `esbuild` + `postject` + descarga de binarios `nodejs.org` | `244` crates en `cli-rs/Cargo.lock` | Sin inyección binaria post-build |
| **Dependencias runtime servidor (`package.json`)** | `2` (`express`, `ws`) | `2` (`express`, `ws`) | Sin cambios |
| **Código fuente del CLI** | `16` ficheros · `281,267 bytes` · `6,237` líneas (`cli/src/`) | `32` ficheros · `405,449 bytes` · `12,241` líneas (`cli-rs/src/`) | **+96 % líneas en el CLI** |
| **Código compartido web/CLI (`public/shared/`)** | `9` ficheros · `92,770 bytes` · `1,858` líneas (importado directo) | Reimplementado en [`cli-rs/src/shared/`](../cli-rs/src/shared/) para el CLI | Se mantiene sincronizado por vectores |
| **Tests de integración propios del CLI** | Cubiertos solo en `test/*.test.mjs` | `5` suites `.rs` (`2,001` líneas en [`cli-rs/tests/`](../cli-rs/tests/)) + suites `test/*.test.mjs` | Cobertura nativa + E2E |

### Lectura técnica del peso

1. **Distribución real:** en el esquema SEA anterior, incluso un comando mínimo obligaba a distribuir el runtime completo de Node.js (~80 MiB en Windows sin comprimir) más la inyección del blob mediante `postject`. El binario Rust reduce el artefacto a **`5.38 MiB`**, lo que agiliza descargas iniciales, actualizaciones automáticas (`drop update`) y distribución en gestores de paquetes.
2. **Más código en Rust, menos código de pegamento de empaquetado:** Rust exige mayor verbosidad en gestión explícita de tipos, buffers, canales asíncronos y serialización, y ya no puede importar directamente [`public/shared/`](../public/shared/). A cambio, desaparece la infraestructura artesanal de descarga/verificación de runtimes Node (`scripts/build-cross.mjs`, `scripts/shasums.mjs`, `sea-config.json`).

---

## 2. Arranque en frío y consumo de memoria

Mediciones tomadas en Windows usando `WorkingSet64` y `PeakWorkingSet64` para memoria, y 10 ejecuciones consecutivas para arranque en frío:

| Escenario | Node.js (`v22.15.0`) | Rust (`drop.exe` release) | Mejora |
| :--- | :--- | :--- | :--- |
| **Arranque en frío (`--version`, 10 corridas)** | `108.79 ms` media (`min 103.60 ms`, `max 118.42 ms`) | `15.01 ms` media (`min 12.50 ms`, `max 27.72 ms`) | **7.2× más rápido** |
| **RAM en espera (`send --no-qr`)** | `51.4 MiB` actual · `83.1 MiB` pico | `10.4 MiB` actual · `42.0 MiB` pico | **~4.9× menos RAM actual** |
| **RAM bajo carga (`speed` loopback) — Host** | `55.6 MB` actual · `82.9 MB` pico | `10.0 MB` actual · `41.7 MB` pico | **~5.6× menos RAM actual** |
| **RAM bajo carga (`speed` loopback) — Guest** | `62.3 MB` actual · `105.5 MB` pico | `9.9 MB` actual · `41.2 MB` pico | **~6.3× menos RAM actual** |

En invocaciones breves (`--help`, `completion`, `verify-web`, comandos erróneos), Node pagaba siempre más de `100 ms` solo por inicializar V8 y cargar módulos ES. Rust responde en **`~15 ms`** de media, resultando inmediato en terminal y reduciendo la huella de memoria de larga duración durante transferencias grandes o sesiones en espera.

---

## 3. Benchmarks de velocidad y latencia

### 3.1 Transferencia E2E de archivo (`test/cli.bench.mjs`, 128 MB por TCP loopback)

Incluye el ciclo completo de usuario: arranque de los dos procesos, señalización, derivación de clave con `scrypt`, lectura/escritura en disco, cifrado/descifrado AES-256-GCM y verificación SHA-256.

| Implementación | Tiempo total | Caudal efectivo |
| :--- | :--- | :--- |
| **Node.js CLI** | `1.86 s` | `68.7 MB/s` (`550 Mbit/s`) |
| **Rust CLI** | `1.55 s` | `82.4 MB/s` (`660 Mbit/s`) |

**Análisis:** sobre disco local con un fichero de 128 MB, la diferencia es de **+20 %** (`0.31 s` menos) porque el I/O de disco y el coste fijo de `scrypt` dominan buena parte del tiempo total. La ventaja de CPU de Rust se nota mucho más en transferencias sostenidas en red rápida o en memoria.

---

### 3.2 Benchmark puro TCP directo (`test/speed.bench.mjs`, 2.00 s por sentido, cifrado AES-256-GCM en memoria)

| Implementación | Subida (Host) | Bajada (Host) | Latencia RTT |
| :--- | :--- | :--- | :--- |
| **Node.js CLI** | `661.7 MB/s` (`5294 Mbit/s`, `1.3 GB/2.0s`) | `650.3 MB/s` (`5203 Mbit/s`, `1.3 GB/2.0s`) | `0.4 ms` |
| **Rust CLI** | `2697.3 MB/s` (`21579 Mbit/s`, `5.3 GB/2.00s`) | `2728.4 MB/s` (`21827 Mbit/s`, `5.3 GB/2.00s`) | `0.1 ms` (Guest `0.0 ms`) |

**Análisis:** sin freno de disco ni límite de red física, Rust supera los **`2.7 GB/s` (~`21.8 Gbit/s`) cifrando AES-256-GCM en tiempo real**, multiplicando por **>4×** el techo de Node.js (`~650–662 MB/s`) al eliminar copias de `Buffer` entre JS y C++, asignaciones repetidas por chunk y pausas de GC.

---

### 3.3 Benchmark por WebSocket Relay (`test/speed.bench.mjs --relay` sobre servidor Node.js `ws`)

Ambos CLI pasan exactamente por el mismo servidor relay Node.js en loopback:

| Implementación | Subida (Host) | Bajada (Host) | Latencia RTT |
| :--- | :--- | :--- | :--- |
| **Node.js CLI** | `88.4 MB/s` (`707 Mbit/s`, `179 MB/2.0s`) | `67.2 MB/s` (`537 Mbit/s`, `136 MB/2.0s`) | `0.7 ms` |
| **Rust CLI** | `297.4 MB/s` (`2379 Mbit/s`, `622 MB/2.09s`) | `336.7 MB/s` (`2693 Mbit/s`, `809 MB/2.40s`) | `0.4 ms` |

**Análisis:** este resultado es especialmente revelador: el techo previo de **`67–88 MB/s`** en `--relay` **no estaba en el servidor WebSocket de Node**, sino en el propio cliente CLI de Node gestionando frames binarios + AES-GCM + backpressure. Al pasar el cliente a Rust, el mismo servidor relay en Node entrega **3.4×–5.0× más rendimiento** (`297–337 MB/s`).

---

### 3.4 Interoperabilidad CLI ↔ Chrome (`test/webrelay.bench.mjs`, 12 MB por Relay WS, SHA-256 verificado)

| Dirección | Node.js CLI | Rust CLI | Observación |
| :--- | :--- | :--- | :--- |
| **CLI `send` → Chrome** | Handshake `0.71 s` · Transfer `0.50 s` (`23.9 MB/s`) | Handshake `0.72 s` · Transfer `0.59 s` (`20.2 MB/s`) | Empate técnico; domina el hilo WebCrypto/WS de Chrome |
| **Chrome → CLI `recv`** | Handshake `0.54 s` · Transfer `0.25 s` (`48.2 MB/s`) | Handshake `0.36 s` · Transfer `0.26 s` (`46.9 MB/s`) | Misma velocidad de transferencia; Rust recorta `0.18 s` el handshake |

**Análisis:** cuando uno de los extremos es el navegador, el cuello de botella reside en la ejecución de WebCrypto en Chrome, el paso de mensajes entre navegador y WebSocket y la ventana de confirmación (`cli-ack` de 8 MiB) del protocolo relay. Aquí la reescritura en Rust no acelera la velocidad sostenida (incluso muestra una ligera variación de `0.09 s` en la corrida de 12 MB enviada hacia Chrome), porque el límite ya no está en el binario de consola.

---

## 4. Paridad de protocolo e interoperabilidad cruzada

Para asegurar que la migración no introduce regresiones con el cliente web ni con versiones JS previas de Protocolo 5:

1. **Interoperabilidad binaria JS `v0.12.0` ↔ Rust `v0.12.0`:** probada con un fichero de **`9,437,261 bytes`** y verificación SHA-256 en las 4 combinaciones:
   - `Node send → Rust recv` (TCP directo): **PASS**
   - `Node send → Rust recv` (Relay WebSocket): **PASS**
   - `Rust send → Node recv` (TCP directo): **PASS**
   - `Rust send → Node recv` (Relay WebSocket): **PASS**
2. **Vectores compartidos entre lenguajes ([`cli-rs/tests/shared_vectors_test.rs`](../cli-rs/tests/shared_vectors_test.rs)):** **8 tests** validan paridad bit a bit contra las constantes y funciones criptográficas de [`public/shared/`](../public/shared/) (palabras, códigos, derivación, AES-256-GCM, SAS, QR, selección `--only`, completado de shell y Minisign).
3. **Batería propia de Rust (`cargo test`):** **33 tests** en 5 suites (`network_test`: 11, `shared_vectors_test`: 8, `speed_test`: 2, `system_test`: 5, `transfer_test`: 7), compilando sin advertencias bajo `cargo clippy --all-targets -- -D warnings`.

---

## 5. Evaluación de ingeniería: pros, contras y conclusión

### Lo que mejora claramente

- **Experiencia de usuario e instalación:** binario de `5.38 MiB` frente a `80.54 MiB` base, arranque casi instantáneo (`~15 ms`) y ~5× menos consumo de memoria.
- **Pipeline de release más limpio:** desaparecen `sea-config.json`, la descarga manual de tarballs de `nodejs.org`, la verificación ad-hoc `SHASUMS256.txt` y los hacks de `postject` (incluida la re-inyección/re-firmado de segmentos Mach-O en macOS). La verificación de releases mantiene el formato Minisign con la misma clave pública en [`cli-rs/src/cli.rs`](../cli-rs/src/cli.rs).
- **Techo de red desbloqueado:** con **`>21 Gbit/s`** cifrados en memoria TCP y **`>2.3 Gbit/s`** sobre relay WS en loopback, el CLI deja de limitar enlaces Ethernet de 2.5/10 Gbit/s.
- **Separación sana de arquitectura:** el servidor sigue siendo Node.js minimalista (2 dependencias: `express`, `ws`), mientras el binario distribuido al usuario final vive aislado en `cli-rs/`.

### Costes y compromisos reales

- **Doble implementación de módulos `shared`:** lo que antes era código único en [`public/shared/`](../public/shared/) ahora requiere mantener sincronizados los archivos homólogos en [`cli-rs/src/shared/`](../cli-rs/src/shared/). Cualquier cambio futuro debe respetar las reglas de [compatibilidad](COMPATIBILITY.md) y actualizar ambos lados.
- **Compilación en frío vs iteración instantánea:** una compilación `release` completa en local tarda **`34.01 s`** en este equipo (frente a ejecución directa sin compilación con `node`), aunque las compilaciones incrementales en desarrollo son rápidas (`cargo clippy` y `dev` en pocos segundos) y CI cachea crates.
- **Matriz multiplataforma en CI:** generar binarios nativos estáticos (`windows-x64`, `linux-x64` musl, `linux-arm64` musl, `macos-arm64`, `macos-x64`) en [`.github/workflows/release.yml`](../.github/workflows/release.yml) depende de toolchains nativos/musl por arquitectura en lugar de inyectar bytecode sobre runtimes precompilados de Node.

### Veredicto

La migración a Rust **merece la pena**: para un CLI P2P que el usuario descarga como ejecutable independiente, reducir el peso de ~80 MiB a `5.38 MiB`, bajar la memoria activa a `~10 MB` y multiplicar por más de `4×` el throughput cifrado elimina las principales limitaciones prácticas del enfoque SEA de Node.js, pagando un coste asumible en duplicación de constantes de protocolo (cubierta por tests cruzados) y tiempos de compilación.
