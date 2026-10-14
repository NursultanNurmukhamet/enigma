import {
  DEFAULT_SETTINGS, validateSettings, transform, randomSettings,
  serializeSettings, parseSettings, buildTelegramShareUrl,
} from './enigma.js';

// A fixed public URL keeps key, message, query string and fragments out of shares.
const PUBLIC_URL = 'https://nursultannurmukhamet.github.io/enigma/';
const MAX_MESSAGE_LENGTH = 10000;
const MAX_SHARE_URL_LENGTH = 8000;
const MAX_KEY_FILE_BYTES = 16384;
const $ = (id) => document.getElementById(id);
const message = $('message');
const result = $('result');
const plugboard = $('plugboard');
const transliterate = $('transliterate');
const keyError = $('key-error');
const inputError = $('input-error');
const copyButton = $('copy-result');
const reuseButton = $('reuse-result');
const shareButton = $('share-telegram');
const exportButton = $('export-key');
const keyFile = $('key-file');
const rotorInputs = Array.from({ length: 3 }, (_, i) => $(`rotor-${i}`));
const ringInputs = Array.from({ length: 3 }, (_, i) => $(`ring-${i}`));
const positionInputs = Array.from({ length: 3 }, (_, i) => $(`position-${i}`));
let currentShareUrl = '';

for (const select of [...ringInputs, ...positionInputs]) {
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') select.add(new Option(letter, letter));
}

function mode() { return document.querySelector('input[name="mode"]:checked').value; }

function showError(element, text = '') {
  element.textContent = text;
  element.hidden = !text;
}

function status(id, text = '', isError = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', isError);
}

function readSettings() {
  return validateSettings({
    rotors: rotorInputs.map((input) => input.value),
    rings: ringInputs.map((input) => input.value).join(''),
    positions: positionInputs.map((input) => input.value).join(''),
    plugboard: plugboard.value,
    reflector: 'B',
  });
}

function applySettings(settings) {
  const checked = validateSettings(settings);
  rotorInputs.forEach((input, i) => { input.value = checked.rotors[i]; });
  ringInputs.forEach((input, i) => { input.value = checked.rings[i]; });
  positionInputs.forEach((input, i) => { input.value = checked.positions[i]; });
  plugboard.value = checked.plugboard;
}

function recompute() {
  const decrypting = mode() === 'decrypt';
  $('input-label').textContent = decrypting ? 'Полученный шифртекст' : 'Исходный текст';
  $('output-label').textContent = decrypting ? 'Расшифрованный текст' : 'Шифртекст';
  message.placeholder = decrypting ? 'Вставьте шифртекст и задайте ключ отправителя' : 'Например, HELLO WORLD';
  transliterate.disabled = decrypting;
  $('input-count').textContent = `${message.value.length.toLocaleString('ru-RU')} / 10 000`;
  showError(keyError);
  showError(inputError);
  message.removeAttribute('aria-invalid');
  plugboard.removeAttribute('aria-invalid');
  rotorInputs.forEach((input) => input.removeAttribute('aria-invalid'));
  result.value = '';
  currentShareUrl = '';
  copyButton.disabled = true;
  reuseButton.disabled = true;
  shareButton.disabled = true;
  exportButton.disabled = false;
  status('message-status');

  let settings;
  try {
    settings = readSettings();
  } catch (error) {
    showError(keyError, error.message);
    const duplicateRotors = new Set(rotorInputs.map((input) => input.value)).size !== 3;
    if (duplicateRotors) rotorInputs.forEach((input) => input.setAttribute('aria-invalid', 'true'));
    else plugboard.setAttribute('aria-invalid', 'true');
    exportButton.disabled = true;
    $('share-help').textContent = 'Исправьте настройки ключа, чтобы получить результат.';
    return;
  }
  try {
    // transform creates a new machine at the original positions on every call.
    const transformed = transform(message.value, settings, { transliterateRussian: !decrypting && transliterate.checked });
    if (transformed.length > MAX_MESSAGE_LENGTH) {
      throw new Error('После перевода в латиницу сообщение длиннее 10 000 символов. Сократите исходный текст: некоторые русские буквы превращаются в несколько латинских.');
    }
    result.value = transformed;
  } catch (error) {
    showError(inputError, error.message);
    message.setAttribute('aria-invalid', 'true');
    $('share-help').textContent = 'Исправьте текст, чтобы получить результат.';
    return;
  }

  const hasResult = result.value.length > 0;
  copyButton.disabled = !hasResult;
  reuseButton.disabled = !hasResult;
  if (decrypting) {
    $('share-help').textContent = 'В режиме расшифровки отправка в Telegram отключена.';
  } else if (!/[A-Z]/.test(result.value)) {
    $('share-help').textContent = 'Введите сообщение с буквами, чтобы поделиться шифртекстом.';
  } else {
    try {
      const shareUrl = buildTelegramShareUrl(result.value, PUBLIC_URL);
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

for (const input of [...rotorInputs, ...ringInputs, ...positionInputs, plugboard]) {
  input.addEventListener('input', () => { status('key-status'); recompute(); });
}
message.addEventListener('input', recompute);
transliterate.addEventListener('change', recompute);
for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener('change', recompute);

$('random-key').addEventListener('click', () => {
  try {
    applySettings(randomSettings());
    recompute();
    status('key-status', 'Новый ключ готов. Получателю понадобятся эти же настройки.');
  } catch (error) {
    status('key-status', `Не удалось создать ключ: ${error.message}`, true);
  }
});

$('reset-key').addEventListener('click', () => {
  applySettings(DEFAULT_SETTINGS);
  recompute();
  status('key-status', 'Ключ сброшен: I–II–III, кольца AAA, старт AAA, без пар.');
});

$('sample-text').addEventListener('click', () => {
  message.value = 'HELLO WORLD';
  document.querySelector('input[name="mode"][value="encrypt"]').checked = true;
  recompute();
  message.focus();
  status('message-status', 'Добавлен пример HELLO WORLD. Текущий ключ сохранён.');
});

$('clear-text').addEventListener('click', () => {
  message.value = '';
  recompute();
  message.focus();
});

copyButton.addEventListener('click', async () => {
  if (copyButton.disabled) return;
  const text = result.value;
  try {
    await navigator.clipboard.writeText(text);
    status('message-status', 'Результат скопирован.');
  } catch {
    result.focus();
    result.select();
    status('message-status', 'Не удалось скопировать автоматически. Текст выделен: нажмите Ctrl+C или удерживайте его для копирования.', true);
  }
});

reuseButton.addEventListener('click', () => {
  if (reuseButton.disabled) return;
  const nextMode = mode() === 'encrypt' ? 'decrypt' : 'encrypt';
  message.value = result.value;
  document.querySelector(`input[name="mode"][value="${nextMode}"]`).checked = true;
  recompute();
  status('message-status', 'Результат подставлен. Ключ и исходные позиции сохранены.');
});

shareButton.addEventListener('click', () => {
  if (!currentShareUrl || shareButton.disabled || mode() !== 'encrypt') return;
  // This only opens Telegram's official chooser; it never selects a recipient or sends.
  window.open(currentShareUrl, '_blank', 'noopener,noreferrer');
  status('message-status', 'Открывается Telegram. Выберите чат и подтвердите отправку самостоятельно.');
});

exportButton.addEventListener('click', () => {
  try {
    const content = serializeSettings(readSettings());
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'enigma-key.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('key-status', 'Файл enigma-key.json подготовлен. Сообщение в него не входит.');
  } catch (error) {
    status('key-status', `Экспорт не выполнен: ${error.message}`, true);
  }
});

$('import-key').addEventListener('click', () => { keyFile.value = ''; keyFile.click(); });
keyFile.addEventListener('change', async () => {
  const file = keyFile.files?.[0];
  if (!file) return;
  try {
    if (!/\.json$/i.test(file.name)) throw new Error('Выберите файл с расширением .json.');
    if (file.size > MAX_KEY_FILE_BYTES) throw new Error('Файл ключа слишком большой: допустимо не более 16 КБ.');
    if (file.size === 0) throw new Error('Файл ключа пуст.');
    const settings = parseSettings(await file.text());
    applySettings(settings);
    recompute();
    status('key-status', 'Ключ импортирован. Сообщение пересчитано с его исходных позиций.');
  } catch (error) {
    status('key-status', `Импорт не выполнен: ${error.message}`, true);
  } finally {
    keyFile.value = '';
  }
});

applySettings(DEFAULT_SETTINGS);
message.value = '';
recompute();
