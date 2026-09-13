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
export const PROTOCOL_VERSION = 2;
