// Version del protocolo de transferencia del CLI: la que viaja dentro del
// manifiesto cifrado por TCP directo y en la oferta (`cli-offer`) del relay.
//
// Vive aqui, y no en cli/src/transfer.js, porque el receptor web tambien la
// comprueba: un `drop send` antiguo que ofrezca otra version no se entiende a
// medias, se rechaza con un mensaje que dice que actualice.
//
//   1  v0.5.0: manifiesto con version dentro del AEAD; relay en claro.
//   2  relay cifrado de extremo a extremo (AES-256-GCM con la clave scrypt del
//      codigo) y prueba de conocimiento derivada de esa clave, no del secreto.
//   3  reanudacion: por TCP el receptor contesta al manifiesto con `ready` (los
//      `.part` que tiene y el hash de cada uno) y el emisor abre cada archivo
//      con `start` y el offset desde el que manda; por relay lo mismo dentro de
//      `cli-accept` y `cli-start`. Un emisor v2 manda datos sin `start` y un
//      receptor v2 nunca contesta al manifiesto: no se entienden a medias.
//   4  tamano desconocido: un archivo del manifiesto (TCP directo y
//      `cli-manifest`/`cli-start` por relay) puede llevar `size: null`, que es
//      lo que manda `drop send -` al leer de stdin. El archivo acaba donde
//      diga su `end`, no en un byte contado. Un receptor v3 se creia el total
//      (NaN en la barra, acuses que no salen) y "funcionaba" a medias, que es
//      peor que rechazarse.
export const PROTOCOL_VERSION = 4;
