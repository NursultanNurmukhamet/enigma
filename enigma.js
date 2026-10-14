/**
 * Enigma I: three distinct rotors I–V, wide reflector B, identity entry wheel.
 * Rotor order is always left (slow) to right (fast); A represents ring 01.
 * Wiring and turnover references:
 * https://www.cryptomuseum.com/crypto/enigma/wiring.htm
 * https://www.cryptomuseum.com/crypto/enigma/working.htm
 * This historical cipher is for learning and games, not for real secrets.
 */

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const ROTOR_NAMES = Object.freeze(['I', 'II', 'III', 'IV', 'V']);
export const DEFAULT_SETTINGS = Object.freeze({
  rotors: Object.freeze(['I', 'II', 'III']),
  rings: 'AAA',
  positions: 'AAA',
  plugboard: '',
  reflector: 'B',
});

const ROTORS = {
  I: { wiring: 'EKMFLGDQVZNTOWYHXUSPAIBRCJ', notch: 'Q' },
  II: { wiring: 'AJDKSIRUXBLHWTMCQGZNPYFVOE', notch: 'E' },
  III: { wiring: 'BDFHJLCPRTXVZNYEIWGAKMUSQO', notch: 'V' },
  IV: { wiring: 'ESOVPZJAYQUIRHXLNFTGKDCMWB', notch: 'J' },
  V: { wiring: 'VZBRGITYUPSDNHLXAWMJQOFECK', notch: 'Z' },
};
const REFLECTOR_B = [...'YRUHQSLDPXNGOKMIEBFZCWVJAT'].map(toIndex);
const CONFIG_FORMAT = 'enigma-i';
const CONFIG_VERSION = 1;

// A deliberately simple, lossy transliteration. No reverse transliteration.
export const RUSSIAN_TRANSLITERATION = Object.freeze({
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'YO', Ж: 'ZH',
  З: 'Z', И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O',
  П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'KH', Ц: 'TS',
  Ч: 'CH', Ш: 'SH', Щ: 'SHCH', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'YU', Я: 'YA',
});

function toIndex(letter) {
  return letter.charCodeAt(0) - 65;
}

function mod26(value) {
  return (value % 26 + 26) % 26;
}

function requireWellFormedText(text) {
  // With the u flag this matches isolated UTF-16 code units, not valid pairs.
  // URLSearchParams silently replaces isolated surrogates with U+FFFD.
  if (/[\uD800-\uDFFF]/u.test(text)) {
    throw new Error('Текст содержит повреждённый символ Unicode. Удалите его и введите текст заново.');
  }
}

function threeLetters(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    throw new Error(`${label}: нужны ровно три латинские буквы A–Z.`);
  }
  return value.toUpperCase();
}

function validatePlugboard(value) {
  if (typeof value !== 'string') {
    throw new Error('Коммутационная панель: укажите пары букв, например AB CD.');
  }
  const pairs = value.trim() === '' ? [] : value.trim().split(/\s+/);
  if (pairs.length > 10) {
    throw new Error('Коммутационная панель: допустимо не более 10 пар.');
  }
  const used = new Set();
  return pairs.map((pair) => {
    if (!/^[A-Za-z]{2}$/.test(pair)) {
      throw new Error('Каждая пара должна содержать две буквы A–Z; разделяйте пары пробелами.');
    }
    const canonical = pair.toUpperCase();
    if (canonical[0] === canonical[1]) {
      throw new Error(`Пара ${canonical}: букву нельзя соединить с самой собой.`);
    }
    for (const letter of canonical) {
      if (used.has(letter)) {
        throw new Error(`Буква ${letter} встречается в коммутационной панели повторно.`);
      }
      used.add(letter);
    }
    return canonical;
  }).join(' ');
}

/** Return a new canonical settings object; invalid settings throw a Russian error. */
export function validateSettings(settings = DEFAULT_SETTINGS) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Настройки должны быть объектом.');
  }
  if (!Array.isArray(settings.rotors) || settings.rotors.length !== 3 ||
      settings.rotors.some((name) => !ROTOR_NAMES.includes(name))) {
    throw new Error('Выберите три ротора из I, II, III, IV, V, слева направо.');
  }
  if (new Set(settings.rotors).size !== 3) {
    throw new Error('Все три ротора должны быть разными.');
  }
  if (settings.reflector !== 'B') {
    throw new Error('Поддерживается только отражатель B.');
  }
  return {
    rotors: [...settings.rotors],
    rings: threeLetters(settings.rings, 'Кольца'),
    positions: threeLetters(settings.positions, 'Начальные позиции'),
    plugboard: validatePlugboard(settings.plugboard),
    reflector: 'B',
  };
}

/**
 * Uppercase ASCII letters. Russian needs explicit opt-in, and is lossy.
 * Whitespace, punctuation, digits and symbols are preserved; other letters and
 * combining marks are rejected, except emoji presentation selectors FE0E/FE0F.
 * Malformed UTF-16 is rejected instead of being changed by a sharing URL.
 */
export function normalizeMessage(message, { transliterateRussian = false } = {}) {
  if (typeof message !== 'string') {
    throw new Error('Сообщение должно быть текстом.');
  }
  requireWellFormedText(message);
  if (typeof transliterateRussian !== 'boolean') {
    throw new Error('Транслитерация должна быть явно включена или выключена.');
  }
  let result = '';
  for (const character of message) {
    if (/^[A-Za-z]$/.test(character)) {
      result += character.toUpperCase();
      continue;
    }
    const upper = character.toUpperCase();
    if (Object.hasOwn(RUSSIAN_TRANSLITERATION, upper)) {
      if (!transliterateRussian) {
        throw new Error('Для русского текста включите транслитерацию. Исходное написание не восстановится.');
      }
      result += RUSSIAN_TRANSLITERATION[upper];
      continue;
    }
    if (character !== '\uFE0E' && character !== '\uFE0F' && /[\p{L}\p{M}]/u.test(character)) {
      throw new Error(`Буква «${character}» не поддерживается. Используйте A–Z или русский транслит.`);
    }
    result += character;
  }
  return result;
}

function advance(rotors, positions) {
  // Inspect both notches BEFORE advancing. The middle pawl causes the double
  // step. Notches belong to the index ring, so ring settings do not shift the
  // turnover letter visible in the window.
  const middleAtNotch = positions[1] === toIndex(rotors[1].notch);
  const rightAtNotch = positions[2] === toIndex(rotors[2].notch);
  if (middleAtNotch) positions[0] = mod26(positions[0] + 1);
  if (middleAtNotch || rightAtNotch) positions[1] = mod26(positions[1] + 1);
  positions[2] = mod26(positions[2] + 1);
}

/** Return windows after one keypress, without mutating the supplied settings. */
export function stepPositions(settings = DEFAULT_SETTINGS, positions = settings.positions) {
  const canonical = validateSettings(settings);
  const windows = [...threeLetters(positions, 'Позиции')].map(toIndex);
  advance(canonical.rotors.map((name) => ROTORS[name]), windows);
  return windows.map((value) => ALPHABET[value]).join('');
}

function throughRotor(value, wiring, position, ring) {
  return mod26(wiring[mod26(value + position - ring)] - position + ring);
}

/**
 * The same operation encrypts and decrypts. Every invocation resets to initial
 * positions. Only A–Z steps the machine; nonletters remain in place unchanged.
 */
export function transform(message, settings = DEFAULT_SETTINGS, options = {}) {
  const canonical = validateSettings(settings);
  const normalized = normalizeMessage(message, options);
  const positions = [...canonical.positions].map(toIndex);
  const rings = [...canonical.rings].map(toIndex);
  const rotors = canonical.rotors.map((name) => {
    const rotor = ROTORS[name];
    const forward = [...rotor.wiring].map(toIndex);
    const reverse = Array(26);
    forward.forEach((output, input) => { reverse[output] = input; });
    return { ...rotor, forward, reverse };
  });
  const plugs = [...ALPHABET].map(toIndex);
  for (const pair of canonical.plugboard.split(' ').filter(Boolean)) {
    const [first, second] = [...pair].map(toIndex);
    plugs[first] = second;
    plugs[second] = first;
  }
  let output = '';
  for (const character of normalized) {
    if (!/^[A-Z]$/.test(character)) {
      output += character;
      continue;
    }
    advance(rotors, positions);
    let signal = plugs[toIndex(character)];
    for (let slot = 2; slot >= 0; slot -= 1) {
      signal = throughRotor(signal, rotors[slot].forward, positions[slot], rings[slot]);
    }
    signal = REFLECTOR_B[signal];
    for (let slot = 0; slot < 3; slot += 1) {
      signal = throughRotor(signal, rotors[slot].reverse, positions[slot], rings[slot]);
    }
    output += ALPHABET[plugs[signal]];
  }
  return output;
}

function randomInteger(limit) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Случайный ключ недоступен: браузер не поддерживает crypto.getRandomValues.');
  }
  const buffer = new Uint32Array(1);
  const ceiling = 0x100000000 - (0x100000000 % limit);
  do { globalThis.crypto.getRandomValues(buffer); } while (buffer[0] >= ceiling);
  return buffer[0] % limit;
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomInteger(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

/** Random three-rotor order, rings, starts and ten disjoint plugboard pairs. */
export function randomSettings() {
  const letters = shuffled(ALPHABET);
  const threeRandomLetters = () => Array.from({ length: 3 }, () => ALPHABET[randomInteger(26)]).join('');
  return validateSettings({
    rotors: shuffled(ROTOR_NAMES).slice(0, 3),
    rings: threeRandomLetters(),
    positions: threeRandomLetters(),
    plugboard: Array.from({ length: 10 }, (_, index) => letters[index * 2] + letters[index * 2 + 1]).join(' '),
    reflector: 'B',
  });
}

/** Export settings only. Messages and UI state are never included. */
export function serializeSettings(settings) {
  return JSON.stringify({ format: CONFIG_FORMAT, version: CONFIG_VERSION, settings: validateSettings(settings) }, null, 2);
}

/** Parse the versioned export format; reject unknown fields and invalid keys. */
export function parseSettings(json) {
  if (typeof json !== 'string' || json.length > 16384) {
    throw new Error('Файл настроек должен быть JSON размером не более 16 КБ.');
  }
  let config;
  try {
    config = JSON.parse(json);
  } catch {
    throw new Error('Не удалось прочитать JSON настроек.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      config.format !== CONFIG_FORMAT || config.version !== CONFIG_VERSION ||
      Object.keys(config).some((key) => !['format', 'version', 'settings'].includes(key))) {
    throw new Error('Нужен файл настроек Enigma I версии 1, экспортированный этой страницей.');
  }
  const settings = validateSettings(config.settings ?? null);
  if (Object.keys(config.settings).some((key) => !Object.keys(settings).includes(key))) {
    throw new Error('В файле настроек есть неизвестные поля.');
  }
  return settings;
}

/**
 * Pure URL builder. It never opens Telegram or sends anything.
 * https://core.telegram.org/widgets/share
 * The caller must pass the computed ciphertext, never the source message.
 */
export function buildTelegramShareUrl(ciphertext, publicURL) {
  if (typeof ciphertext !== 'string' || ciphertext.trim() === '') {
    throw new Error('Сначала получите шифртекст.');
  }
  requireWellFormedText(ciphertext);
  let destination;
  try { destination = new URL(publicURL); } catch {
    throw new Error('Для отправки нужна публичная HTTPS-ссылка страницы.');
  }
  if (destination.protocol !== 'https:' || destination.username || destination.password ||
      destination.search || destination.hash) {
    throw new Error('Ссылка страницы должна быть HTTPS, без параметров, ключа и фрагмента.');
  }
  const share = new URL('https://t.me/share/url');
  share.searchParams.set('url', destination.href);
  share.searchParams.set('text', ciphertext);
  return share.href;
}
