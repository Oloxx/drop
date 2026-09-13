export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
}

export function fmtSpeed(bytesPerSec) {
  if (bytesPerSec < 1024 * 1024) {
    const kbps = bytesPerSec / 1024;
    const kbit = (bytesPerSec * 8) / 1024;
    return `${c.green}${kbps.toFixed(1)} KB/s${c.reset} ${c.dim}(${kbit.toFixed(0)} Kbit/s)${c.reset}`;
  }
  const mbps = bytesPerSec / (1024 * 1024);
  const mbit = (bytesPerSec * 8) / (1024 * 1024);
  return `${c.green}${mbps.toFixed(1)} MB/s${c.reset} ${c.dim}(${mbit.toFixed(0)} Mbit/s)${c.reset}`;
}

export function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return Math.ceil(seconds) + 's';
  const m = Math.floor(seconds / 60);
  return `${m}m ${Math.round(seconds % 60)}s`;
}

export function fmtDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0s';
  if (seconds < 0.1) return '< 0.1s';
  if (seconds < 1) return seconds.toFixed(1) + 's';
  if (seconds < 60) return Math.round(seconds) + 's';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

export function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';
}

// Por donde sale la barra de progreso. Con `drop recv --stdout` el contenido va
// por stdout y todo lo demas tiene que irse a stderr, o se mezcla con los datos.
let out = process.stdout;
export function setProgressStream(stream) { out = stream; }

function getBarWidth(preferred = 30) {
  const cols = out.columns;
  if (!cols || cols >= 105) return preferred;
  return Math.max(10, Math.min(preferred, cols - 72));
}

/**
 * En que archivo va una transferencia y cuanto lleva de el, a partir del total
 * acumulado y el manifiesto: los archivos van en orden y sin huecos, asi que el
 * acumulado ya lo dice todo. Es la misma cuenta que hace la web, y sirve igual
 * para el emisor (bytes confirmados) y para el receptor (bytes escritos).
 */
export function fileAt(files, done) {
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const size = files[i].size || 0;
    if (done < offset + size || i === files.length - 1) {
      return { index: i, count: files.length, name: files[i].name, size, done: Math.max(0, Math.min(size, done - offset)) };
    }
    offset += size;
  }
  return null;
}

// Si la ultima barra pintada llevaba linea de archivo encima, hay que dejarla
// bien al terminar: `renderProgressBarComplete` la cierra antes de fijar la barra.
let fileLine = false;

function fileLineFor(files, current) {
  const f = fileAt(files, current);
  if (!f) return '';
  const cols = out.columns || 120;
  const head = `[${f.index + 1}/${f.count}] `;
  const tail = ` ${(f.size ? Math.min(100, Math.floor((f.done / f.size) * 100)) : 100)}% · ${fmtBytes(f.done)} / ${fmtBytes(f.size)}`;
  const room = Math.max(8, cols - head.length - tail.length - 6);
  const name = f.name.length > room ? f.name.slice(0, room - 1) + '…' : f.name;
  return `${c.dim}${head}${c.reset}${name}${c.dim}${tail}${c.reset}`;
}

/**
 * Barra de progreso. Con un manifiesto de MAS de un archivo pinta encima una
 * linea con el archivo en curso ([2/5] foto.jpg 45% · 1,2 MB / 5 MB): con un
 * lote grande la barra total parece parada durante minutos y no dice ni cual
 * va ni cuantos quedan. Con un solo archivo la salida es la de siempre.
 */
export function renderProgressBar(current, total, speed, width = 30, files = null) {
  const barWidth = getBarWidth(width);
  const pct = total > 0 ? Math.min(1, current / total) : 0;
  const filled = Math.round(barWidth * pct);
  const empty = barWidth - filled;
  const bar = `${c.cyan}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`;
  const pctStr = `${(pct * 100).toFixed(0)}%`.padStart(4);
  const eta = (current < total && speed > 0) ? fmtEta((total - current) / speed) : '';
  const etaStr = eta ? `· ETA ${eta}` : '';
  const barLine = `  ${bar} ${pctStr} · ${fmtBytes(current)} / ${fmtBytes(total)} · ${fmtSpeed(speed)} ${etaStr}   \x1b[K`;

  if (files && files.length > 1) {
    // Dos lineas: se pintan las dos y se sube una, para que el siguiente `\r`
    // vuelva a caer al principio de la de arriba.
    fileLine = true;
    out.write(`\r\x1b[K  ${fileLineFor(files, current)}\n\r${barLine}\x1b[1A`);
    return;
  }
  fileLine = false;
  out.write(`\r${barLine}`);
}

export function renderProgressBarComplete(total, totalTimeSec, avgSpeed, width = 30) {
  const barWidth = getBarWidth(width);
  const bar = `${c.cyan}${'█'.repeat(barWidth)}${c.reset}`;
  const durationStr = fmtDuration(totalTimeSec);
  const speedStr = fmtSpeed(avgSpeed);

  // El cursor esta en la linea del archivo: se cierra con su marca y se baja.
  if (fileLine) {
    fileLine = false;
    out.write(`\r\x1b[K  ${c.dim}[✔] todos los archivos${c.reset}\n`);
  }
  out.write(`\r  ${bar} 100% · ${fmtBytes(total)} / ${fmtBytes(total)} · ${durationStr} · Media: ${speedStr}   \x1b[K\n`);
}

