/**
 * Nonhistorical rotor experiment. This is not Enigma I and is not modern security.
 * Left-to-right rotors use one ring setting and one initial window each.
 * odometer-v1 steps BEFORE each A-Z character: advance the rightmost window,
 * carrying left only on Z -> A. Rings change wiring offsets, never carry points.
 * A fixed involutory reflector B and reverse rotor paths make it reciprocal.
 */
import { ALPHABET, normalizeMessage } from './enigma.js';

export const MIN_EXPERIMENTAL_ROTORS = 3;
export const MAX_EXPERIMENTAL_ROTORS = 30;
export const MAX_EXPERIMENTAL_KEY_BYTES = 16384;
export const MAX_EXPERIMENTAL_MESSAGE_LENGTH = 20026;
export const EXPERIMENTAL_STEPPING = 'odometer-v1';
export const EXPERIMENTAL_CONFIG_FORMAT = 'enigma-experimental';
export const EXPERIMENTAL_CONFIG_VERSION = 1;

const REFLECTOR_B = [...'YRUHQSLDPXNGOKMIEBFZCWVJAT'].map(toIndex);
const SETTINGS_FIELDS = ['rotors', 'reflector', 'stepping', 'plugboard'];
const ROTOR_FIELDS = ['wiring', 'ring', 'position'];

function toIndex(letter) { return letter.charCodeAt(0) - 65; }
function mod26(value) { return (value % 26 + 26) % 26; }

function requireFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label}: нужен объект с известными полями.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(value, key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new Error(`${label}: неизвестное или отсутствующее поле.`);
  }
}

function requireRotorCount(count) {
  if (!Number.isInteger(count) || count < MIN_EXPERIMENTAL_ROTORS || count > MAX_EXPERIMENTAL_ROTORS) {
    throw new Error('Экспериментальная машина: нужно от 3 до 30 роторов.');
  }
}

function letter(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z]$/.test(value)) {
    throw new Error(`${label}: нужна одна буква A–Z.`);
  }
  return value.toUpperCase();
}

function validatePlugboard(value) {
  if (typeof value !== 'string' || value.length > 128) {
    throw new Error('Коммутационная панель: до 10 пар A–Z, строка не длиннее 128 символов.');
  }
  const pairs = value.trim() ? value.trim().split(/\s+/) : [];
  if (pairs.length > 10) throw new Error('Коммутационная панель: допустимо не больше 10 пар.');
  const used = new Set();
  return pairs.map((pair) => {
    if (!/^[A-Za-z]{2}$/.test(pair)) throw new Error('Каждая пара содержит две буквы A–Z; разделяйте пары пробелами.');
    const canonical = pair.toUpperCase();
    for (const character of canonical) {
      if (used.has(character)) throw new Error(`Буква ${character} в коммутационной панели повторяется.`);
      used.add(character);
    }
    return canonical;
  }).join(' ');
}

/** A fresh, deeply frozen canonical key. Reject unknown fields and huge arrays early. */
export function validateExperimentalSettings(settings) {
  requireFields(settings, SETTINGS_FIELDS, 'Экспериментальный ключ');
  if (!Array.isArray(settings.rotors)) throw new Error('Роторы должны быть списком.');
  requireRotorCount(settings.rotors.length);
  const indices = Reflect.ownKeys(settings.rotors);
  if (indices.length !== settings.rotors.length + 1 ||
      indices.some((key) => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= settings.rotors.length))) {
    throw new Error('Список роторов должен быть полным, без дополнительных полей.');
  }
  if (settings.reflector !== 'B') throw new Error('Экспериментальная машина поддерживает только отражатель B.');
  if (settings.stepping !== EXPERIMENTAL_STEPPING) throw new Error('Неизвестное правило шага: требуется odometer-v1.');
  const usedWirings = new Set();
  const rotors = settings.rotors.map((rotor, index) => {
    requireFields(rotor, ROTOR_FIELDS, `Ротор ${index + 1}`);
    if (typeof rotor.wiring !== 'string' || !/^[A-Za-z]{26}$/.test(rotor.wiring)) {
      throw new Error(`Ротор ${index + 1}: проводка должна содержать 26 букв A–Z.`);
    }
    const wiring = rotor.wiring.toUpperCase();
    if (new Set(wiring).size !== 26) throw new Error(`Ротор ${index + 1}: в проводке каждая буква должна встречаться один раз.`);
    if (usedWirings.has(wiring)) throw new Error('Проводки роторов должны быть разными.');
    usedWirings.add(wiring);
    return Object.freeze({
      wiring,
      ring: letter(rotor.ring, `Кольцо ротора ${index + 1}`),
      position: letter(rotor.position, `Начальная позиция ротора ${index + 1}`),
    });
  });
  return Object.freeze({ rotors: Object.freeze(rotors), reflector: 'B', stepping: EXPERIMENTAL_STEPPING,
    plugboard: validatePlugboard(settings.plugboard) });
}

function advance(positions) {
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    positions[index] = (positions[index] + 1) % 26;
    if (positions[index] !== 0) break;
  }
}

/** A-Z windows after one letter, without changing the key. Optional windows are a string. */
export function stepExperimentalPositions(settings, positions) {
  const canonical = validateExperimentalSettings(settings);
  const windows = positions ?? canonical.rotors.map((rotor) => rotor.position).join('');
  if (typeof windows !== 'string' || windows.length !== canonical.rotors.length || !/^[A-Za-z]+$/.test(windows)) {
    throw new Error('Позиции: нужна одна буква A–Z для каждого ротора.');
  }
  const indices = [...windows.toUpperCase()].map(toIndex);
  advance(indices);
  return indices.map((index) => ALPHABET[index]).join('');
}

function throughRotor(value, wiring, offset) {
  return mod26(wiring[mod26(value + offset)] - offset);
}

/** Reset at each call; only A-Z steps. Legacy punctuation and normalization are preserved. */
export function transformExperimental(message, settings, options = {}) {
  if (typeof message !== 'string' || message.length > MAX_EXPERIMENTAL_MESSAGE_LENGTH) {
    throw new Error(`Сообщение должно быть строкой длиной не больше ${MAX_EXPERIMENTAL_MESSAGE_LENGTH} символов.`);
  }
  const canonical = validateExperimentalSettings(settings);
  const normalized = normalizeMessage(message, options);
  if (normalized.length > MAX_EXPERIMENTAL_MESSAGE_LENGTH) {
    throw new Error(`После транслитерации допустимо не больше ${MAX_EXPERIMENTAL_MESSAGE_LENGTH} символов.`);
  }
  const positions = canonical.rotors.map((rotor) => toIndex(rotor.position));
  const rings = canonical.rotors.map((rotor) => toIndex(rotor.ring));
  const rotors = canonical.rotors.map((rotor) => {
    const forward = [...rotor.wiring].map(toIndex);
    const reverse = Array(26);
    forward.forEach((output, input) => { reverse[output] = input; });
    return { forward, reverse };
  });
  const plugs = [...ALPHABET].map(toIndex);
  for (const pair of canonical.plugboard.split(' ').filter(Boolean)) {
    const [a, b] = [...pair].map(toIndex);
    plugs[a] = b;
    plugs[b] = a;
  }
  const output = [];
  for (const character of normalized) {
    const input = toIndex(character);
    if (input < 0 || input >= 26) {
      output.push(character);
      continue;
    }
    advance(positions);
    let signal = plugs[input];
    for (let slot = rotors.length - 1; slot >= 0; slot -= 1) {
      signal = throughRotor(signal, rotors[slot].forward, positions[slot] - rings[slot]);
    }
    signal = REFLECTOR_B[signal];
    for (let slot = 0; slot < rotors.length; slot += 1) {
      signal = throughRotor(signal, rotors[slot].reverse, positions[slot] - rings[slot]);
    }
    output.push(ALPHABET[plugs[signal]]);
  }
  return output.join('');
}

function randomInteger(limit) {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Случайный ключ недоступен: нужен crypto.getRandomValues.');
  const buffer = new Uint32Array(1);
  const ceiling = 0x100000000 - (0x100000000 % limit);
  do { globalThis.crypto.getRandomValues(buffer); } while (buffer[0] >= ceiling);
  return buffer[0] % limit;
}

function shuffledAlphabet() {
  const result = [...ALPHABET];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomInteger(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result.join('');
}

/** Browser CSPRNG, unbiased Fisher-Yates, one permutation/ring/start for every rotor. */
export function randomExperimentalSettings(count = 30) {
  requireRotorCount(count);
  const used = new Set();
  const rotors = Array.from({ length: count }, () => {
    let wiring;
    let attempts = 0;
    do {
      wiring = shuffledAlphabet();
      attempts += 1;
      if (attempts > 16) throw new Error('Не удалось получить разные проводки; повторите создание ключа.');
    } while (used.has(wiring));
    used.add(wiring);
    return { wiring, ring: ALPHABET[randomInteger(26)], position: ALPHABET[randomInteger(26)] };
  });
  const plugs = shuffledAlphabet();
  return validateExperimentalSettings({
    rotors, reflector: 'B', stepping: EXPERIMENTAL_STEPPING,
    plugboard: Array.from({ length: 10 }, (_, index) => plugs.slice(index * 2, index * 2 + 2)).join(' '),
  });
}

/** Versioned key only. Never contains messages or UI state. */
export function serializeExperimentalSettings(settings) {
  return JSON.stringify({ format: EXPERIMENTAL_CONFIG_FORMAT, version: EXPERIMENTAL_CONFIG_VERSION,
    settings: validateExperimentalSettings(settings) }, null, 2);
}

/** Enforce both code-unit and UTF-8 byte limits BEFORE JSON parsing. */
export function parseExperimentalSettings(json) {
  if (typeof json !== 'string' || json.length > MAX_EXPERIMENTAL_KEY_BYTES ||
      new TextEncoder().encode(json).length > MAX_EXPERIMENTAL_KEY_BYTES) {
    throw new Error('Экспериментальный ключ должен быть JSON размером не больше 16 КиБ.');
  }
  let config;
  try { config = JSON.parse(json); } catch { throw new Error('Не удалось прочитать JSON экспериментального ключа.'); }
  requireFields(config, ['format', 'version', 'settings'], 'Файл ключа');
  if (config.format !== EXPERIMENTAL_CONFIG_FORMAT || config.version !== EXPERIMENTAL_CONFIG_VERSION) {
    throw new Error('Нужен экспериментальный ключ enigma-experimental версии 1.');
  }
  return validateExperimentalSettings(config.settings);
}
