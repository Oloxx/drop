// Limite de ancho de banda para `--limit 10M`: un cubo de fichas que se rellena
// con el reloj y admite deficit.
//
// Se llama con el tamano de cada trozo ANTES de escribirlo: si no hay fichas, se
// duerme lo que tarde en haberlas. Las fichas pueden quedar en negativo a
// proposito, porque los trozos (512 KiB por TCP) pueden ser mas grandes que el
// limite por segundo (`--limit 100K`): con un cubo que no baja de cero ese trozo
// no saldria nunca. El deficit se paga durmiendo, y la media sale exacta.
//
// La rafaga maxima es un segundo de limite: suficiente para que un enlace normal
// no se note a saltos y poco para no reventar el limite en el arranque.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `--limit 10M` -> bytes por segundo. K/M/G en base 1024, sin sufijo son bytes. */
export function parseRate(text) {
  const m = String(text).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmg])?(?:b|ib|b\/s)?$/);
  if (!m) {
    const err = new Error(`Límite no válido: "${text}". Ejemplos: 500K, 10M, 1.5G (bytes por segundo).`);
    err.code = 'BAD_RATE';
    throw err;
  }
  const factor = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]] || 1;
  const rate = Math.round(Number(m[1]) * factor);
  if (!(rate > 0)) {
    const err = new Error(`El límite tiene que ser mayor que cero: "${text}".`);
    err.code = 'BAD_RATE';
    throw err;
  }
  return rate;
}

/**
 * Devuelve `{ take(bytes) }`. Sin limite (`null`/0) es un `take` que no espera
 * nunca, para que el camino caliente no tenga que preguntar.
 */
export function makeThrottle(bytesPerSec) {
  if (!bytesPerSec) return { rate: 0, take: async () => {} };
  let tokens = bytesPerSec;
  let last = performance.now();
  return {
    rate: bytesPerSec,
    async take(bytes) {
      const now = performance.now();
      tokens = Math.min(bytesPerSec, tokens + ((now - last) / 1000) * bytesPerSec);
      last = now;
      tokens -= bytes;
      if (tokens < 0) await sleep((-tokens / bytesPerSec) * 1000);
    },
  };
}
