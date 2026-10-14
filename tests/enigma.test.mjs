import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABET, DEFAULT_SETTINGS, ROTOR_NAMES, RUSSIAN_TRANSLITERATION,
  validateSettings, normalizeMessage, transform, stepPositions,
  randomSettings, serializeSettings, parseSettings, buildTelegramShareUrl,
} from '../enigma.js';

const settings = (overrides = {}) => ({ ...DEFAULT_SETTINGS, rotors: [...DEFAULT_SETTINGS.rotors], ...overrides });

test('known vector: AAAAA → BDZGO; I II III / AAA / AAA / B / no plugs', () => {
  assert.equal(transform('AAAAA'), 'BDZGO');
  assert.equal(transform('BDZGO'), 'AAAAA');
});

test('known vector: HELLOWORLD → ILBDAAMTAZ', () => {
  assert.equal(transform('HELLOWORLD'), 'ILBDAAMTAZ');
  assert.equal(transform('ILBDAAMTAZ'), 'HELLOWORLD');
});

test('published Py-Enigma vector: non-AAA rings and ten plugboard pairs', () => {
  // Independent published expectations, not generated from this implementation:
  // https://py-enigma.readthedocs.io/en/latest/guide.html#example-communication-procedure
  // B U L are ring settings 02 21 12, in left-to-right rotor order.
  const key = settings({
    rotors: ['II', 'IV', 'V'],
    rings: 'BUL',
    positions: 'WXC',
    plugboard: 'AV BS CG DL FU HZ IN KM OW RX',
  });
  assert.equal(transform('BLA', key), 'KCH');
  assert.equal(transform('KCH', key), 'BLA');
  assert.equal(transform('THEXRUSSIANSXAREXCOMINGX', { ...key, positions: 'BLA' }), 'NIBLFMYMLLUFWCASCSSNVHAZ');
  assert.equal(transform('NIBLFMYMLLUFWCASCSSNVHAZ', { ...key, positions: 'BLA' }), 'THEXRUSSIANSXAREXCOMINGX');
});

test('double-step: ADU → ADV → AEW → BFX → BFY', () => {
  const key = settings({ positions: 'ADU' });
  const positions = [key.positions];
  for (let index = 0; index < 4; index += 1) positions.push(stepPositions(key, positions.at(-1)));
  assert.deepEqual(positions, ['ADU', 'ADV', 'AEW', 'BFX', 'BFY']);
});

test('published Crypto Museum double-step sequence for III II I', () => {
  // https://www.cryptomuseum.com/crypto/enigma/working.htm#double
  const key = settings({ rotors: ['III', 'II', 'I'], positions: 'ADO' });
  const positions = [key.positions];
  for (let index = 0; index < 6; index += 1) positions.push(stepPositions(key, positions.at(-1)));
  assert.deepEqual(positions, ['ADO', 'ADP', 'ADQ', 'AER', 'BFS', 'BFT', 'BFU']);
});

test('notches stay with window letters when ring settings change', () => {
  for (const rings of ['AAA', 'BCD', 'ZZZ']) {
    assert.equal(stepPositions(settings({ rings, positions: 'ADV' })), 'AEW');
    assert.equal(stepPositions(settings({ rings, positions: 'AEW' })), 'BFX');
  }
});

test('turnover letters for every supported right-hand rotor', () => {
  for (const [rotor, notch, next] of [['I', 'Q', 'R'], ['II', 'E', 'F'], ['III', 'V', 'W'], ['IV', 'J', 'K'], ['V', 'Z', 'A']]) {
    const others = ROTOR_NAMES.filter((name) => name !== rotor);
    const key = settings({ rotors: [others[0], others[1], rotor], positions: `AA${notch}` });
    assert.equal(stepPositions(key), `AB${next}`);
  }
});

test('both notches engage together: middle rotor advances once, not twice', () => {
  assert.equal(stepPositions(settings({ positions: 'AEV' })), 'BFW');
});

test('ring offset affects electrical wiring: shifted starts and rings agree before turnover', () => {
  assert.equal(transform('AAAAA', settings({ rings: 'BBB', positions: 'BBB' })), 'BDZGO');
  assert.notEqual(transform('HELLOWORLD', settings({ rings: 'BCD' })), 'ILBDAAMTAZ');
});

test('round trip for all 60 distinct rotor orders, with rings/plugs and turnover crossings', () => {
  const source = `${ALPHABET.repeat(5)} 2026, ENIGMA!\n${ALPHABET.repeat(25)}`;
  let cases = 0;
  for (const left of ROTOR_NAMES) {
    for (const middle of ROTOR_NAMES.filter((rotor) => rotor !== left)) {
      for (const right of ROTOR_NAMES.filter((rotor) => rotor !== left && rotor !== middle)) {
        const key = settings({ rotors: [left, middle, right], rings: 'BDF', positions: 'QEZ', plugboard: 'AV BS CG DL FU HZ IN KM OW RX' });
        const ciphertext = transform(source, key);
        assert.equal(transform(ciphertext, key), source);
        assert.notEqual(ciphertext, source);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 60);
});

test('every invocation resets to initial positions and does not mutate settings', () => {
  const key = settings({ positions: 'ADU', rings: 'GHT', plugboard: 'AT BS' });
  const before = structuredClone(key);
  const first = transform('HELLO', key);
  assert.equal(transform('HELLO', key), first);
  assert.equal(transform('HELLOWORLD', key).slice(0, 5), first);
  assert.deepEqual(key, before);
});

test('punctuation, whitespace, numbers and symbols are preserved without a rotor step', () => {
  assert.equal(transform('a a-a\nA1a!🙂'), 'B D-Z\nG1O!🙂');
  assert.equal(transform(' \n\t123.,!?—🙂'), ' \n\t123.,!?—🙂');
  assert.equal(transform(''), '');
});

test('normalization accepts ASCII lowercase and rejects unsupported alphabets', () => {
  assert.equal(normalizeMessage('Hello, World! 2026'), 'HELLO, WORLD! 2026');
  for (const text of ['é', 'e\u0301', 'Σ', '漢', 'ı', 'ß', 'ſ', 'І', 'Ї']) {
    assert.throws(() => normalizeMessage(text), /не поддерживается/);
    assert.throws(() => normalizeMessage(text, { transliterateRussian: true }), /не поддерживается/);
  }
  assert.throws(() => normalizeMessage(42), /текстом/);
  assert.throws(() => normalizeMessage('A', { transliterateRussian: 'true' }), /явно/);
});

test('Russian transliteration is explicit and its result, not Cyrillic spelling, round trips', () => {
  const source = 'Привет, ёж! Щука, съешь ещё этих мягких булок.';
  assert.throws(() => transform(source), /включите транслитерацию/);
  const normalized = 'PRIVET, YOZH! SHCHUKA, SESH ESHCHYO ETIKH MYAGKIKH BULOK.';
  assert.equal(normalizeMessage(source, { transliterateRussian: true }), normalized);
  assert.equal(transform(transform(source, DEFAULT_SETTINGS, { transliterateRussian: true })), normalized);
  assert.equal(Object.keys(RUSSIAN_TRANSLITERATION).length, 33);
  assert.equal(normalizeMessage('Ъь', { transliterateRussian: true }), '');
});

test('Unicode boundary: reject unsupported letters and combining marks; preserve ZWJ symbols', () => {
  for (const text of ['\u212A', '\uFB00', '\uFF21', '\u{1D400}', '\u0435\u0308']) {
    assert.throws(() => normalizeMessage(text, { transliterateRussian: true }), /не поддерживается/);
  }
  assert.equal(normalizeMessage('\u0451', { transliterateRussian: true }), 'YO');
  const symbols = '\u{1F469}\u200D\u{1F4BB}\u00A0—';
  assert.equal(transform(`A${symbols}A`), `B${symbols}D`);
});

test('emoji text/presentation selectors are preserved without advancing rotors', () => {
  const symbols = '\u2764\uFE0F \u2764\uFE0E \u{1F469}\u200D\u{1F4BB}';
  assert.equal(normalizeMessage(symbols), symbols);
  assert.equal(transform(`A${symbols}A`), `B${symbols}D`);
  const cipher = transform(`A${symbols}A`);
  const url = new URL(buildTelegramShareUrl(cipher, 'https://example.com/'));
  assert.equal(url.searchParams.get('text'), cipher);
});

test('malformed UTF-16 is rejected before transformation or Telegram URL coercion', () => {
  for (const text of ['\uD800', '\uDC00', 'A\uD800B', 'A\uDC00B', '\uD800\uD800']) {
    assert.throws(() => normalizeMessage(text), /повреждённый символ Unicode/);
    assert.throws(() => transform(text), /повреждённый символ Unicode/);
    assert.throws(() => buildTelegramShareUrl(text, 'https://example.com/'), /повреждённый символ Unicode/);
  }
  assert.equal(transform('A\uD83D\uDE42A'), 'B\uD83D\uDE42D');
});

test('reject invalid rotor selections, rings, positions, reflector and plugboard', () => {
  const invalid = [
    { rotors: ['I', 'I', 'III'] }, { rotors: ['I', 'II', 'VI'] }, { rotors: ['I', 'II'] },
    { rotors: 'I II III' }, { rotors: ['I', 'II', 'toString'] },
    { rings: 'AA' }, { rings: 'AAAA' }, { rings: 'A1A' }, { rings: 'АAA' }, { rings: [1, 1, 1] },
    { positions: ' AA' }, { positions: null }, { positions: 'AAİ' },
    { reflector: 'C' }, { reflector: null },
    { plugboard: 'AA' }, { plugboard: 'AB AC' }, { plugboard: 'AB BA' },
    { plugboard: 'ABC' }, { plugboard: 'AB,CD' }, { plugboard: 'AБ' }, { plugboard: 'ſA' },
    { plugboard: 'AB CD EF GH IJ KL MN OP QR ST UV' }, { plugboard: null },
  ];
  for (const overrides of invalid) {
    assert.throws(() => validateSettings(settings(overrides)), Error, JSON.stringify(overrides));
    assert.throws(() => transform('A', settings(overrides)), Error);
  }
  for (const invalidObject of [null, [], 0, 'AAA', {}]) assert.throws(() => validateSettings(invalidObject));
});

test('valid settings canonicalize lowercase fields and plug whitespace in a fresh object', () => {
  const original = settings({ rings: 'bcd', positions: 'xyz', plugboard: '  ab\ncd\tEF ' });
  const canonical = validateSettings(original);
  assert.equal(canonical.rings, 'BCD');
  assert.equal(canonical.positions, 'XYZ');
  assert.equal(canonical.plugboard, 'AB CD EF');
  canonical.rotors[0] = 'V';
  assert.equal(original.rotors[0], 'I');
  assert.equal(validateSettings(settings({ plugboard: 'AB CD EF GH IJ KL MN OP QR ST' })).plugboard.split(' ').length, 10);
});

test('random settings are valid, have ten disjoint pairs and can round trip', () => {
  for (let index = 0; index < 30; index += 1) {
    const key = randomSettings();
    assert.deepEqual(validateSettings(key), key);
    assert.equal(key.plugboard.split(' ').length, 10);
    assert.equal(new Set(key.plugboard.replaceAll(' ', '')).size, 20);
    assert.equal(transform(transform('CHECK THE RANDOM KEY', key), key), 'CHECK THE RANDOM KEY');
  }
});

test('export/import round trip includes settings only, never source or ciphertext', () => {
  const key = settings({ rotors: ['V', 'III', 'I'], rings: 'XYZ', positions: 'MNO', plugboard: 'AB CD' });
  const exported = serializeSettings({ ...key, source: 'SECRET SOURCE', ciphertext: 'SECRET OUTPUT' });
  assert.deepEqual(parseSettings(exported), key);
  assert.deepEqual(Object.keys(JSON.parse(exported)), ['format', 'version', 'settings']);
  assert.equal(exported.includes('SECRET'), false);
  assert.equal(exported.includes('ciphertext'), false);
  assert.equal(exported.includes('source'), false);
});

test('invalid JSON, config versions and malformed imported settings are rejected', () => {
  const valid = JSON.parse(serializeSettings(DEFAULT_SETTINGS));
  for (const input of ['', '{', 'null', '[]', '{}', JSON.stringify(DEFAULT_SETTINGS), ' '.repeat(16385)]) {
    assert.throws(() => parseSettings(input));
  }
  for (const bad of [
    { ...valid, version: 2 }, { ...valid, format: 'other' }, { ...valid, source: 'DO NOT IMPORT' },
    { ...valid, settings: null }, { ...valid, settings: { ...valid.settings, positions: '???' } },
    { ...valid, settings: { ...valid.settings, message: 'DO NOT IMPORT' } },
    { ...valid, settings: { ...valid.settings, plugboard: 'AA' } },
  ]) assert.throws(() => parseSettings(JSON.stringify(bad)));
});

test('Telegram URL has only the computed ciphertext and clean public site URL', () => {
  const original = 'HELLO WORLD!';
  const cipher = transform(original);
  const site = 'https://nursultannurmukhamet.github.io/enigma/';
  const url = new URL(buildTelegramShareUrl(cipher, site));
  assert.equal(url.origin, 'https://t.me');
  assert.equal(url.pathname, '/share/url');
  assert.deepEqual([...url.searchParams.keys()], ['url', 'text']);
  assert.equal(url.searchParams.get('url'), site);
  assert.equal(url.searchParams.get('text'), cipher);
  assert.equal(url.href.includes('HELLO'), false);
  assert.equal(url.href.includes('plugboard'), false);
  assert.equal(url.href.includes('positions'), false);
  const escaped = new URL(buildTelegramShareUrl('ABC & + ? #\nDEF', site));
  assert.equal(escaped.searchParams.get('text'), 'ABC & + ? #\nDEF');
});

test('Telegram rejects empty output and URLs which might include key material', () => {
  assert.throws(() => buildTelegramShareUrl('', 'https://example.com/'));
  assert.throws(() => buildTelegramShareUrl(' \n', 'https://example.com/'));
  for (const site of ['http://example.com/', 'javascript:alert(1)', '/enigma/', 'https://example.com/?key=AAA', 'https://example.com/#text=SECRET', 'https://user:password@example.com/']) {
    assert.throws(() => buildTelegramShareUrl('ABCDE', site));
  }
});
