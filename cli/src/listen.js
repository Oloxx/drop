/**
 * Arranque de servidores TCP con errores que se pueden leer.
 *
 * Ningun `net.Server` del proyecto tenia listener de `error` y todos los `listen`
 * eran `new Promise((resolve) => server.listen(...))`, sin rama de rechazo. Un
 * EADDRINUSE o un EACCES no tenia entonces a donde ir: salia como excepcion no
 * capturada con su traza, y `drop send archivo -p 80` moria asi.
 */

/**
 * Traduce un error de `listen` a algo que le diga al usuario que hacer.
 * Conserva el `code` original, que es de lo que dependen los llamantes.
 */
export function explainListenError(err, port) {
  const shown = port ? `${port}` : 'solicitado';

  if (err?.code === 'EADDRINUSE') {
    const e = new Error(
      `El puerto ${shown} ya está en uso: elige otro con -p o deja que drop escoja uno libre.`
    );
    e.code = 'EADDRINUSE';
    e.cause = err;
    return e;
  }

  if (err?.code === 'EACCES') {
    const e = new Error(
      `Sin permisos para escuchar en el puerto ${shown}: por debajo de 1024 hace falta root o administrador. Usa -p con un puerto por encima de 1024.`
    );
    e.code = 'EACCES';
    e.cause = err;
    return e;
  }

  return err;
}

/**
 * `server.listen()` como promesa que de verdad RECHAZA si el bind falla.
 *
 * Engancha `error` y `listening` a la vez y los desengancha mutuamente: si se deja
 * el de `error` puesto, un fallo posterior lo cogeria una promesa ya resuelta y se
 * perderia. El listener permanente lo pone el llamante con `watchServerErrors`.
 */
export function listenOrExplain(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(explainListenError(err, port));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Listener permanente para los errores que llegan DESPUES del bind. Sin esto un
 * fallo del socket de escucha con la transferencia ya en marcha sigue siendo una
 * excepcion no capturada.
 */
export function watchServerErrors(server, onError) {
  server.on('error', (err) => onError(explainListenError(err, server.address()?.port)));
  return server;
}
