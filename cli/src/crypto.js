import crypto from 'node:crypto';

// Deriva una clave de 256 bits y un salt fijo a partir del token de la sala usando HKDF
export function deriveKey(token) {
  const salt = crypto.createHash('sha256').update('drop-salt-v1').digest();
  return crypto.hkdfSync('sha256', Buffer.from(token), salt, Buffer.from('drop-e2ee-key'), 32);
}

// Cifra un trozo de datos con AES-256-GCM.
// Formato del paquete: [12 bytes IV] [16 bytes Auth Tag] [N bytes Cifrados]
export function encryptChunk(chunk, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

// Descifra un paquete AES-256-GCM
export function decryptChunk(packet, key) {
  if (packet.length < 28) {
    throw new Error('Paquete demasiado corto para descifrar');
  }
  const iv = packet.subarray(0, 12);
  const tag = packet.subarray(12, 28);
  const encrypted = packet.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
