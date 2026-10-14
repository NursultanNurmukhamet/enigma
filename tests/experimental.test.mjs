import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ALPHABET, normalizeMessage } from '../enigma.js';
import {
  MIN_EXPERIMENTAL_ROTORS, MAX_EXPERIMENTAL_ROTORS, MAX_EXPERIMENTAL_KEY_BYTES,
  MAX_EXPERIMENTAL_MESSAGE_LENGTH, EXPERIMENTAL_STEPPING,
  validateExperimentalSettings, stepExperimentalPositions, transformExperimental,
  randomExperimentalSettings, serializeExperimentalSettings, parseExperimentalSettings,
} from '../experimental.js';

function key(count = 3) {
  const bases = ['EKMFLGDQVZNTOWYHXUSPAIBRCJ', 'AJDKSIRUXBLHWTMCQGZNPYFVOE'];
  return {
    rotors: Array.from({ length: count }, (_, index) => {
      const wiring = [...bases[Math.floor(index / 25) % 2]];
      const other = index % 25 + 1;
      [wiring[0], wiring[other]] = [wiring[other], wiring[0]];
      return { wiring: wiring.join(''), ring: ALPHABET[(index * 3 + 5) % 26], position: ALPHABET[(index * 7 + 25) % 26] };
    }),
    reflector: 'B', stepping: EXPERIMENTAL_STEPPING, plugboard: 'AV BS CG DL FU HZ IN KM OW RX',
  };
}

test('3, 8 and 30 rotors round trip across turnover with rings and plugboard', () => {
  const source = `${ALPHABET.repeat(40)} 2026, EXPERIMENT!\n${ALPHABET.repeat(30)}`;
  for (const count of [3, 8, 30]) {
    const settings = key(count);
    const cipher = transformExperimental(source, settings);
    assert.equal(transformExperimental(cipher, settings), source, `${count} rotors`);
    assert.notEqual(cipher, source);
    assert.equal(cipher.length, source.length);
  }
});

test('explicit odometer step: advance rightmost before letter, carry on Z only', () => {
  const settings = key(3);
  assert.equal(stepExperimentalPositions(settings, 'AAZ'), 'ABA');
  assert.equal(stepExperimentalPositions(settings, 'AZZ'), 'BAA');
  assert.equal(stepExperimentalPositions(settings, 'ZZZ'), 'AAA');
  assert.equal(stepExperimentalPositions(settings, 'ADV'), 'ADW');
  assert.equal(stepExperimentalPositions(settings, 'AEW'), 'AEX');
  assert.equal(stepExperimentalPositions(key(30), 'Z'.repeat(30)), 'A'.repeat(30));
  assert.equal(stepExperimentalPositions(key(30), 'A' + 'Z'.repeat(29)), 'B' + 'A'.repeat(29));
});

test('ring settings do not change carry points; invalid windows are rejected', () => {
  const settings = key(8);
  const before = structuredClone(settings);
  const expected = stepExperimentalPositions(settings, 'AAAAAZZZ');
  settings.rotors.forEach((rotor) => { rotor.ring = 'Z'; });
  assert.equal(stepExperimentalPositions(settings, 'AAAAAZZZ'), expected);
  assert.equal(expected, 'AAAABAAA');
  assert.equal(stepExperimentalPositions(settings, 'aaaaazzz'), expected);
  assert.equal(stepExperimentalPositions(before), stepExperimentalPositions(before, before.rotors.map((rotor) => rotor.position).join('')));
  for (const windows of ['', 'AAA', 'A'.repeat(9), 'AAAAAAA1', 'АAAAAAAA', ['A']]) {
    assert.throws(() => stepExperimentalPositions(settings, windows));
  }
});

test('fixed manual conjugation vector verifies forward and inverse wiring', () => {
  const swap = (a, b) => [...ALPHABET].map((letter) => letter === a ? b : letter === b ? a : letter).join('');
  const settings = { rotors: ['AB', 'CD', 'EF'].map(([a, b]) => ({ wiring: swap(a, b), ring: 'A', position: 'Z' })),
    reflector: 'B', stepping: EXPERIMENTAL_STEPPING, plugboard: '' };
  // Each one-letter call first wraps ZZZ -> AAA. Disjoint swaps AB/CD/EF
  // conjugate B's literal pairs AY BR CU DH EQ FS GL IP JX KN MO TZ VW.
  const expectedPairs = ['BY', 'AR', 'DU', 'CH', 'FQ', 'ES', 'GL', 'IP', 'JX', 'KN', 'MO', 'TZ', 'VW'];
  for (const [a, b] of expectedPairs) {
    assert.equal(transformExperimental(a, settings), b);
    assert.equal(transformExperimental(b, settings), a);
  }
});

test('non-involutory rotor permutations still use their true inverse return path', () => {
  const settings = key(30);
  // Fixture wiring is not self-inverse; a second forward pass would fail this.
  assert.notEqual(settings.rotors[0].wiring[settings.rotors[0].wiring.charCodeAt(0) - 65], 'A');
  for (const character of ALPHABET) {
    const cipher = transformExperimental(character, settings);
    assert.equal(transformExperimental(cipher, settings), character);
    assert.notEqual(cipher, character);
  }
});

test('each invocation resets initial positions and preserves immutable canonical keys', () => {
  const settings = key(30);
  const before = structuredClone(settings);
  const first = transformExperimental('HELLO', settings);
  assert.equal(transformExperimental('HELLO', settings), first);
  assert.equal(transformExperimental('HELLOWORLD', settings).slice(0, 5), first);
  assert.deepEqual(settings, before);
  const canonical = validateExperimentalSettings(settings);
  assert.ok(Object.isFrozen(canonical));
  assert.ok(Object.isFrozen(canonical.rotors));
  assert.ok(canonical.rotors.every(Object.isFrozen));
  assert.throws(() => { canonical.rotors[0].ring = 'Z'; }, TypeError);
  settings.rotors[0].ring = 'Z';
  assert.notEqual(canonical.rotors[0].ring, 'Z');
});

test('single ring and position offsets affect wiring and simultaneous shifts agree before carry', () => {
  const a = key(3);
  const b = key(3);
  a.rotors.forEach((rotor) => { rotor.ring = 'A'; rotor.position = 'A'; });
  b.rotors.forEach((rotor) => { rotor.ring = 'B'; rotor.position = 'B'; });
  assert.equal(transformExperimental('AAAAA', a), transformExperimental('AAAAA', b));
  b.rotors[1].ring = 'C';
  assert.notEqual(transformExperimental('AAAAA', a), transformExperimental('AAAAA', b));
});

test('punctuation and emoji remain in place without steps; empty text is valid', () => {
  const settings = key(8);
  const plain = 'AAAAA';
  const cipher = transformExperimental(plain, settings);
  assert.equal(transformExperimental('a a-a\nA1a!🙂', settings), `${cipher[0]} ${cipher[1]}-${cipher[2]}\n${cipher[3]}1${cipher[4]}!🙂`);
  assert.equal(transformExperimental('', settings), '');
  assert.equal(transformExperimental(' \r\n\t123.,!?-👩‍💻', settings), ' \r\n\t123.,!?-👩‍💻');
});

test('legacy Russian transliteration remains opt-in and preserves old normalization behavior', () => {
  const source = 'Привет, Ёж! Щука и съешь ещё.';
  const settings = key(30);
  assert.throws(() => transformExperimental(source, settings));
  const cipher = transformExperimental(source, settings, { transliterateRussian: true });
  assert.equal(transformExperimental(cipher, settings), normalizeMessage(source, { transliterateRussian: true }));
  for (const input of ['\uD800', 'e\u0301', 'é', 'Σ']) {
    assert.throws(() => transformExperimental(input, settings, { transliterateRussian: true }));
  }
});

test('bound message length before work and again after transliteration expansion', () => {
  const settings = key(3);
  const longest = 'A'.repeat(MAX_EXPERIMENTAL_MESSAGE_LENGTH);
  assert.equal(transformExperimental(longest, settings).length, MAX_EXPERIMENTAL_MESSAGE_LENGTH);
  assert.throws(() => transformExperimental(longest + 'A', settings));
  assert.throws(() => transformExperimental('Щ'.repeat(5007), settings, { transliterateRussian: true }));
  assert.throws(() => transformExperimental(123, settings));
});

test('canonicalizes lowercase wiring, rings, starts and plug whitespace', () => {
  const settings = key(3);
  settings.rotors.forEach((rotor) => {
    rotor.wiring = rotor.wiring.toLowerCase(); rotor.ring = 'b'; rotor.position = 'c';
  });
  settings.plugboard = '  ab\ncd\tEF ';
  const canonical = validateExperimentalSettings(settings);
  assert.equal(canonical.plugboard, 'AB CD EF');
  assert.ok(canonical.rotors.every((rotor) => /^[A-Z]{26}$/.test(rotor.wiring) && rotor.ring === 'B' && rotor.position === 'C'));
  assert.equal(settings.rotors[0].ring, 'b');
});

test('random browser-crypto keys have distinct permutations, rings, starts and disjoint plugs', () => {
  for (const count of [3, 8, 30, 30]) {
    const settings = randomExperimentalSettings(count);
    assert.equal(settings.rotors.length, count);
    assert.equal(new Set(settings.rotors.map((rotor) => rotor.wiring)).size, count);
    assert.ok(settings.rotors.every((rotor) => new Set(rotor.wiring).size === 26));
    assert.equal(settings.plugboard.split(' ').length, 10);
    assert.equal(new Set(settings.plugboard.replaceAll(' ', '')).size, 20);
    assert.deepEqual(validateExperimentalSettings(settings), settings);
    assert.equal(transformExperimental(transformExperimental('RANDOM KEY CHECK', settings), settings), 'RANDOM KEY CHECK');
  }
  assert.equal(randomExperimentalSettings().rotors.length, 30);
});

test('reject count outside 3–30 and excessive or sparse arrays before inspecting their elements', () => {
  assert.equal(MIN_EXPERIMENTAL_ROTORS, 3);
  assert.equal(MAX_EXPERIMENTAL_ROTORS, 30);
  for (const count of [0, 1, 2, 31, 100000, -1, 3.5, '3', NaN, Infinity, null]) {
    assert.throws(() => randomExperimentalSettings(count));
  }
  for (const rotors of [[], key(2).rotors, Array(31), Array(100000), Array(3), 'ABC']) {
    assert.throws(() => validateExperimentalSettings({ ...key(3), rotors }));
  }
  const customArray = key(3).rotors;
  customArray.message = 'DO NOT ACCEPT';
  assert.throws(() => validateExperimentalSettings({ ...key(3), rotors: customArray }));
});

test('reject non-bijections, duplicate wirings, invalid rings and unrecognized rotor fields', () => {
  const badRotorFields = [
    { wiring: 'A'.repeat(26) }, { wiring: ALPHABET.slice(1) }, { wiring: ALPHABET + 'A' },
    { wiring: 'А' + ALPHABET.slice(1) }, { wiring: ALPHABET.split('') },
    { ring: '' }, { ring: 'AA' }, { ring: '1' }, { ring: null }, { ring: 'é' },
    { position: '' }, { position: 'AB' }, { position: 1 }, { position: '🙂' },
    { notch: 'Q' }, { rings: 'AA' }, { extraOffset: 'A' },
  ];
  for (const changes of badRotorFields) {
    const settings = key(3);
    settings.rotors[0] = { ...settings.rotors[0], ...changes };
    assert.throws(() => validateExperimentalSettings(settings), Error, JSON.stringify(changes));
  }
  const duplicate = key(3);
  duplicate.rotors[1].wiring = duplicate.rotors[0].wiring;
  assert.throws(() => validateExperimentalSettings(duplicate));
});

test('reject bad plugboards, reflector, stepping, missing and unknown key fields', () => {
  for (const plugboard of ['AA', 'AB AC', 'AB BA', 'ABC', 'AB,CD', 'АB', 'AB CD EF GH IJ KL MN OP QR ST UV', ' '.repeat(129), null]) {
    assert.throws(() => validateExperimentalSettings({ ...key(3), plugboard }));
  }
  for (const changes of [{ reflector: 'C' }, { stepping: 'historical' }, { stepping: 1 },
    { message: 'SECRET' }, { rotors: null }, { initialPositions: 'AAA' }]) {
    assert.throws(() => validateExperimentalSettings({ ...key(3), ...changes }));
  }
  for (const invalid of [null, undefined, [], 0, 'AAA', {}]) assert.throws(() => validateExperimentalSettings(invalid));
  const missing = key(3);
  delete missing.plugboard;
  assert.throws(() => validateExperimentalSettings(missing));
  const accessor = key(3);
  Object.defineProperty(accessor, 'plugboard', { get: () => { throw new Error('Must not execute'); } });
  assert.throws(() => validateExperimentalSettings(accessor), /неизвестное или отсутствующее поле/);
});

test('versioned full key exports and imports reproduce cipher exactly, without messages', () => {
  for (const count of [3, 8, 30]) {
    const settings = key(count);
    const exported = serializeExperimentalSettings(settings);
    const container = JSON.parse(exported);
    assert.deepEqual(Object.keys(container), ['format', 'version', 'settings']);
    assert.equal(container.format, 'enigma-experimental');
    assert.equal(container.version, 1);
    assert.equal(container.settings.rotors.length, count);
    assert.ok(Buffer.byteLength(exported, 'utf8') <= MAX_EXPERIMENTAL_KEY_BYTES);
    const imported = parseExperimentalSettings(exported);
    assert.deepEqual(imported, settings);
    assert.equal(transformExperimental('SAME CIPHER AFTER IMPORT', imported), transformExperimental('SAME CIPHER AFTER IMPORT', settings));
    assert.equal(exported.includes('plaintext'), false);
    assert.equal(exported.includes('ciphertext'), false);
  }
  assert.throws(() => serializeExperimentalSettings({ ...key(3), source: 'SECRET' }));
});

test('reject corrupt imports, unsupported versions, foreign/classic formats and excessive UTF-8 bytes', () => {
  const valid = JSON.parse(serializeExperimentalSettings(key(3)));
  for (const input of ['', '{', 'null', '[]', '{}', JSON.stringify(key(3)), ' '.repeat(MAX_EXPERIMENTAL_KEY_BYTES + 1),
    JSON.stringify({ padding: '🙂'.repeat(5000) })]) {
    assert.throws(() => parseExperimentalSettings(input));
  }
  for (const changes of [{ version: 2 }, { version: '1' }, { format: 'enigma-i' }, { format: 'other' },
    { message: 'SECRET' }, { settings: null }, { settings: { ...key(3), rotors: Array(31) } }]) {
    assert.throws(() => parseExperimentalSettings(JSON.stringify({ ...valid, ...changes })));
  }
});

test('30-rotor maximum payload performance and full round trip', (t) => {
  const settings = key(30);
  const source = ALPHABET.repeat(Math.ceil(MAX_EXPERIMENTAL_MESSAGE_LENGTH / 26)).slice(0, MAX_EXPERIMENTAL_MESSAGE_LENGTH);
  const start = performance.now();
  const cipher = transformExperimental(source, settings);
  const encrypted = performance.now();
  const result = transformExperimental(cipher, settings);
  const decrypted = performance.now();
  assert.equal(result, source);
  t.diagnostic(`30 rotors, ${source.length} letters: encrypt ${(encrypted - start).toFixed(1)} ms, decrypt ${(decrypted - encrypted).toFixed(1)} ms in local Node; browser worker/UI responsiveness checked separately.`);
});
