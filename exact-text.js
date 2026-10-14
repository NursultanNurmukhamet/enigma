/**
 * Reversible UTF-8 transport around historical Enigma I, NOT a historical mode.
 * No normalization, transliteration, persistence, randomness or network access.
 * CRC32 detects accidental damage/wrong keys; it is NOT authentication.
 */
import { ALPHABET, DEFAULT_SETTINGS, transform } from './enigma.js';

export const EXACT_FORMAT_VERSION = 1;
export const EXACT_PREFIX = `ENIGMA-UTF8-${EXACT_FORMAT_VERSION}:`;
export const MAX_EXACT_BYTES = 10000;

// Encrypted frame: EGU8 | version:u8 | UTF-8 length:u32be | bytes | CRC32:u32be.
// CRC covers all preceding frame bytes (magic, version, length and message).
const MAGIC = [0x45, 0x47, 0x55, 0x38];
const HEADER_BYTES = 9;
const CHECKSUM_BYTES = 4;
const FRAME_OVERHEAD = HEADER_BYTES + CHECKSUM_BYTES;
export const MAX_EXACT_CIPHERTEXT_LENGTH = EXACT_PREFIX.length + 2 * (FRAME_OVERHEAD + MAX_EXACT_BYTES);

const DECRYPT_ERROR = 'Не удалось расшифровать точный текст: неверный ключ или повреждённый формат.';
const SIZE_ERROR = `Точный текст: не более ${MAX_EXACT_BYTES.toLocaleString('ru-RU')} байт UTF-8.`;

/** Validate scalar Unicode and count UTF-8 before allocating encoded bytes. */
export function utf8ByteLength(text) {
  if (typeof text !== 'string') throw new Error('Сообщение должно быть текстом.');
  // UTF-8 bytes >= UTF-16 code units for every well-formed string. This cheap
  // guard also bounds the scan; invalid UTF-16 must never silently become U+FFFD.
  if (text.length > MAX_EXACT_BYTES) throw new Error(SIZE_ERROR);
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        throw new Error('Текст содержит некорректный символ Unicode.');
      }
      index += 1;
      length += 4;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      throw new Error('Текст содержит некорректный символ Unicode.');
    } else {
      length += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (length > MAX_EXACT_BYTES) throw new Error(SIZE_ERROR);
  }
  return length;
}

// CRC-32/ISO-HDLC (reflected polynomial 0xEDB88320, init/xorout 0xFFFFFFFF).
const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let checksum = 0xFFFFFFFF;
  for (const byte of bytes) checksum = (checksum >>> 8) ^ CRC_TABLE[(checksum ^ byte) & 0xFF];
  return (checksum ^ 0xFFFFFFFF) >>> 0;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function encodePairs(bytes) {
  let letters = '';
  for (const byte of bytes) letters += ALPHABET[Math.floor(byte / 26)] + ALPHABET[byte % 26];
  return letters;
}

function decodePairs(letters) {
  const bytes = new Uint8Array(letters.length / 2);
  for (let index = 0; index < letters.length; index += 2) {
    const value = (letters.charCodeAt(index) - 65) * 26 + letters.charCodeAt(index + 1) - 65;
    if (value > 255 || value < 0) throw new Error(DECRYPT_ERROR);
    bytes[index / 2] = value;
  }
  return bytes;
}

/** Encrypt even empty text into a nonempty, versioned container. Starts reset. */
export function encryptExact(text, settings = DEFAULT_SETTINGS) {
  const length = utf8ByteLength(text);
  const encoded = new TextEncoder().encode(text);
  const frame = new Uint8Array(FRAME_OVERHEAD + length);
  frame.set(MAGIC, 0);
  frame[4] = EXACT_FORMAT_VERSION;
  writeUint32(frame, 5, length);
  frame.set(encoded, HEADER_BYTES);
  const checksumOffset = HEADER_BYTES + length;
  writeUint32(frame, checksumOffset, crc32(frame.subarray(0, checksumOffset)));
  return EXACT_PREFIX + transform(encodePairs(frame), settings);
}

/**
 * Strictly decode only this version, including empty plaintext. No trimming or
 * ignored characters. Size is bounded BEFORE Enigma, byte allocation or decode.
 * Metadata and CRC must match before fatal UTF-8 decoding. Success does not prove
 * who sent a message: CRC32 can be forged and Enigma is not modern cryptography.
 */
export function decryptExact(container, settings = DEFAULT_SETTINGS) {
  if (typeof container !== 'string' || container.length > MAX_EXACT_CIPHERTEXT_LENGTH ||
      container.length < EXACT_PREFIX.length + 2 * FRAME_OVERHEAD || !container.startsWith(EXACT_PREFIX)) {
    throw new Error(DECRYPT_ERROR);
  }
  const body = container.slice(EXACT_PREFIX.length);
  if (body.length % 2 !== 0 || !/^[A-Z]+$/.test(body)) throw new Error(DECRYPT_ERROR);
  const frame = decodePairs(transform(body, settings));
  if (!MAGIC.every((byte, index) => frame[index] === byte) || frame[4] !== EXACT_FORMAT_VERSION) {
    throw new Error(DECRYPT_ERROR);
  }
  const length = readUint32(frame, 5);
  if (length > MAX_EXACT_BYTES || length !== frame.length - FRAME_OVERHEAD) throw new Error(DECRYPT_ERROR);
  const checksumOffset = HEADER_BYTES + length;
  if (readUint32(frame, checksumOffset) !== crc32(frame.subarray(0, checksumOffset))) {
    throw new Error(DECRYPT_ERROR);
  }
  try {
    // ignoreBOM=true means do not consume a leading BOM: preserve U+FEFF exactly.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(frame.subarray(HEADER_BYTES, checksumOffset));
  } catch {
    throw new Error(DECRYPT_ERROR);
  }
}
