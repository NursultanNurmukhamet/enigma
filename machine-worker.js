import { encryptExact, decryptExact } from './exact-text.js';

// Only the nonhistorical machine uses this reusable worker. No network or storage.
self.addEventListener('message', ({ data }) => {
  const { id, operation, text, settings } = data || {};
  if (!Number.isSafeInteger(id)) return;
  try {
    if (!['encrypt', 'decrypt'].includes(operation)) throw new Error('Неизвестное действие обработки.');
    const process = operation === 'encrypt' ? encryptExact : decryptExact;
    const output = process(text, settings, { machine: 'experimental' });
    self.postMessage({ id, ok: true, text: output });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'Не удалось обработать сообщение.' });
  }
});
