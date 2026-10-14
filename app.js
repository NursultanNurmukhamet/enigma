import {
  DEFAULT_SETTINGS, validateSettings, transform, randomSettings,
  serializeSettings, parseSettings, buildTelegramShareUrl,
} from './enigma.js';
import {
  encryptExact, decryptExact, utf8ByteLength,
  MAX_EXACT_BYTES, MAX_EXACT_CIPHERTEXT_LENGTH,
  EXACT_PREFIX, EXPERIMENTAL_EXACT_PREFIX, MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH,
} from './exact-text.js';
import {
  validateExperimentalSettings, randomExperimentalSettings,
  serializeExperimentalSettings, parseExperimentalSettings,
  MIN_EXPERIMENTAL_ROTORS, MAX_EXPERIMENTAL_ROTORS,
} from './experimental.js';

// A fixed public URL keeps key, message, query string and fragments out of shares.
const PUBLIC_URL = 'https://nursultannurmukhamet.github.io/enigma/';
const MAX_MESSAGE_LENGTH = 10000;
const MAX_SHARE_URL_LENGTH = 8000;
const MAX_KEY_FILE_BYTES = 16384;
const $ = (id) => document.getElementById(id);
const message = $('message');
const result = $('result');
const exactResult = $('exact-result');
const textFormat = $('text-format');
const exactButton = $('process-exact');
const machineMode = $('machine-mode');
const rotorCount = $('rotor-count');
const experimentalRotors = $('experimental-rotors');
const plugboard = $('plugboard');
const transliterate = $('transliterate');
const keyError = $('key-error');
const inputError = $('input-error');
const copyButton = $('copy-result');
const reuseButton = $('reuse-result');
const shareButton = $('share-telegram');
const exportButton = $('export-key');
const keyFile = $('key-file');
const textFile = $('text-file');
const downloadButton = $('download-result');
const rotorInputs = Array.from({ length: 3 }, (_, i) => $(`rotor-${i}`));
const ringInputs = Array.from({ length: 3 }, (_, i) => $(`ring-${i}`));
const positionInputs = Array.from({ length: 3 }, (_, i) => $(`position-${i}`));
let currentShareUrl = '';
let currentResult = null;
// Textareas normalize CR/CRLF. Preserve the original string when reusing a
// decoded result; a real edit replaces this temporary in-memory value.
let reusedExactSource = null;
let uiRevision = 0;
let experimentalSettings = null;
let savedClassicSettings = null;
let savedClassicFormat = 'legacy';
let pendingWorkerRequest = null;
let keyImportSequence = 0;
let machineWorker;
let workerFailure = '';

// Load only static, same-origin code at startup. Message processing never fetches.
try {
  machineWorker = new Worker(new URL('./machine-worker.js', import.meta.url), { type: 'module' });
  machineWorker.addEventListener('message', receiveWorkerResult);
  machineWorker.addEventListener('error', () => {
    workerFailure = 'Не удалось запустить обработку экспериментальной машины. Обновите страницу и повторите.';
    if (isExperimental()) recompute();
  });
} catch {
  workerFailure = 'Этот браузер не поддерживает отдельный поток для экспериментальной машины.';
}

for (const select of [...ringInputs, ...positionInputs]) {
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') select.add(new Option(letter, letter));
}
for (let count = MIN_EXPERIMENTAL_ROTORS; count <= MAX_EXPERIMENTAL_ROTORS; count += 1) {
  rotorCount.add(new Option(String(count), String(count)));
}
rotorCount.value = String(MAX_EXPERIMENTAL_ROTORS);

function mode() { return document.querySelector('input[name="mode"]:checked').value; }
function isExact() { return textFormat.value === 'exact'; }
function isExperimental() { return machineMode.value === 'experimental'; }
function exactPrefix() { return isExperimental() ? EXPERIMENTAL_EXACT_PREFIX : EXACT_PREFIX; }
function ciphertextLimit() { return isExperimental() ? MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH : MAX_EXACT_CIPHERTEXT_LENGTH; }
function sourceText() { return isExact() && reusedExactSource !== null ? reusedExactSource : message.value; }

function showError(element, text = '') {
  element.textContent = text;
  element.hidden = !text;
}

function status(id, text = '', isError = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', isError);
}

function readClassicSettings() {
  return {
    rotors: rotorInputs.map((input) => input.value),
    rings: ringInputs.map((input) => input.value).join(''),
    positions: positionInputs.map((input) => input.value).join(''),
    plugboard: plugboard.value,
    reflector: 'B',
  };
}

function readSettings() {
  return isExperimental()
    ? validateExperimentalSettings({ ...experimentalSettings, plugboard: plugboard.value })
    : validateSettings(readClassicSettings());
}

function writeClassicSettings(settings) {
  rotorInputs.forEach((input, i) => { input.value = settings.rotors[i]; });
  ringInputs.forEach((input, i) => { input.value = settings.rings[i]; });
  positionInputs.forEach((input, i) => { input.value = settings.positions[i]; });
  plugboard.value = settings.plugboard;
}

function applySettings(settings) { writeClassicSettings(validateSettings(settings)); }

function applyExperimentalSettings(settings) {
  experimentalSettings = structuredClone(settings);
  rotorCount.value = String(experimentalSettings.rotors.length);
  plugboard.value = experimentalSettings.plugboard;
  renderExperimentalRotors();
}

function renderExperimentalRotors() {
  const openGroups = new Set([...experimentalRotors.querySelectorAll('details[open]')].map((group) => group.dataset.group));
  const wasEmpty = !experimentalRotors.childElementCount;
  experimentalRotors.replaceChildren();
  for (let start = 0; start < experimentalSettings.rotors.length; start += 5) {
    const group = document.createElement('details');
    group.className = 'rotor-group';
    group.dataset.group = String(start);
    group.open = (wasEmpty && start === 0) || openGroups.has(String(start));
    const summary = document.createElement('summary');
    summary.textContent = `Роторы ${start + 1}–${Math.min(start + 5, experimentalSettings.rotors.length)}`;
    group.append(summary);
    const cards = document.createElement('div');
    cards.className = 'experimental-cards';
    experimentalSettings.rotors.slice(start, start + 5).forEach((rotor, offset) => {
      const index = start + offset;
      const card = document.createElement('fieldset');
      card.className = 'experimental-card';
      const legend = document.createElement('legend');
      legend.textContent = `Ротор ${index + 1}${index === 0 ? ' · левый' : index === experimentalSettings.rotors.length - 1 ? ' · правый' : ''}`;
      card.append(legend);
      for (const [field, title] of [['wiring', 'Проводка A–Z'], ['ring', 'Кольцо'], ['position', 'Старт']]) {
        const label = document.createElement('label');
        label.className = field === 'wiring' ? 'wiring-control' : 'rotor-letter-control';
        label.textContent = title;
        const input = document.createElement(field === 'wiring' ? 'input' : 'select');
        input.id = `experimental-${field}-${index}`;
        input.dataset.index = String(index);
        input.dataset.field = field;
        input.setAttribute('aria-describedby', 'key-error');
        label.htmlFor = input.id;
        if (field === 'wiring') {
          input.type = 'text';
          input.maxLength = 26;
          input.autocomplete = 'off';
          input.spellcheck = false;
          input.setAttribute('autocapitalize', 'characters');
        } else {
          for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') input.add(new Option(letter, letter));
        }
        input.value = rotor[field];
        label.append(input);
        card.append(label);
      }
      cards.append(card);
    });
    group.append(cards);
    experimentalRotors.append(group);
  }
}

function switchMachine(next, importedSettings = null) {
  const wasExperimental = machineMode.dataset.active === 'experimental';
  if (next === 'experimental') {
    if (!wasExperimental) {
      savedClassicSettings = readClassicSettings();
      savedClassicFormat = textFormat.value;
    } else if (experimentalSettings) experimentalSettings.plugboard = plugboard.value;
    machineMode.value = 'experimental';
    applyExperimentalSettings(importedSettings || experimentalSettings || randomExperimentalSettings(MAX_EXPERIMENTAL_ROTORS));
    textFormat.value = 'exact';
  } else {
    if (wasExperimental && experimentalSettings) experimentalSettings.plugboard = plugboard.value;
    machineMode.value = 'classic';
    writeClassicSettings(importedSettings || savedClassicSettings || DEFAULT_SETTINGS);
    if (wasExperimental) textFormat.value = savedClassicFormat;
  }
  machineMode.dataset.active = next;
  recompute();
}

function resizeExperimental(count) {
  if (!Number.isInteger(count) || count < MIN_EXPERIMENTAL_ROTORS || count > MAX_EXPERIMENTAL_ROTORS) {
    throw new Error('Выберите от 3 до 30 роторов.');
  }
  const existing = experimentalSettings.rotors.slice(0, count);
  const used = new Set(existing.map((rotor) => rotor.wiring.toUpperCase()));
  while (existing.length < count) {
    const candidates = randomExperimentalSettings(count).rotors;
    for (const candidate of candidates) {
      if (!used.has(candidate.wiring)) {
        existing.push(structuredClone(candidate));
        used.add(candidate.wiring);
      }
      if (existing.length === count) break;
    }
  }
  experimentalSettings = { ...experimentalSettings, rotors: existing, plugboard: plugboard.value };
  rotorCount.value = String(count);
  renderExperimentalRotors();
  recompute();
  status('key-status', `Роторов: ${count}. Существующие настройки сохранены; добавленные роторы получили случайные настройки.`);
}

function recompute(executeExact = false) {
  uiRevision += 1;
  pendingWorkerRequest = null;
  exactResult.setAttribute('aria-busy', 'false');
  const decrypting = mode() === 'decrypt';
  const exact = isExact();
  const experimental = isExperimental();
  const prefix = exactPrefix();
  $('classic-rotor-controls').hidden = experimental;
  $('experimental-settings').hidden = !experimental;
  textFormat.disabled = experimental;
  $('machine-help').textContent = experimental
    ? 'Экспериментальная машина с 3–30 разными проводками. Нумерация слева направо; у каждого ротора своё кольцо и старт.'
    : 'Роторы расположены слева направо. Каждый используется только один раз.';
  const badge = document.querySelector('.machine-badge');
  badge.setAttribute('aria-label', experimental ? `Экспериментальная машина: ${experimentalSettings.rotors.length} роторов` : 'Enigma I: 3 ротора, рефлектор B');
  badge.querySelector('span:first-child').textContent = experimental ? 'ЭКСПЕРИМЕНТ' : 'ENIGMA I';
  badge.querySelector('strong').textContent = experimental ? `${experimentalSettings.rotors.length} РОТОРОВ` : 'A · A · A';
  badge.querySelector('span:last-child').textContent = experimental ? 'НЕИСТОРИЧЕСКАЯ МАШИНА' : '3 РОТОРА / РЕФЛЕКТОР B';
  $('reset-key').textContent = experimental ? 'Сбросить кольца и старт' : 'Сбросить';
  $('input-label').textContent = decrypting ? 'Полученный шифртекст' : 'Исходный текст';
  $('output-label').textContent = decrypting ? 'Расшифрованный текст' : 'Шифртекст';
  $('output-label').htmlFor = exact ? 'exact-result' : 'result';
  $('output-caption').textContent = exact ? `Формат ${prefix.slice(0, -1)} · тот же ключ у обоих` : 'Тот же ключ → обратное преобразование';
  message.placeholder = decrypting
    ? (exact ? `Вставьте весь шифртекст ${prefix}… без изменений` : 'Вставьте шифртекст и задайте ключ отправителя')
    : (exact ? 'Например, Привет, ёж! 👋' : 'Например, HELLO WORLD');
  message.maxLength = exact && decrypting ? ciphertextLimit() : MAX_MESSAGE_LENGTH;
  message.setAttribute('autocapitalize', exact ? 'off' : 'characters');
  transliterate.disabled = decrypting || exact;
  $('transliterate-control').hidden = exact;
  $('exact-note').hidden = !exact;
  exactButton.hidden = !exact;
  $('import-text').hidden = !exact;
  downloadButton.hidden = !exact;
  exactButton.disabled = false;
  exactButton.textContent = decrypting ? 'Расшифровать точный текст' : 'Зашифровать точный текст';
  result.hidden = exact;
  exactResult.hidden = !exact;
  $('exact-state').hidden = !exact;
  $('format-help').textContent = experimental
    ? 'Эксперимент использует только «Точный текст». У получателя должны совпадать машина и полный ключ, включая все проводки.'
    : exact
    ? 'Оба участника выбирают «Точный текст» и одинаковый ключ. Действие запускается кнопкой под сообщением.'
    : 'Для прежних шифров — A–Z / транслит. Чтобы вернуть русский текст без потерь, выберите «Точный текст».';
  $('message-rules').textContent = exact
    ? (decrypting ? 'Нужен полный контейнер версии 1, без добавленных пробелов и переносов.' : 'До 10 000 байт UTF-8. Русская буква обычно занимает 2 байта, emoji — 4 и больше.')
    : 'A–Z → верхний регистр. Пробелы, цифры и знаки сохраняются и не двигают роторы.';
  const inputLength = exact && !decrypting ? new TextEncoder().encode(sourceText()).length : sourceText().length;
  const inputLimit = exact ? (decrypting ? ciphertextLimit() : MAX_EXACT_BYTES) : MAX_MESSAGE_LENGTH;
  $('input-count').textContent = `${inputLength.toLocaleString('ru-RU')} / ${inputLimit.toLocaleString('ru-RU')}${exact && !decrypting ? ' байт' : ''}`;
  $('input-count').setAttribute('aria-label', exact && !decrypting ? 'Размер текста в байтах UTF-8' : 'Количество символов');
  showError(keyError);
  showError(inputError);
  message.removeAttribute('aria-invalid');
  plugboard.removeAttribute('aria-invalid');
  rotorInputs.forEach((input) => input.removeAttribute('aria-invalid'));
  experimentalRotors.querySelectorAll('input,select').forEach((input) => input.removeAttribute('aria-invalid'));
  result.value = '';
  exactResult.textContent = '';
  currentResult = null;
  currentShareUrl = '';
  copyButton.disabled = true;
  reuseButton.disabled = true;
  shareButton.disabled = true;
  downloadButton.disabled = true;
  exportButton.disabled = false;
  status('message-status');
  status('exact-state', exact ? 'Результата пока нет. Нажмите кнопку обработки.' : '');

  let settings;
  try {
    settings = readSettings();
  } catch (error) {
    showError(keyError, error.message);
    const duplicateRotors = new Set(rotorInputs.map((input) => input.value)).size !== 3;
    if (experimental && !error.message.includes('панел')) {
      experimentalRotors.querySelectorAll('input,select').forEach((input) => input.setAttribute('aria-invalid', 'true'));
    } else if (!experimental && duplicateRotors) rotorInputs.forEach((input) => input.setAttribute('aria-invalid', 'true'));
    else plugboard.setAttribute('aria-invalid', 'true');
    exportButton.disabled = true;
    exactButton.disabled = true;
    if (exact) status('exact-state', 'Результата нет: исправьте настройки ключа.');
    $('share-help').textContent = 'Исправьте настройки ключа, чтобы получить результат.';
    return;
  }
  try {
    if (exact) {
      if (experimental && workerFailure) throw new Error(workerFailure);
      if (decrypting && sourceText().length > ciphertextLimit()) {
        throw new Error(`Шифртекст слишком длинный: максимум ${ciphertextLimit().toLocaleString('ru-RU')} символов.`);
      }
      if (!decrypting) utf8ByteLength(sourceText());
      if (!executeExact) {
        $('share-help').textContent = decrypting
          ? 'В режиме расшифровки отправка в Telegram отключена.'
          : 'Сначала нажмите «Зашифровать точный текст». В Telegram попадут только шифртекст и ссылка сайта.';
        return;
      }
      if (experimental) {
        const request = { id: uiRevision, operation: decrypting ? 'decrypt' : 'encrypt', text: sourceText(), settings };
        pendingWorkerRequest = { id: request.id, decrypting, inputBytes: decrypting ? 0 : utf8ByteLength(sourceText()), prefix };
        exactResult.setAttribute('aria-busy', 'true');
        exactButton.disabled = true;
        exactButton.textContent = 'Обработка…';
        status('exact-state', 'Обработка в отдельном потоке. Поле и настройки остаются доступны.');
        $('share-help').textContent = 'Дождитесь результата. Отправка в Telegram пока недоступна.';
        machineWorker.postMessage(request);
        return;
      }
      currentResult = decrypting ? decryptExact(sourceText(), settings) : encryptExact(sourceText(), settings);
      // Never use HTML parsing or a textarea value for decoded Unicode output.
      exactResult.textContent = currentResult;
      const bytes = decrypting ? utf8ByteLength(currentResult) : utf8ByteLength(sourceText());
      status('exact-state', decrypting
        ? `${currentResult === '' ? 'Пустой текст (0 байт)' : `Восстановлено ${bytes.toLocaleString('ru-RU')} байт UTF-8`}. Проверка CRC32 пройдена; это не подтверждение подлинности.`
        : `Зашифровано ${bytes.toLocaleString('ru-RU')} байт UTF-8. Передайте контейнер целиком, включая ${prefix}.`);
    } else {
      // transform creates a new machine at the original positions on every call.
      const transformed = transform(message.value, settings, { transliterateRussian: !decrypting && transliterate.checked });
      if (transformed.length > MAX_MESSAGE_LENGTH) {
        throw new Error('После перевода в латиницу сообщение длиннее 10 000 символов. Сократите исходный текст: некоторые русские буквы превращаются в несколько латинских.');
      }
      result.value = transformed;
      currentResult = transformed;
    }
  } catch (error) {
    pendingWorkerRequest = null;
    exactResult.setAttribute('aria-busy', 'false');
    exactButton.disabled = false;
    exactButton.textContent = decrypting ? 'Расшифровать точный текст' : 'Зашифровать точный текст';
    currentResult = null;
    exactResult.textContent = '';
    showError(inputError, error.message);
    message.setAttribute('aria-invalid', 'true');
    if (exact) status('exact-state', 'Результата нет: исправьте ошибку и повторите действие.');
    $('share-help').textContent = 'Исправьте текст, чтобы получить результат.';
    return;
  }

  updateResultActions(decrypting, exact);
}

function updateResultActions(decrypting = mode() === 'decrypt', exact = isExact()) {
  const hasResult = exact ? currentResult !== null : result.value.length > 0;
  copyButton.disabled = !hasResult;
  reuseButton.disabled = !hasResult;
  downloadButton.disabled = !hasResult || !exact;
  if (decrypting) {
    $('share-help').textContent = 'В режиме расшифровки отправка в Telegram отключена.';
  } else if (!/[A-Z]/.test(currentResult)) {
    $('share-help').textContent = 'Введите сообщение с буквами, чтобы поделиться шифртекстом.';
  } else {
    try {
      const shareUrl = buildTelegramShareUrl(currentResult, PUBLIC_URL);
      if (shareUrl.length > MAX_SHARE_URL_LENGTH) {
        $('share-help').textContent = 'Текст слишком длинный для ссылки Telegram. Скопируйте результат.';
      } else {
        currentShareUrl = shareUrl;
        shareButton.disabled = false;
        $('share-help').textContent = 'Только шифртекст и ссылка сайта. Чат и отправку вы подтвердите в Telegram.';
      }
    } catch (error) {
      $('share-help').textContent = 'Не удалось подготовить ссылку Telegram. Скопируйте результат.';
    }
  }
}

function receiveWorkerResult(event) {
  const response = event.data;
  const pending = pendingWorkerRequest;
  if (!pending || response?.id !== pending.id || pending.id !== uiRevision || !isExperimental()) return;
  pendingWorkerRequest = null;
  exactResult.setAttribute('aria-busy', 'false');
  exactButton.disabled = false;
  exactButton.textContent = pending.decrypting ? 'Расшифровать точный текст' : 'Зашифровать точный текст';
  if (response.ok !== true || typeof response.text !== 'string') {
    showError(inputError, typeof response.error === 'string' ? response.error : 'Не удалось обработать сообщение. Повторите действие.');
    message.setAttribute('aria-invalid', 'true');
    status('exact-state', 'Результата нет: исправьте ошибку и повторите действие.');
    $('share-help').textContent = 'Исправьте текст, чтобы получить результат.';
    return;
  }
  currentResult = response.text;
  exactResult.textContent = currentResult;
  const bytes = pending.decrypting ? utf8ByteLength(currentResult) : pending.inputBytes;
  status('exact-state', pending.decrypting
    ? `${currentResult === '' ? 'Пустой текст (0 байт)' : `Восстановлено ${bytes.toLocaleString('ru-RU')} байт UTF-8`}. Проверка CRC32 пройдена; это не подтверждение подлинности.`
    : `Зашифровано ${bytes.toLocaleString('ru-RU')} байт UTF-8. Передайте контейнер целиком, включая ${pending.prefix}.`);
  updateResultActions(pending.decrypting, true);
}

for (const input of [...rotorInputs, ...ringInputs, ...positionInputs, plugboard]) {
  input.addEventListener('input', () => { status('key-status'); recompute(); });
}
machineMode.addEventListener('change', () => {
  try {
    switchMachine(machineMode.value);
    status('key-status', isExperimental() ? 'Выбрана экспериментальная машина. Полный ключ включает проводку, кольцо и старт каждого ротора.' : 'Классическая машина и её настройки восстановлены.');
  } catch (error) {
    machineMode.value = machineMode.dataset.active || 'classic';
    recompute();
    status('key-status', `Машина не переключена: ${error.message}`, true);
  }
});
experimentalRotors.addEventListener('input', (event) => {
  const input = event.target;
  const index = Number(input.dataset.index);
  const field = input.dataset.field;
  if (!isExperimental() || !Number.isInteger(index) || !['wiring', 'ring', 'position'].includes(field) || !experimentalSettings.rotors[index]) return;
  experimentalSettings.rotors[index][field] = input.value;
  status('key-status');
  recompute();
});
rotorCount.addEventListener('change', () => {
  try { resizeExperimental(Number(rotorCount.value)); }
  catch (error) { status('key-status', error.message, true); }
});
$('preset-30').addEventListener('click', () => {
  try { resizeExperimental(MAX_EXPERIMENTAL_ROTORS); }
  catch (error) { status('key-status', error.message, true); }
});
message.addEventListener('input', () => { reusedExactSource = null; recompute(); });
transliterate.addEventListener('change', () => recompute());
textFormat.addEventListener('change', () => recompute());
for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener('change', () => recompute());
exactButton.addEventListener('click', () => { if (!exactButton.disabled && isExact()) recompute(true); });

$('import-text').addEventListener('click', () => { textFile.value = ''; textFile.click(); });
textFile.addEventListener('change', async () => {
  const file = textFile.files?.[0];
  if (!file || !isExact()) return;
  recompute();
  const revision = uiRevision;
  const limit = mode() === 'decrypt' ? ciphertextLimit() : MAX_EXACT_BYTES;
  try {
    if (!/\.txt$/i.test(file.name)) throw new Error('Выберите UTF-8 файл с расширением .txt.');
    if (file.size > limit) throw new Error(`Файл слишком большой: допустимо не больше ${limit.toLocaleString('ru-RU')} байт.`);
    const bytes = await file.arrayBuffer();
    if (revision !== uiRevision) return;
    let text;
    try {
      // ignoreBOM:true retains a leading U+FEFF as part of the original text.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error('Файл содержит некорректный UTF-8. Пересохраните его в кодировке UTF-8.');
    }
    message.value = text;
    reusedExactSource = text;
    recompute();
    status('message-status', 'Файл загружен без изменения символов и переносов. Нажмите кнопку обработки. Редактирование поля заменит исходные переносы браузерными.');
  } catch (error) {
    if (revision === uiRevision) status('message-status', `Загрузка не выполнена: ${error.message}`, true);
  } finally {
    textFile.value = '';
  }
});

downloadButton.addEventListener('click', () => {
  if (downloadButton.disabled || !isExact() || currentResult === null) return;
  const bytes = new TextEncoder().encode(currentResult);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/plain;charset=utf-8', endings: 'transparent' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = mode() === 'decrypt' ? 'enigma-text.txt' : 'enigma-ciphertext.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('message-status', 'Файл .txt подготовлен с исходными байтами UTF-8. Ключ в него не входит.');
});

$('random-key').addEventListener('click', () => {
  try {
    if (isExperimental()) applyExperimentalSettings(randomExperimentalSettings(experimentalSettings.rotors.length));
    else applySettings(randomSettings());
    recompute();
    status('key-status', isExperimental() ? 'Все проводки, кольца, старты и пары созданы заново. Экспортируйте полный ключ для получателя.' : 'Новый ключ готов. Получателю понадобятся эти же настройки.');
  } catch (error) {
    status('key-status', `Не удалось создать ключ: ${error.message}`, true);
  }
});

$('reset-key').addEventListener('click', () => {
  if (isExperimental()) {
    experimentalSettings.rotors.forEach((rotor) => { rotor.ring = 'A'; rotor.position = 'A'; });
    experimentalSettings.plugboard = '';
    plugboard.value = '';
    renderExperimentalRotors();
  } else applySettings(DEFAULT_SETTINGS);
  recompute();
  status('key-status', isExperimental() ? 'Кольца и старт всех роторов сброшены в A, пары очищены. Число роторов и проводки сохранены.' : 'Ключ сброшен: I–II–III, кольца AAA, старт AAA, без пар.');
});

$('sample-text').addEventListener('click', () => {
  reusedExactSource = null;
  message.value = isExact() ? 'Привет, ёж! 👋\nРегистр, пробелы и emoji — как в оригинале.' : 'HELLO WORLD';
  document.querySelector('input[name="mode"][value="encrypt"]').checked = true;
  recompute();
  message.focus();
  status('message-status', isExact() ? 'Добавлен пример. Нажмите «Зашифровать точный текст». Текущий ключ сохранён.' : 'Добавлен пример HELLO WORLD. Текущий ключ сохранён.');
});

$('clear-text').addEventListener('click', () => {
  message.value = '';
  reusedExactSource = null;
  recompute();
  message.focus();
});

copyButton.addEventListener('click', async () => {
  if (copyButton.disabled) return;
  const text = currentResult;
  try {
    await navigator.clipboard.writeText(text);
    status('message-status', 'Результат скопирован.');
  } catch {
    if (isExact()) {
      exactResult.focus();
      const range = document.createRange();
      range.selectNodeContents(exactResult);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      result.focus();
      result.select();
    }
    status('message-status', 'Не удалось скопировать автоматически. Текст выделен: нажмите Ctrl+C или удерживайте его для копирования.', true);
  }
});

// Preserve CR/CRLF and BOM even if the user uses the manual copy fallback.
exactResult.addEventListener('copy', (event) => {
  if (!isExact() || currentResult === null || !event.clipboardData) return;
  event.clipboardData.setData('text/plain', currentResult);
  event.preventDefault();
});

reuseButton.addEventListener('click', () => {
  if (reuseButton.disabled) return;
  const nextMode = mode() === 'encrypt' ? 'decrypt' : 'encrypt';
  const text = currentResult;
  message.value = text;
  reusedExactSource = isExact() ? text : null;
  document.querySelector(`input[name="mode"][value="${nextMode}"]`).checked = true;
  recompute();
  status('message-status', isExact() ? 'Результат подставлен без изменения символов. Ключ сохранён; нажмите кнопку обработки.' : 'Результат подставлен. Ключ и исходные позиции сохранены.');
});

shareButton.addEventListener('click', () => {
  if (!currentShareUrl || shareButton.disabled || mode() !== 'encrypt') return;
  // This only opens Telegram's official chooser; it never selects a recipient or sends.
  window.open(currentShareUrl, '_blank', 'noopener,noreferrer');
  status('message-status', 'Открывается Telegram. Выберите чат и подтвердите отправку самостоятельно.');
});

exportButton.addEventListener('click', () => {
  try {
    const experimental = isExperimental();
    const content = experimental ? serializeExperimentalSettings(readSettings()) : serializeSettings(readSettings());
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = experimental ? 'enigma-experimental-key.json' : 'enigma-key.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('key-status', experimental ? 'Файл enigma-experimental-key.json подготовлен со всеми проводками, кольцами и стартами. Сообщение в него не входит.' : 'Файл enigma-key.json подготовлен. Сообщение в него не входит.');
  } catch (error) {
    status('key-status', `Экспорт не выполнен: ${error.message}`, true);
  }
});

$('import-key').addEventListener('click', () => { keyImportSequence += 1; keyFile.value = ''; keyFile.click(); });
keyFile.addEventListener('change', async () => {
  const file = keyFile.files?.[0];
  if (!file) return;
  // A newly selected key cancels an in-flight result. Failed imports otherwise
  // leave the current, already completed result and settings untouched.
  if (pendingWorkerRequest) recompute();
  const revision = uiRevision;
  const importSequence = ++keyImportSequence;
  try {
    if (!/\.json$/i.test(file.name)) throw new Error('Выберите файл с расширением .json.');
    if (file.size > MAX_KEY_FILE_BYTES) throw new Error('Файл ключа слишком большой: допустимо не более 16 КБ.');
    if (file.size === 0) throw new Error('Файл ключа пуст.');
    const content = await file.text();
    if (revision !== uiRevision || importSequence !== keyImportSequence) return;
    let format;
    try { format = JSON.parse(content)?.format; }
    catch { throw new Error('Не удалось прочитать JSON ключа.'); }
    const experimental = format === 'enigma-experimental';
    const settings = experimental ? parseExperimentalSettings(content) : parseSettings(content);
    switchMachine(experimental ? 'experimental' : 'classic', settings);
    status('key-status', isExact() ? 'Ключ импортирован. Нажмите кнопку обработки с новыми настройками.' : 'Ключ импортирован. Сообщение пересчитано с его исходных позиций.');
  } catch (error) {
    if (revision === uiRevision && importSequence === keyImportSequence) {
      status('key-status', `Импорт не выполнен: ${error.message}`, true);
    }
  } finally {
    if (importSequence === keyImportSequence) keyFile.value = '';
  }
});

applySettings(DEFAULT_SETTINGS);
message.value = '';
recompute();
