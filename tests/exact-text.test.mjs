import test from 'node:test';
import assert from 'node:assert/strict';
import { ALPHABET, DEFAULT_SETTINGS, transform, buildTelegramShareUrl } from '../enigma.js';
import { transformExperimental } from '../experimental.js';
import {
  EXACT_FORMAT_VERSION, EXACT_PREFIX, MAX_EXACT_BYTES, MAX_EXACT_CIPHERTEXT_LENGTH,
  EXPERIMENTAL_EXACT_PREFIX, MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH, getExactCiphertextLimit,
  utf8ByteLength, encryptExact, decryptExact,
} from '../exact-text.js';

const key = {
  rotors: ['V', 'II', 'IV'], rings: 'GHT', positions: 'ZEV',
  plugboard: 'AB CD EF GH IJ KL MN OP QR ST', reflector: 'B',
};
const decodeError = /неверный ключ или повреждённый формат/;

// Deliberately independent bit-at-a-time CRC implementation for crafted frames.
function referenceCrc32(bytes) {
  let value = 0xFFFFFFFF;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
  }
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function frameFor(bytes) {
  const frame = Buffer.alloc(bytes.length + 13);
  frame.write('EGU8', 0, 'ascii');
  frame[4] = 1;
  frame.writeUInt32BE(bytes.length, 5);
  frame.set(bytes, 9);
  refreshChecksum(frame);
  return frame;
}

function refreshChecksum(frame) {
  frame.writeUInt32BE(referenceCrc32(frame.subarray(0, -4)), frame.length - 4);
}

function pairsFor(bytes) {
  return [...bytes].map((byte) => ALPHABET[Math.floor(byte / 26)] + ALPHABET[byte % 26]).join('');
}

function containerFor(frame, settings = key) {
  return EXACT_PREFIX + transform(pairsFor(frame), settings);
}

function experimentalKey(count = 30) {
  const baseWiring = 'EKMFLGDQVZNTOWYHXUSPAIBRCJ';
  return {
    rotors: Array.from({ length: count }, (_, index) => {
      const base = index < 26 ? baseWiring : [...baseWiring].reverse().join('');
      const offset = index % 26;
      return { wiring: base.slice(offset) + base.slice(0, offset), ring: ALPHABET[offset], position: index === 0 ? 'Q' : 'Z' };
    }),
    reflector: 'B', stepping: 'odometer-v1', plugboard: 'AB CD EF GH IJ KL MN OP QR ST',
  };
}

const experimentalOptions = { machine: 'experimental' };

function experimentalFrameFor(bytes) {
  const frame = frameFor(bytes);
  frame.write('EXU8', 0, 'ascii');
  refreshChecksum(frame);
  return frame;
}

function experimentalContainerFor(frame, settings) {
  return EXPERIMENTAL_EXACT_PREFIX + transformExperimental(pairsFor(frame), settings);
}

test('exact transport has explicit version and derived byte/letter bounds', () => {
  assert.equal(EXACT_FORMAT_VERSION, 1);
  assert.equal(EXACT_PREFIX, 'ENIGMA-UTF8-1:');
  assert.equal(MAX_EXACT_BYTES, 10000);
  assert.equal(MAX_EXACT_CIPHERTEXT_LENGTH, 20040);
  assert.equal(MAX_EXACT_CIPHERTEXT_LENGTH, EXACT_PREFIX.length + 2 * (13 + MAX_EXACT_BYTES));
});

test('CRC32 fixture uses standard ISO-HDLC check value', () => {
  assert.equal(referenceCrc32(Buffer.from('123456789')), 0xCBF43926);
  const text = '123456789';
  // Read the actual encrypted frame through the independently tested Enigma.
  const letters = transform(encryptExact(text, key).slice(EXACT_PREFIX.length), key);
  const actual = Buffer.from(Array.from({ length: letters.length / 2 }, (_, index) =>
    (letters.charCodeAt(2 * index) - 65) * 26 + letters.charCodeAt(2 * index + 1) - 65));
  assert.deepEqual(actual, frameFor(Buffer.from(text)));
  assert.equal(decryptExact(containerFor(frameFor(Buffer.from(text))), key), text);
});

test('exact mixed Unicode preserves Russian spelling, case, scripts and emoji', () => {
  const text = 'Ёжик, ёлка и ЕЁ ЪЬ! Mixed Case 123 — Қазақша / 中文 / العربية / Ελληνικά 🙂 👩🏽‍💻 ❤️';
  assert.equal(decryptExact(encryptExact(text, key), key), text);
  assert.equal(decryptExact(encryptExact(text)), text);
});

test('exact transport preserves combining marks without Unicode normalization', () => {
  const text = 'é e\u0301 Ё Е\u0308 ё е\u0308 a\u0327\u0301 \u0301';
  assert.notEqual(text, text.normalize('NFC'));
  assert.equal(decryptExact(encryptExact(text, key), key), text);
  assert.notEqual(encryptExact('é', key), encryptExact('e\u0301', key));
});

test('exact transport preserves LF, CRLF, CR, tabs, trailing spaces and blank lines', () => {
  const text = '\r\nПервая\n\nВторая\rТретья\r\n\t  конец  \n';
  assert.equal(decryptExact(encryptExact(text, key), key), text);
});

test('exact transport preserves leading/repeated BOM, NUL and Unicode boundary code points', () => {
  const text = '\uFEFF\uFEFFA\u0000B\u007F\u0080\u07FF\u0800\uD7FF\uE000\uFFFF\u{10000}\u{10FFFF}\uFEFF';
  assert.equal(decryptExact(encryptExact(text, key), key), text);
});

test('empty exact text is a valid nonempty container and decrypts to empty string', () => {
  const encrypted = encryptExact('', key);
  assert.equal(encrypted.length, EXACT_PREFIX.length + 26);
  assert.equal(encrypted, containerFor(frameFor(Buffer.alloc(0))));
  assert.equal(decryptExact(encrypted, key), '');
  assert.throws(() => decryptExact('', key), decodeError);
});

test('UTF-8 byte counter is exact for ASCII, Cyrillic, combining marks and emoji', () => {
  for (const text of ['', 'abc', 'ёЁ', 'e\u0301', '🙂', '\uFEFF', '\u0000', '👩🏽‍💻']) {
    assert.equal(utf8ByteLength(text), Buffer.byteLength(text, 'utf8'));
  }
});

test('maximum 10000 UTF-8 bytes round trip for ASCII, Cyrillic and four-byte characters', () => {
  for (const text of ['A'.repeat(10000), 'ё'.repeat(5000), '🙂'.repeat(2500), '€'.repeat(3333) + 'A']) {
    assert.equal(utf8ByteLength(text), MAX_EXACT_BYTES);
    const encrypted = encryptExact(text, key);
    assert.equal(encrypted.length, MAX_EXACT_CIPHERTEXT_LENGTH);
    assert.equal(decryptExact(encrypted, key), text);
  }
});

test('size limits reject just-over-boundary UTF-8 before encoding or Enigma', (t) => {
  t.mock.method(globalThis, 'TextEncoder', class { constructor() { throw new Error('encoder must not run'); } });
  const unreadableSettings = { get rotors() { throw new Error('Enigma must not run'); } };
  for (const text of ['A'.repeat(10001), 'ё'.repeat(5000) + 'A', '🙂'.repeat(2500) + 'A', '€'.repeat(3334)]) {
    assert.throws(() => utf8ByteLength(text), /байт UTF-8/);
    assert.throws(() => encryptExact(text, unreadableSettings), /байт UTF-8/);
  }
});

test('oversize container is rejected before Enigma, typed-array allocation or UTF-8 decode', (t) => {
  const oversized = EXACT_PREFIX + 'A'.repeat(MAX_EXACT_CIPHERTEXT_LENGTH - EXACT_PREFIX.length + 2);
  t.mock.method(globalThis, 'Uint8Array', class { constructor() { throw new Error('allocation must not run'); } });
  t.mock.method(globalThis, 'TextDecoder', class { constructor() { throw new Error('decoder must not run'); } });
  const unreadableSettings = { get rotors() { throw new Error('Enigma must not run'); } };
  assert.throws(() => decryptExact(oversized, unreadableSettings), decodeError);
});

test('lone UTF-16 surrogates are rejected instead of silently replaced', () => {
  for (const text of ['\uD800', '\uDC00', '\uD800A', 'A\uDC00', '\uD800\uD800', '\uDC00\uD800']) {
    assert.throws(() => utf8ByteLength(text), /некорректный символ Unicode/);
    assert.throws(() => encryptExact(text, key), /некорректный символ Unicode/);
  }
  assert.equal(decryptExact(encryptExact('\uFFFD', key), key), '\uFFFD');
});

test('nonstring input is rejected without coercion', () => {
  for (const value of [undefined, null, 42, [], {}, new String('abc')]) {
    assert.throws(() => utf8ByteLength(value), /текстом/);
    assert.throws(() => encryptExact(value, key), /текстом/);
    assert.throws(() => decryptExact(value, key), decodeError);
  }
});

test('each exact operation resets machine positions and leaves settings untouched', () => {
  const original = structuredClone(key);
  const first = encryptExact('Привет, Ёж! 👋', key);
  encryptExact('Другое сообщение', key);
  assert.equal(encryptExact('Привет, Ёж! 👋', key), first);
  assert.equal(decryptExact(first, key), 'Привет, Ёж! 👋');
  assert.equal(decryptExact(first, key), 'Привет, Ёж! 👋');
  assert.deepEqual(key, original);
});

test('wrong valid keys fail without returning plausible or partial plaintext', () => {
  const ciphertext = encryptExact('Сохрани Ё, регистр и пробелы!\n🙂', key);
  for (const wrongKey of [
    DEFAULT_SETTINGS, { ...key, positions: 'AAA' }, { ...key, positions: 'ZEW' },
    { ...key, rings: 'GHS' }, { ...key, plugboard: '' }, { ...key, rotors: ['I', 'II', 'IV'] },
  ]) assert.throws(() => decryptExact(ciphertext, wrongKey), decodeError);
});

test('invalid historical settings remain rejected for both exact operations', () => {
  const ciphertext = encryptExact('Тест', key);
  for (const invalid of [null, {}, { ...key, positions: '??' }, { ...key, rotors: ['I', 'I', 'II'] }, { ...key, plugboard: 'AA' }]) {
    assert.throws(() => encryptExact('Тест', invalid));
    assert.throws(() => decryptExact(ciphertext, invalid));
  }
});

test('outer version, alphabet and length are strict; no whitespace stripping or uppercasing', () => {
  const ciphertext = encryptExact('Ёж', key);
  for (const damaged of [
    ciphertext.replace('UTF8-1:', 'UTF8-2:'), ciphertext.replace('ENIGMA', 'OTHER'),
    ciphertext.toLowerCase(), ` ${ciphertext}`, `${ciphertext}\n`,
    ciphertext.slice(0, -1), ciphertext + 'A', ciphertext + 'AA',
    EXACT_PREFIX + ciphertext.slice(EXACT_PREFIX.length).toLowerCase(),
    `${ciphertext.slice(0, -2)}1A`, `${ciphertext.slice(0, -2)}АA`,
    `${ciphertext.slice(0, 20)} ${ciphertext.slice(20)}`,
    EXACT_PREFIX, EXACT_PREFIX + 'AA',
  ]) assert.throws(() => decryptExact(damaged, key), decodeError);
});

test('every single-letter substitution of a sample ciphertext is detected', () => {
  const ciphertext = encryptExact('Ёж!\n🙂', key);
  for (let index = EXACT_PREFIX.length; index < ciphertext.length; index += 1) {
    const letter = ciphertext[index] === 'A' ? 'B' : 'A';
    const damaged = ciphertext.slice(0, index) + letter + ciphertext.slice(index + 1);
    assert.throws(() => decryptExact(damaged, key), decodeError, `offset ${index}`);
  }
});

test('noncanonical base26 byte pairs are rejected instead of truncating modulo256', () => {
  const valid = pairsFor(frameFor(Buffer.from('A')));
  for (const invalidPair of ['JW', 'KA', 'ZZ']) {
    const ciphertext = EXACT_PREFIX + transform(invalidPair + valid.slice(2), key);
    assert.throws(() => decryptExact(ciphertext, key), decodeError);
  }
});

test('inner magic, inner version and declared length are checked even with valid CRC', () => {
  for (const mutate of [
    (frame) => { frame[0] ^= 1; }, (frame) => { frame[4] = 2; },
    (frame) => { frame.writeUInt32BE(0, 5); }, (frame) => { frame.writeUInt32BE(2, 5); },
    (frame) => { frame.writeUInt32BE(10001, 5); }, (frame) => { frame.writeUInt32BE(0xFFFFFFFF, 5); },
  ]) {
    const frame = frameFor(Buffer.from('A'));
    mutate(frame);
    refreshChecksum(frame);
    assert.throws(() => decryptExact(containerFor(frame), key), decodeError);
  }
});

test('CRC mismatch and missing or extra frame bytes are rejected before text decoding', () => {
  const frame = frameFor(Buffer.from('Text'));
  const damaged = Buffer.from(frame);
  damaged[damaged.length - 1] ^= 1;
  for (const bytes of [damaged, frame.subarray(0, -1), Buffer.concat([frame, Buffer.of(0)])]) {
    assert.throws(() => decryptExact(containerFor(bytes), key), decodeError);
  }
});

test('checksum-valid malformed UTF-8 fails fatally rather than producing replacement characters', () => {
  for (const bytes of [
    [0x80], [0xC3], [0xC0, 0xAF], [0xE0, 0x80, 0xAF], [0xED, 0xA0, 0x80],
    [0xF4, 0x90, 0x80, 0x80], [0xF5, 0x80, 0x80, 0x80], [0xE2, 0x28, 0xA1],
  ]) assert.throws(() => decryptExact(containerFor(frameFor(bytes)), key), decodeError);
});

test('Telegram exact share contains only encrypted container and clean public link', () => {
  const text = 'Не передавать исходный текст — Ёж 🙂';
  const ciphertext = encryptExact(text, key);
  assert.match(ciphertext, /^ENIGMA-UTF8-1:[A-Z]+$/);
  const site = 'https://nursultannurmukhamet.github.io/enigma/';
  const url = new URL(buildTelegramShareUrl(ciphertext, site));
  assert.deepEqual([...url.searchParams.keys()], ['url', 'text']);
  assert.equal(url.searchParams.get('text'), ciphertext);
  assert.equal(url.searchParams.get('url'), site);
  assert.equal(url.href.includes(encodeURIComponent(text)), false);
  for (const field of ['plugboard', 'positions', 'rings', 'rotors']) assert.equal(url.href.includes(field), false);
});

test('classic exact containers remain byte-for-byte compatible with stage1 fixtures', () => {
  assert.equal(encryptExact(''), 'ENIGMA-UTF8-1:QCEFIJAYLKKSBTMCDLHFZYUCCT');
  const text = 'Ёжик, ёлка! Mixed Case🙂\r\n';
  const fixture = 'ENIGMA-UTF8-1:QCEFIJAYLKKSBTMCLPDBYMVOZXFHRUZGNXOJLXKQNCRIRGOHNVYXEZLRVLWMMGPUWKVMCJLJFSDGCEHKJIUJRLCLZNDWFSPRPN';
  assert.equal(encryptExact(text), fixture);
  assert.equal(encryptExact(text, undefined, { machine: 'classic' }), fixture);
  assert.equal(decryptExact(fixture), text);
});

test('experimental exact prefix and limit are distinct and machine selection is explicit', () => {
  assert.equal(EXPERIMENTAL_EXACT_PREFIX, 'ENIGMA-X-UTF8-1:');
  assert.equal(MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH, 20042);
  assert.equal(getExactCiphertextLimit(), MAX_EXACT_CIPHERTEXT_LENGTH);
  assert.equal(getExactCiphertextLimit('classic'), MAX_EXACT_CIPHERTEXT_LENGTH);
  assert.equal(getExactCiphertextLimit('experimental'), MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH);
  for (const machine of ['__proto__', 'constructor', 'Classic', '', 3, null, {}]) {
    assert.throws(() => getExactCiphertextLimit(machine), /Неизвестная машина/);
    assert.throws(() => encryptExact('A', key, { machine }), /Неизвестная машина/);
    assert.throws(() => decryptExact(encryptExact('A'), key, { machine }), /Неизвестная машина/);
  }
  for (const options of [null, false, [], 'experimental', { mode: 'experimental' }]) {
    assert.throws(() => encryptExact('A', key, options), /Параметры точного текста/);
  }
});

test('experimental exact text round trips mixed Unicode with 3 and 30 rotors', () => {
  const text = '\uFEFFЁжик и ёлка! Mixed CASE e\u0301 Е\u0308 👩🏽‍💻 🙂\r\n\r\n中文\r\t  \u0000\n';
  for (const count of [3, 30]) {
    const settings = experimentalKey(count);
    const original = structuredClone(settings);
    const ciphertext = encryptExact(text, settings, experimentalOptions);
    assert.match(ciphertext, /^ENIGMA-X-UTF8-1:[A-Z]+$/);
    assert.equal(decryptExact(ciphertext, settings, experimentalOptions), text);
    assert.equal(encryptExact(text, settings, experimentalOptions), ciphertext);
    assert.deepEqual(settings, original);
  }
});

test('experimental empty text has valid own magic, checksum and 42-character envelope', () => {
  const settings = experimentalKey();
  const ciphertext = encryptExact('', settings, experimentalOptions);
  assert.equal(ciphertext.length, 42);
  assert.equal(ciphertext, experimentalContainerFor(experimentalFrameFor([]), settings));
  assert.equal(decryptExact(ciphertext, settings, experimentalOptions), '');
  assert.throws(() => encryptExact('A', undefined, experimentalOptions));
  assert.throws(() => decryptExact(ciphertext, undefined, experimentalOptions));
});

test('experimental 30-rotor exact boundary supports 10000 bytes and rejects 10001', () => {
  const settings = experimentalKey();
  for (const text of ['A'.repeat(10000), 'ё'.repeat(5000), '🙂'.repeat(2500)]) {
    const ciphertext = encryptExact(text, settings, experimentalOptions);
    assert.equal(ciphertext.length, MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH);
    assert.equal(decryptExact(ciphertext, settings, experimentalOptions), text);
    assert.throws(() => encryptExact(text + 'A', settings, experimentalOptions), /байт UTF-8/);
  }
});

test('classic and experimental containers reject cross-mode decoding before settings access', () => {
  const settings = experimentalKey();
  const classic = encryptExact('Ёж');
  const experimental = encryptExact('Ёж', settings, experimentalOptions);
  const unreadableSettings = { get rotors() { throw new Error('engine must not run'); } };
  assert.throws(() => decryptExact(classic, unreadableSettings, experimentalOptions), decodeError);
  assert.throws(() => decryptExact(experimental, unreadableSettings), decodeError);
});

test('correct outer prefix cannot hide opposite inner machine magic even with valid CRC', () => {
  const settings = experimentalKey();
  const bytes = Buffer.from('Text');
  // Both payloads have a fresh valid checksum and use the selected machine.
  // Only the opposite machine magic distinguishes them from valid containers.
  assert.throws(() => decryptExact(experimentalContainerFor(frameFor(bytes), settings), settings, experimentalOptions), decodeError);
  assert.throws(() => decryptExact(containerFor(experimentalFrameFor(bytes)), key), decodeError);
});

test('experimental wrong keys and modified ciphertext fail without partial plaintext', () => {
  const settings = experimentalKey();
  const ciphertext = encryptExact('Исходное Ё 🙂\r\n', settings, experimentalOptions);
  for (const wrong of [
    { ...settings, rotors: settings.rotors.slice(0, 3) },
    { ...settings, plugboard: '' },
    { ...settings, rotors: settings.rotors.map((rotor, index) => index === 29 ? { ...rotor, position: 'A' } : rotor) },
  ]) assert.throws(() => decryptExact(ciphertext, wrong, experimentalOptions), decodeError);
  for (let index = EXPERIMENTAL_EXACT_PREFIX.length; index < ciphertext.length; index += 1) {
    const damaged = ciphertext.slice(0, index) + (ciphertext[index] === 'A' ? 'B' : 'A') + ciphertext.slice(index + 1);
    assert.throws(() => decryptExact(damaged, settings, experimentalOptions), decodeError);
  }
});

test('experimental oversized input rejects before byte allocation or selected engine', (t) => {
  const oversized = EXPERIMENTAL_EXACT_PREFIX + 'A'.repeat(20028);
  t.mock.method(globalThis, 'Uint8Array', class { constructor() { throw new Error('allocation must not run'); } });
  t.mock.method(globalThis, 'TextDecoder', class { constructor() { throw new Error('decoder must not run'); } });
  const unreadableSettings = { get rotors() { throw new Error('engine must not run'); } };
  assert.throws(() => decryptExact(oversized, unreadableSettings, experimentalOptions), decodeError);
});

test('experimental valid checksum does not allow bad UTF-8 or false lengths', () => {
  const settings = experimentalKey();
  const invalidUtf8 = experimentalFrameFor([0xED, 0xA0, 0x80]);
  assert.throws(() => decryptExact(experimentalContainerFor(invalidUtf8, settings), settings, experimentalOptions), decodeError);
  const falseLength = experimentalFrameFor([65]);
  falseLength.writeUInt32BE(0xFFFFFFFF, 5);
  refreshChecksum(falseLength);
  assert.throws(() => decryptExact(experimentalContainerFor(falseLength, settings), settings, experimentalOptions), decodeError);
});

test('experimental Telegram share includes only encrypted container and public site', () => {
  const text = 'Исходный русский текст Ё🙂';
  const ciphertext = encryptExact(text, experimentalKey(), experimentalOptions);
  const site = 'https://nursultannurmukhamet.github.io/enigma/';
  const url = new URL(buildTelegramShareUrl(ciphertext, site));
  assert.deepEqual([...url.searchParams.keys()], ['url', 'text']);
  assert.equal(url.searchParams.get('text'), ciphertext);
  assert.equal(url.searchParams.get('url'), site);
  assert.equal(url.href.includes(encodeURIComponent(text)), false);
  for (const field of ['wiring', 'position', 'ring', 'rotors', 'plugboard']) assert.equal(url.href.includes(field), false);
});
