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

function getBarWidth(preferred = 30) {
  const cols = process.stdout.columns;
  if (!cols || cols >= 105) return preferred;
  return Math.max(10, Math.min(preferred, cols - 72));
}

export function renderProgressBar(current, total, speed, width = 30) {
  const barWidth = getBarWidth(width);
  const pct = total > 0 ? Math.min(1, current / total) : 0;
  const filled = Math.round(barWidth * pct);
  const empty = barWidth - filled;
  const bar = `${c.cyan}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`;
  const pctStr = `${(pct * 100).toFixed(0)}%`.padStart(4);
  const eta = (current < total && speed > 0) ? fmtEta((total - current) / speed) : '';
  const etaStr = eta ? `· ETA ${eta}` : '';

  process.stdout.write(`\r  ${bar} ${pctStr} · ${fmtBytes(current)} / ${fmtBytes(total)} · ${fmtSpeed(speed)} ${etaStr}   \x1b[K`);
}

export function renderProgressBarComplete(total, totalTimeSec, avgSpeed, width = 30) {
  const barWidth = getBarWidth(width);
  const bar = `${c.cyan}${'█'.repeat(barWidth)}${c.reset}`;
  const durationStr = fmtDuration(totalTimeSec);
  const speedStr = fmtSpeed(avgSpeed);

  process.stdout.write(`\r  ${bar} 100% · ${fmtBytes(total)} / ${fmtBytes(total)} · ${durationStr} · Media: ${speedStr}   \x1b[K\n`);
}

