import { spawn } from 'node:child_process';

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

console.log('=== BENCHMARK SUITE: Drop CLI Speed Tester ===\n');

// 1. Iniciar servidor de señalización local en puerto 3458
const serverProc = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: '3458' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve) => {
  serverProc.stdout.on('data', () => resolve());
  setTimeout(resolve, 600);
});

console.log('Servidor de señalización listo en http://localhost:3458\n');

function runPairTest(name, hostExtraArgs = [], guestExtraArgs = []) {
  return new Promise((resolve, reject) => {
    console.log(`\n---------------------------------------------------------`);
    console.log(`Ejecutando prueba: ${name}`);
    console.log(`---------------------------------------------------------`);

    const hostArgs = ['cli/src/cli.js', 'speed', '-s', 'http://localhost:3458', '-t', '2', ...hostExtraArgs];
    const host = spawn('node', hostArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    let token = null;
    let guest = null;
    let hostOutput = '';
    let guestOutput = '';
    let hostDone = false;
    let guestDone = false;

    function checkDone() {
      if (hostDone && guestDone) {
        console.log(`✔ Prueba "${name}" finalizada con éxito.`);
        resolve({ hostOutput, guestOutput });
      }
    }

    host.stdout.on('data', (d) => {
      const text = stripAnsi(d.toString());
      hostOutput += text;
      process.stdout.write(`[HOST] ${text}`);

      const match = text.match(/Código:\s+([a-zA-Z0-9_-]+)/);
      if (match && !token) {
        token = match[1];
        const guestArgs = ['cli/src/cli.js', 'speed', token, '-s', 'http://localhost:3458', '-t', '2', ...guestExtraArgs];
        guest = spawn('node', guestArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        guest.stdout.on('data', (gd) => {
          const gText = stripAnsi(gd.toString());
          guestOutput += gText;
          process.stdout.write(`[GUEST] ${gText}`);
        });

        guest.stderr.on('data', (gd) => {
          console.error(`[GUEST ERR] ${gd.toString()}`);
        });

        guest.on('close', (code) => {
          if (code !== 0) return reject(new Error(`Guest falló con código ${code}`));
          guestDone = true;
          checkDone();
        });
      }
    });

    host.stderr.on('data', (d) => {
      console.error(`[HOST ERR] ${d.toString()}`);
    });

    host.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Host falló con código ${code}`));
      hostDone = true;
      checkDone();
    });
  });
}

try {
  // Test 1: Conexión TCP directa (ancho de banda máximo nativo)
  await runPairTest('Modo TCP Directo (Nativo)', [], []);

  // Test 2: Conexión Relay (Streaming cifrado por WebSocket)
  await runPairTest('Modo Relay por Servidor (--relay)', ['--relay'], ['--relay']);

  console.log('\n======================================================');
  console.log('✔ ¡Todos los tests de velocidad (TCP y Relay) superados!');
  console.log('======================================================\n');
  serverProc.kill();
  process.exit(0);
} catch (err) {
  console.error('\n✖ Error en el benchmark:', err);
  serverProc.kill();
  process.exit(1);
}
