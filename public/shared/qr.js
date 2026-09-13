// Codificador de codigos QR (ISO/IEC 18004) sin dependencias, compartido por la
// web (SVG) y el CLI (caracteres de bloque en la terminal).
//
// Existe para no teclear un enlace en el movil: el emisor ensena el QR y la
// camara abre la URL con el codigo entero en el fragmento. Y esta escrito aqui
// porque el proyecto no admite dependencias -- se compila a binario unico y la
// web no hace ni una peticion a terceros -- igual que el SHA-256, scrypt o UPnP.
//
// Alcance: modo bytes (cualquier texto, en UTF-8), versiones 1 a 40, los cuatro
// niveles de correccion, eleccion automatica de version (la mas pequena que cabe)
// y de mascara (la de menor penalizacion). No hay modo numerico ni alfanumerico:
// una URL con minusculas no cabe en ellos, y para lo que se codifica aqui el
// ahorro seria de una version como mucho.
//
// La estructura sigue la del codificador de referencia de Nayuki, que es la
// forma mas clara de escribir esto: tablas de codewords de correccion y bloques
// por version, capacidad calculada por formula, Reed-Solomon sobre GF(256) con
// el polinomio 0x11D, y las cuatro reglas de penalizacion para elegir mascara.

// Nivel de correccion: `bits` es lo que va en la informacion de formato.
export const ECL = {
  L: { ordinal: 0, bits: 1 },   // ~7% de codewords recuperables
  M: { ordinal: 1, bits: 0 },   // ~15%
  Q: { ordinal: 2, bits: 3 },   // ~25%
  H: { ordinal: 3, bits: 2 },   // ~30%
};

// Codewords de correccion por bloque, por nivel (L, M, Q, H) y version (1..40).
const ECC_CODEWORDS_PER_BLOCK = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// Numero de bloques de correccion, mismo orden.
const NUM_ERROR_CORRECTION_BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modulos disponibles para datos y correccion en una version, sin los patrones fijos. */
function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;   // informacion de version
  }
  return result;
}

/** Codewords de datos que caben en una version con un nivel dado. */
function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver - 1] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver - 1];
}

// ------------------------------------------------------------ Reed-Solomon

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Coeficientes del polinomio generador de grado `degree` (el monico va implicito). */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ------------------------------------------------------------ codificacion

/** Bits de datos (modo bytes) rellenos hasta la capacidad de la version. */
function encodeData(bytes, ver, ecl) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };

  push(0b0100, 4);                              // modo bytes
  push(bytes.length, ver <= 9 ? 8 : 16);        // cuenta de caracteres
  for (const b of bytes) push(b, 8);

  const capacity = dataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminador
  push(0, (8 - bits.length % 8) % 8);           // hasta el byte
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const out = new Uint8Array(bits.length / 8);
  bits.forEach((b, i) => { out[i >>> 3] |= b << (7 - (i & 7)); });
  return out;
}

/** Parte en bloques, anade la correccion a cada uno y los entrelaza. */
function addEccAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver - 1];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver - 1];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + datLen);
    k += datLen;
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat, 0);
    block.set(rsRemainder(dat, divisor), shortBlockLen + 1 - blockEccLen);
    blocks.push({ block, datLen });
  }

  const result = new Uint8Array(rawCodewords);
  let k = 0;
  for (let i = 0; i <= shortBlockLen; i++) {
    blocks.forEach(({ block, datLen }, j) => {
      // El byte de relleno de los bloques cortos (posicion shortBlockLen - blockEccLen) se salta.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result[k++] = block[i];
    });
  }
  return result;
}

// ------------------------------------------------------------- la matriz

/** Posiciones (centros) de los patrones de alineamiento de una version. */
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Matrix {
  constructor(size) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Uint8Array(size));
    this.isFunction = Array.from({ length: size }, () => new Uint8Array(size));
  }

  set(x, y, dark) {
    this.modules[y][x] = dark ? 1 : 0;
    this.isFunction[y][x] = 1;
  }

  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  /** Informacion de formato (nivel + mascara), con su BCH, en las dos copias. */
  drawFormat(ecl, mask) {
    const data = (ecl.bits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => (bits >>> i) & 1;
    const n = this.size;

    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, 1);   // el modulo oscuro fijo
  }

  /** Informacion de version (solo a partir de la 7), con su BCH de 18 bits. */
  drawVersion(ver) {
    if (ver < 7) return;
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    const n = this.size;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit);
      this.set(b, a, bit);
    }
  }

  drawFunctionPatterns(ver, ecl) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);

    const align = alignmentPositions(ver);
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        // Los tres que caerian encima de los buscadores no se pintan.
        if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
        this.drawAlignment(align[i], align[j]);
      }
    }
    this.drawFormat(ecl, 0);   // reservar los modulos; la mascara real se pone luego
    this.drawVersion(ver);
  }

  /** Coloca los codewords en zigzag, de derecha a izquierda, saltando los patrones. */
  drawCodewords(data) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
            i++;
          }
          // Si sobran modulos se quedan en claro: son los bits de relleno.
        }
      }
    }
  }

  /** Aplica (o deshace: es XOR) la mascara `mask` sobre los modulos de datos. */
  applyMask(mask) {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] ^= 1;
      }
    }
  }

  /** Penalizacion de las cuatro reglas de la norma: cuanto mas baja, mas legible. */
  penalty() {
    const n = this.size;
    const m = this.modules;
    let result = 0;

    // Regla 1 (tiradas de 5 o mas iguales) y regla 3 (patron parecido al buscador).
    for (let y = 0; y < n; y++) {
      let runColor = 0;
      let runX = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < n; x++) {
        if (m[y][x] === runColor) {
          runX++;
          if (runX === 5) result += 3;
          else if (runX > 5) result++;
        } else {
          finderPenaltyAddHistory(runX, history, n);
          if (runColor === 0) result += finderPenaltyCount(history, n) * 40;
          runColor = m[y][x];
          runX = 1;
        }
      }
      result += finderPenaltyTerminate(runColor, runX, history, n) * 40;
    }
    for (let x = 0; x < n; x++) {
      let runColor = 0;
      let runY = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < n; y++) {
        if (m[y][x] === runColor) {
          runY++;
          if (runY === 5) result += 3;
          else if (runY > 5) result++;
        } else {
          finderPenaltyAddHistory(runY, history, n);
          if (runColor === 0) result += finderPenaltyCount(history, n) * 40;
          runColor = m[y][x];
          runY = 1;
        }
      }
      result += finderPenaltyTerminate(runColor, runY, history, n) * 40;
    }

    // Regla 2: bloques 2x2 del mismo color.
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    }

    // Regla 4: desequilibrio entre claros y oscuros.
    let dark = 0;
    for (const row of m) for (const v of row) dark += v;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
}

function finderPenaltyCount(history, n) {
  const core = history[1] > 0 && history[2] === history[1] && history[3] === history[1] * 3
    && history[4] === history[1] && history[5] === history[1];
  return (core && history[0] >= history[1] * 4 && history[6] >= history[1] ? 1 : 0)
    + (core && history[6] >= history[1] * 4 && history[0] >= history[1] ? 1 : 0);
}

function finderPenaltyAddHistory(run, history, n) {
  if (history[0] === 0) run += n;   // la primera tirada clara cuenta como si viniera del borde
  history.pop();
  history.unshift(run);
}

function finderPenaltyTerminate(color, run, history, n) {
  if (color === 1) {
    finderPenaltyAddHistory(run, history, n);
    run = 0;
  }
  run += n;   // el borde cuenta como claro
  finderPenaltyAddHistory(run, history, n);
  return finderPenaltyCount(history, n);
}

// ------------------------------------------------------------------- API

/**
 * Codifica `text` (UTF-8) y devuelve `{ size, modules, version }`, con
 * `modules[y][x]` a 1 donde el modulo es oscuro. Elige la version mas pequena
 * en la que cabe con el nivel pedido (`M` por defecto: aguanta un reflejo en la
 * pantalla sin engordar mucho) y la mascara de menor penalizacion.
 */
export function encodeQr(text, { ecl = ECL.M, minVersion = 1, maxVersion = 40 } = {}) {
  const bytes = new TextEncoder().encode(String(text));

  let ver = minVersion;
  for (;; ver++) {
    if (ver > maxVersion) throw new Error(`El texto no cabe en un QR (${bytes.length} bytes)`);
    const capacity = dataCodewords(ver, ecl) * 8;
    const needed = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= capacity) break;
  }

  const data = addEccAndInterleave(encodeData(bytes, ver, ecl), ver, ecl);
  const qr = new Matrix(ver * 4 + 17);
  qr.drawFunctionPatterns(ver, ecl);
  qr.drawCodewords(data);

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormat(ecl, mask);
    const score = qr.penalty();
    if (score < bestScore) { bestScore = score; best = mask; }
    qr.applyMask(mask);   // XOR: deshace
  }
  qr.applyMask(best);
  qr.drawFormat(ecl, best);

  return { size: qr.size, modules: qr.modules, version: ver, mask: best };
}

/**
 * SVG del codigo con `quiet` modulos de margen. Modulos oscuros sobre fondo
 * claro, la polaridad de siempre: no todas las camaras leen un QR invertido, y
 * la estetica se pone en el marco, no en el codigo.
 */
export function qrToSvg(qr, { quiet = 4, dark = '#1a1b26', light = '#c0caf5' } = {}) {
  const n = qr.size + quiet * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${n}" height="${n}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}

/**
 * El codigo en caracteres de bloque, dos filas de modulos por linea de texto
 * (▀ ▄ █ y espacio). Con `ansi` se fuerzan los colores -- fondo blanco, tinta
 * negra -- para que salga con la polaridad normal tanto en terminales oscuras
 * como claras; sin el, se deja al tema de la terminal.
 */
export function qrToBlocks(qr, { quiet = 2, ansi = true } = {}) {
  const n = qr.size + quiet * 2;
  const at = (x, y) => {
    const xx = x - quiet;
    const yy = y - quiet;
    if (xx < 0 || yy < 0 || xx >= qr.size || yy >= qr.size) return 0;
    return qr.modules[yy][xx];
  };
  const on = ansi ? '\x1b[47m\x1b[30m' : '';
  const off = ansi ? '\x1b[0m' : '';
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const top = at(x, y);
      const bottom = y + 1 < n ? at(x, y + 1) : 0;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(on + line + off);
  }
  return lines.join('\n');
}
