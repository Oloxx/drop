// Huella corta de sesion (SAS, "short authentication string").
//
// ============================================================================
// QUE PROBLEMA RESUELVE
// ============================================================================
// El codigo de sala no autentica a nadie: no hay PAKE. En el camino del navegador
// el servidor reenvia el SDP, asi que un servidor comprometido puede sustituir los
// fingerprints DTLS de los dos extremos, hablar DTLS con cada uno por separado y
// leerlo todo por el medio. Los dos lados verian una transferencia normal.
//
// La defensa barata, la misma que usan Signal o Zoom, es sacar unas pocas palabras
// de lo que se ha negociado de verdad y que los humanos las comparen por OTRO canal
// (una llamada, estar en la misma habitacion). Al de en medio no le cuadran las dos
// mitades: cada extremo negocio con EL, no con el otro, asi que las palabras salen
// distintas y se ve.
//
// ============================================================================
// QUE ENTRA EN LA HUELLA Y QUE NO
// ============================================================================
// NO entran las palabras del codigo. Serian 44 bits detras de un SHA-256, o sea un
// verificador offline barato del secreto en cuanto la huella se leyera en voz alta
// por un canal que alguien graba. Entra solo:
//
//   · en el navegador: los fingerprints DTLS de los dos extremos, que es justo lo
//     que un servidor MITM tiene que cambiar para colarse;
//   · en el CLI: la clave AES ya derivada con scrypt (ver cli/src/crypto.js), que
//     es material de clave, no el secreto en claro. Un ataque offline contra ella
//     cuesta lo mismo que atacar el codigo entero: ~3,5 x 10^10 anos-CPU.
//
// La huella se calcula en cada extremo con lo que ya tiene delante. NO viaja por el
// cable: si viajase, el de en medio la cambiaria al vuelo y no valdria de nada.
//
// ============================================================================
// TRES PALABRAS
// ============================================================================
// 33 bits. Un MITM que quiera que las dos huellas coincidan tiene que generar
// claves DTLS hasta dar con una colision de 33 bits, ~8.600 millones de intentos,
// y hacerlo DENTRO de la ventana de la negociacion. No es un secreto a largo plazo
// que haya que sobredimensionar: se compara una vez y se tira. Cuatro palabras
// serian mas seguras y menos usadas, que es peor seguridad.
import { WORDLIST } from './wordlist.js';

export const SAS_WORDS = 3;

/**
 * Cadena canonica que se hashea. Las partes se ORDENAN: los dos extremos tienen
 * los mismos datos pero cada uno llama "mio" y "suyo" a lo contrario, y sin
 * ordenar cada uno hashearia una cadena distinta.
 */
export function sasInput(context, parts) {
  const limpio = parts.map((p) => String(p).trim().toLowerCase()).filter(Boolean).sort();
  return `drop-sas-v1|${context}|${limpio.join('|')}`;
}

/**
 * Convierte un digest hexadecimal en las palabras de la huella: 11 bits por
 * palabra, igual que el codigo de sala (ver shared/codes.js).
 */
export function sasWords(digestHex) {
  const hex = String(digestHex).trim();
  if (!/^[0-9a-f]{32,}$/i.test(hex)) throw new Error('digest hexadecimal no valido para la huella');

  const words = [];
  for (let i = 0; i < SAS_WORDS; i++) {
    // 4 caracteres hex = 16 bits, de los que se usan los 11 de abajo.
    const chunk = parseInt(hex.slice(i * 4, i * 4 + 4), 16);
    words.push(WORDLIST[chunk & 0x7ff]);
  }
  return words;
}

/** La huella tal como se ensena: `lemon-radar-tiger`. */
export function formatSas(words) {
  return words.join('-');
}

/**
 * Los fingerprints DTLS de un SDP, normalizados a `sha-256 AA:BB:...`.
 *
 * Un SDP trae uno por sesion (a nivel de sesion o de media, segun el navegador) y
 * puede repetirse por cada m-line: se devuelven sin duplicados.
 */
export function dtlsFingerprints(sdp) {
  const out = new Set();
  for (const line of String(sdp || '').split(/\r?\n/)) {
    const match = line.trim().match(/^a=fingerprint:(\S+)\s+(\S+)$/i);
    if (match) out.add(`${match[1].toLowerCase()} ${match[2].toUpperCase()}`);
  }
  return [...out];
}
