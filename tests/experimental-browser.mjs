/** Experimental machine browser QA. Installed Playwright/Chrome only.
 * Worker calculations remain real; selected responses can be held to test races.
 * Telegram window.open is intercepted; no recipient or send action is performed.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { encryptExact, MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH } from '../exact-text.js';
import { randomExperimentalSettings, serializeExperimentalSettings } from '../experimental.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.argv[2] || 'http://127.0.0.1:4173/';
const outputDir = fileURLToPath(new URL('../output/experimental-playwright/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const launch = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launch.executablePath = process.env.BROWSER_EXECUTABLE;
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
await context.addInitScript(() => {
  window.__capturedShare = [];
  window.open = (...args) => { window.__capturedShare.push(args); return null; };
  window.__workerRequests = [];
  window.__workerInstances = [];
  window.__heldWorkerResponses = [];
  window.__holdWorkerResponses = false;
  window.__fileReads = [];
  window.__heldFileTextNames = [];
  window.__heldFileReads = [];
  for (const method of ['text', 'arrayBuffer']) {
    const original = File.prototype[method];
    File.prototype[method] = function (...args) {
      window.__fileReads.push({ method, name: this.name, size: this.size });
      const reading = original.apply(this, args);
      if (method === 'text' && window.__heldFileTextNames.includes(this.name)) {
        const name = this.name;
        return new Promise((resolve, reject) => {
          window.__heldFileReads.push({ name, release: () => reading.then(resolve, reject), reject: () => reject(new Error('Delayed test read failure')) });
        });
      }
      return reading;
    };
  }
  const NativeWorker = window.Worker;
  // The facade forwards all actual computation to a native module Worker. Only
  // delivery can be held, making stale-response checks deterministic.
  window.Worker = class ObservedWorker extends EventTarget {
    constructor(...args) {
      super();
      this.native = new NativeWorker(...args);
      this.native.addEventListener('message', event => {
        const record = window.__workerRequests.find(item => item.id === event.data.id);
        if (record) { record.durationMs = performance.now() - record.started; record.finished = true; }
        const deliver = () => {
          const forwarded = new MessageEvent('message', { data: event.data });
          this.dispatchEvent(forwarded);
          this.onmessage?.(forwarded);
        };
        if (window.__holdWorkerResponses) window.__heldWorkerResponses.push(deliver);
        else deliver();
      });
      this.native.addEventListener('error', event => {
        const forwarded = new ErrorEvent('error', { message: event.message });
        this.dispatchEvent(forwarded);
        this.onerror?.(forwarded);
      });
      window.__workerInstances.push(this);
    }
    postMessage(data, ...rest) {
      window.__workerRequests.push({ id: data.id, operation: data.operation, started: performance.now(), heartbeats: 0, finished: false });
      this.native.postMessage(data, ...rest);
    }
    terminate() { this.native.terminate(); }
  };
  window.__releaseWorkerResponses = () => {
    window.__holdWorkerResponses = false;
    for (const deliver of window.__heldWorkerResponses.splice(0)) deliver();
  };
  setInterval(() => {
    for (const request of window.__workerRequests) if (!request.finished) request.heartbeats += 1;
  }, 5);
});
const page = await context.newPage();
const network = [], pageErrors = [];
page.on('request', request => network.push({ method: request.method(), url: request.url() }));
page.on('pageerror', error => pageErrors.push(error.message));
const report = { baseURL, startedAt: new Date().toISOString(), checks: [], layouts: [], pageErrors };
let failures = 0;
const $ = id => page.locator(`#${id}`);
const classicKey = { rotors: ['I', 'II', 'III'], rings: 'AAA', positions: 'AAA', plugboard: '', reflector: 'B' };
const source = 'Привет, Ёж! ё/Ё и AbC\n  e\u0301 ≠ é\t👩🏽‍💻 <b>не HTML</b>\n';

async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function check(name, fn) {
  try {
    const detail = await fn();
    report.checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    report.checks.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: resolve(outputDir, `failure-${failures}.png`), fullPage: true }).catch(() => {});
    await page.evaluate(() => window.__releaseWorkerResponses()).catch(() => {});
  }
}
async function pending() {
  assert.equal(await $('exact-result').textContent(), '');
  for (const id of ['copy-result', 'reuse-result', 'share-telegram', 'download-result']) assert.equal(await $(id).isDisabled(), true, id);
}
async function processExact() {
  await $('process-exact').click();
  await page.waitForFunction(() => document.getElementById('exact-result').getAttribute('aria-busy') !== 'true' && !document.getElementById('process-exact').disabled);
  await settle();
}
async function experimental(count = 30) {
  await page.evaluate(() => window.__releaseWorkerResponses());
  await $('machine-mode').selectOption('experimental');
  await $('rotor-count').selectOption(String(count));
  await page.locator('[name="mode"][value="encrypt"]').check();
  await $('clear-text').click();
}
async function readKey() {
  return page.evaluate(() => ({
    rotors: [...document.querySelectorAll('#experimental-rotors input[id^="experimental-wiring-"]')].map((element, i) => ({
      wiring: element.value,
      ring: document.getElementById(`experimental-ring-${i}`).value,
      position: document.getElementById(`experimental-position-${i}`).value,
    })), reflector: 'B', stepping: 'odometer-v1', plugboard: document.getElementById('plugboard').value,
  }));
}
async function openRotor(index) {
  const group = page.locator('#experimental-rotors details.rotor-group').nth(Math.floor(index / 5));
  if (await group.getAttribute('open') === null) await group.locator('summary').click();
}
async function importKey(json, name = 'enigma-key.json') {
  const chooserEvent = page.waitForEvent('filechooser');
  await $('import-key').click();
  await (await chooserEvent).setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.waitForFunction(() => document.getElementById('key-file').value === '' && document.getElementById('key-status').textContent.length > 0);
  await settle();
}
async function beginHeldKeyImport(json) {
  await page.evaluate(() => { window.__heldFileTextNames = ['slow-a.json']; window.__heldFileReads = []; });
  const chooserEvent = page.waitForEvent('filechooser');
  await $('import-key').click();
  await (await chooserEvent).setFiles({ name: 'slow-a.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.waitForFunction(() => window.__heldFileReads.length === 1);
}
async function releaseKeyImport(reject = false) {
  await page.evaluate(reject => {
    window.__heldFileTextNames = [];
    for (const reading of window.__heldFileReads.splice(0)) reading[reject ? 'reject' : 'release']();
  }, reject);
  await settle();
}
async function importText(bytes) {
  const chooserEvent = page.waitForEvent('filechooser');
  await $('import-text').click();
  await (await chooserEvent).setFiles({ name: 'message.txt', mimeType: 'text/plain', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => document.getElementById('text-file').value === '' && document.getElementById('message-status').textContent.length > 0);
}
async function download(id) {
  const event = page.waitForEvent('download');
  await $(id).click();
  const result = await event;
  return { name: result.suggestedFilename(), bytes: await readFile(await result.path()) };
}
async function encrypt(text = source) {
  await page.locator('[name="mode"][value="encrypt"]').check();
  await $('message').fill(text);
  await processExact();
  assert.equal(await $('input-error').isVisible(), false);
  const cipher = await $('exact-result').textContent();
  assert.match(cipher, /^ENIGMA-X-UTF8-1:[A-Z]+$/);
  return cipher;
}
async function reuseDecrypt(text = source) {
  await $('reuse-result').click();
  await pending();
  await processExact();
  assert.equal(await $('exact-result').textContent(), text);
  assert.equal(await $('share-telegram').isDisabled(), true);
}
function validKey(key, count) {
  assert.equal(key.rotors.length, count);
  assert.equal(new Set(key.rotors.map(rotor => rotor.wiring)).size, count);
  for (const rotor of key.rotors) {
    assert.equal([...rotor.wiring].sort().join(''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    assert.match(rotor.ring, /^[A-Z]$/);
    assert.match(rotor.position, /^[A-Z]$/);
  }
  assert.equal(key.reflector, 'B');
  assert.equal(key.stepping, 'odometer-v1');
}
async function holdRequest() {
  await page.evaluate(() => { window.__holdWorkerResponses = true; });
  await $('process-exact').click();
  await page.waitForFunction(() => window.__heldWorkerResponses.length > 0);
  assert.equal(await $('exact-result').getAttribute('aria-busy'), 'true');
  assert.equal(await $('process-exact').isDisabled(), true);
  await pending();
}
async function layout(width, state) {
  await page.setViewportSize({ width, height: 900 });
  await settle();
  const details = await page.evaluate(() => {
    const issues = [];
    let inspected = 0;
    const vw = document.documentElement.clientWidth;
    const visible = element => { const s = getComputedStyle(element), r = element.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 2 && r.height > 2 && element.checkVisibility(); };
    const name = element => element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${String(element.className).replaceAll(' ', '.')}`;
    for (const element of document.body.querySelectorAll('*')) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      if (style.position === 'absolute' && (style.clip !== 'auto' || style.clipPath !== 'none')) continue;
      inspected += 1;
      const r = element.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) issues.push({ element: name(element), kind: 'viewport', left: r.left, right: r.right });
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && !['TEXTAREA', 'SELECT', 'INPUT'].includes(element.tagName)) issues.push({ element: name(element), kind: 'self-overflow', scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
      const parent = element.parentElement;
      if (!parent || !visible(parent) || ['BODY', 'HTML'].includes(parent.tagName) || getComputedStyle(parent).display === 'inline') continue;
      const p = parent.getBoundingClientRect();
      if (r.left < p.left - 1 || r.right > p.right + 1) issues.push({ element: name(element), parent: name(parent), kind: 'parent-containment', left: r.left, right: r.right, parentLeft: p.left, parentRight: p.right });
    }
    return { width: vw, inspected, issues, pageScrollWidth: document.documentElement.scrollWidth };
  });
  report.layouts.push({ state, ...details });
  assert.deepEqual(details.issues, [], JSON.stringify(details.issues));
  assert.equal(details.pageScrollWidth, width);
  await page.screenshot({ path: resolve(outputDir, `${state}-${width}.png`), fullPage: true });
  return details.inspected;
}

try {
  const response = await page.goto(baseURL, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await settle();
  const afterLoad = network.length;
  await check('Classic default; experiment explicitly labelled, exact-only, 3–30 count, grouped rotors', async () => {
    assert.equal(await $('machine-mode').inputValue(), 'classic');
    assert.equal(await $('experimental-settings').isVisible(), false);
    await $('machine-mode').selectOption('experimental');
    assert.equal(await $('text-format').inputValue(), 'exact');
    assert.equal(await $('text-format').isDisabled(), true);
    assert.equal(await $('rotor-count').inputValue(), '30');
    assert.deepEqual(await $('rotor-count').locator('option').evaluateAll(options => options.map(option => Number(option.value))), Array.from({ length: 28 }, (_, i) => i + 3));
    assert.equal(await page.locator('#experimental-rotors details.rotor-group').count(), 6);
    assert.equal(await page.locator('#experimental-rotors details.rotor-group[open]').count(), 1);
    assert.match(await $('experimental-settings').textContent(), /не.*истор|эксперимент/i);
    await pending();
  });
  for (const count of [3, 8, 30]) {
    await check(`${count} experimental rotors: exact Unicode round trip with complete key`, async () => {
      await experimental(count);
      await $('random-key').click();
      const key = await readKey();
      validKey(key, count);
      assert.equal(key.plugboard.split(' ').length, 10);
      assert.equal(new Set(key.plugboard.replaceAll(' ', '')).size, 20);
      const cipher = await encrypt();
      assert.equal(cipher, encryptExact(source, key, { machine: 'experimental' }));
      await reuseDecrypt();
      assert.equal(await $('exact-result').locator('*').count(), 0);
      assert.deepEqual(await readKey(), key);
      return { rotorCount: count, cipherLength: cipher.length };
    });
  }
  await check('First and last rotor ring/start each alter ciphertext and invalidate output', async () => {
    await experimental(30);
    const baseline = await encrypt();
    for (const index of [0, 29]) {
      await openRotor(index);
      for (const field of ['ring', 'position']) {
        const control = $(`experimental-${field}-${index}`);
        const old = await control.inputValue();
        await control.selectOption(old === 'A' ? 'B' : 'A');
        await pending();
        await processExact();
        assert.notEqual(await $('exact-result').textContent(), baseline, `${field} ${index}`);
        await control.selectOption(old);
        await processExact();
        assert.equal(await $('exact-result').textContent(), baseline);
      }
    }
  });
  await check('Count changes and preset30 preserve existing rotor prefix; reset clears all windows/rings', async () => {
    await experimental(8);
    const prefix = (await readKey()).rotors;
    await $('preset-30').click();
    assert.equal(await $('rotor-count').inputValue(), '30');
    assert.deepEqual((await readKey()).rotors.slice(0, 8), prefix);
    await $('rotor-count').selectOption('3');
    assert.deepEqual((await readKey()).rotors, prefix.slice(0, 3));
    await $('preset-30').click();
    const before = await readKey();
    await $('reset-key').click();
    const after = await readKey();
    assert.deepEqual(after.rotors.map(rotor => rotor.wiring), before.rotors.map(rotor => rotor.wiring));
    assert.equal(after.rotors.every(rotor => rotor.ring === 'A' && rotor.position === 'A'), true);
    assert.equal(after.plugboard, '');
    await $('random-key').click();
    const randomized = await readKey();
    validKey(randomized, 30);
    assert.equal(randomized.rotors.every((rotor, i) => rotor.wiring !== after.rotors[i].wiring), true);
  });
  let exported;
  await check('Export/import complete30-rotor versioned key only; restoration is exact', async () => {
    await experimental(30);
    const cipher = await encrypt();
    const key = await readKey();
    const file = await download('export-key');
    exported = file.bytes.toString('utf8');
    const parsed = JSON.parse(exported);
    assert.deepEqual(Object.keys(parsed), ['format', 'version', 'settings']);
    assert.equal(parsed.format, 'enigma-experimental');
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.settings, key);
    assert.equal(exported.includes(source), false);
    assert.equal(exported.includes(cipher), false);
    await $('random-key').click();
    await importKey(exported);
    await pending();
    assert.deepEqual(await readKey(), key);
    await processExact();
    assert.equal(await $('exact-result').textContent(), cipher);
  });
  await check('Old classic key imports atomically switch machine; experimental key restores it', async () => {
    await importKey(JSON.stringify({ format: 'enigma-i', version: 1, settings: classicKey }));
    assert.equal(await $('machine-mode').inputValue(), 'classic');
    await $('text-format').selectOption('legacy');
    await $('message').fill('AAAAA');
    assert.equal(await $('result').inputValue(), 'BDZGO');
    await importKey(exported);
    assert.equal(await $('machine-mode').inputValue(), 'experimental');
    assert.equal(await $('text-format').inputValue(), 'exact');
    assert.equal(await $('rotor-count').inputValue(), '30');
    await pending();
  });
  await check('Invalid duplicate or incomplete wiring blocks process and export', async () => {
    await experimental(3);
    await encrypt();
    const original = await $('experimental-wiring-1').inputValue();
    for (const bad of [await $('experimental-wiring-0').inputValue(), 'A'.repeat(26), 'ABCDE', 'ABCDEFGHIJKLMNOPQRSTUVWXY1']) {
      await $('experimental-wiring-1').fill(bad);
      await pending();
      assert.equal(await $('key-error').isVisible(), true);
      assert.equal(await $('export-key').isDisabled(), true);
    }
    await $('experimental-wiring-1').fill(original);
    await processExact();
    await reuseDecrypt();
  });
  await check('Bad experimental keys, count31, unknown fields and oversized input rejected atomically', async () => {
    await importKey(exported);
    const before = await readKey();
    const valid = JSON.parse(exported);
    const duplicate = structuredClone(valid); duplicate.settings.rotors[1].wiring = duplicate.settings.rotors[0].wiring;
    const count31 = structuredClone(valid); count31.settings.rotors.push(structuredClone(count31.settings.rotors[0]));
    const cases = ['{', JSON.stringify({ ...valid, version: 2 }), JSON.stringify(duplicate), JSON.stringify(count31), JSON.stringify({ ...valid, settings: { ...valid.settings, stepping: 'double-step' } }), JSON.stringify({ ...valid, settings: { ...valid.settings, source: 'LEAK' } }), ' '.repeat(16385)];
    for (const json of cases) {
      const readsBefore = await page.evaluate(() => window.__fileReads.length);
      await importKey(json);
      if (json.length > 16384) assert.equal(await page.evaluate(() => window.__fileReads.length), readsBefore, 'oversized key must be rejected before reading');
      assert.equal(await $('key-status').evaluate(element => element.classList.contains('error')), true);
      assert.equal(await $('machine-mode').inputValue(), 'experimental');
      assert.deepEqual(await readKey(), before);
    }
    return { rejectedCases: cases.length };
  });
  await check('Delayed key import cannot overwrite a later manual key or machine edit', async () => {
    const incoming = serializeExperimentalSettings(randomExperimentalSettings(3));
    await experimental(8);
    await beginHeldKeyImport(incoming);
    const current = await $('experimental-position-0').inputValue();
    await $('experimental-position-0').selectOption(current === 'Z' ? 'A' : 'Z');
    const edited = await readKey();
    const editedStatus = await $('key-status').textContent();
    await releaseKeyImport();
    assert.deepEqual(await readKey(), edited);
    assert.equal(await $('key-status').textContent(), editedStatus);
    await beginHeldKeyImport(incoming);
    await $('machine-mode').selectOption('classic');
    const switchedStatus = await $('key-status').textContent();
    await releaseKeyImport();
    assert.equal(await $('machine-mode').inputValue(), 'classic');
    assert.equal(await $('key-status').textContent(), switchedStatus);
  });
  await check('Later key import B wins over delayed successful or rejected import A', async () => {
    const first = serializeExperimentalSettings(randomExperimentalSettings(3));
    const secondKey = randomExperimentalSettings(8);
    const second = serializeExperimentalSettings(secondKey);
    for (const rejected of [false, true]) {
      await experimental(30);
      await beginHeldKeyImport(first);
      await importKey(second, 'newer-b.json');
      assert.deepEqual(await readKey(), secondKey);
      const latestStatus = await $('key-status').textContent();
      await releaseKeyImport(rejected);
      assert.deepEqual(await readKey(), secondKey);
      assert.equal(await $('machine-mode').inputValue(), 'experimental');
      assert.equal(await $('key-status').textContent(), latestStatus);
      assert.equal(await $('key-status').evaluate(element => element.classList.contains('error')), false);
    }
  });
  await check('Classic and experimental containers are rejected under the wrong machine', async () => {
    await experimental(3);
    const cipher = await encrypt();
    const classicCipher = encryptExact(source, classicKey);
    await page.locator('[name="mode"][value="decrypt"]').check();
    await $('message').fill(classicCipher);
    await processExact();
    await pending();
    assert.equal(await $('input-error').isVisible(), true);
    await $('machine-mode').selectOption('classic');
    await $('text-format').selectOption('exact');
    await $('message').fill(cipher);
    await processExact();
    await pending();
    assert.equal(await $('input-error').isVisible(), true);
  });
  await check('Wrong experimental key and damaged container fail without stale plaintext', async () => {
    await experimental(8);
    const cipher = await encrypt();
    await reuseDecrypt();
    await $('random-key').click();
    await pending();
    await processExact();
    assert.equal(await $('input-error').isVisible(), true);
    await pending();
    await $('message').fill(cipher.slice(0, -1) + '!');
    await processExact();
    assert.equal(await $('input-error').isVisible(), true);
    await pending();
  });
  await check('Empty experimental source round trip is successful and downloadable', async () => {
    await experimental(3);
    await encrypt('');
    await reuseDecrypt('');
    assert.match(await $('exact-state').textContent(), /Пустой текст.*0 байт/);
    const file = await download('download-result');
    assert.equal(file.bytes.length, 0);
  });
  await check('Experimental TXT preserves BOM/CRLF/CR/NUL and byte-exact downloads', async () => {
    const raw = '\uFEFFЁж\r\nе\u0301\r👩🏽‍💻\n\u0000';
    await experimental(30);
    await importText(Buffer.from(raw));
    await processExact();
    const encrypted = await download('download-result');
    await page.locator('[name="mode"][value="decrypt"]').check();
    await importText(encrypted.bytes);
    await processExact();
    assert.equal(await $('exact-result').textContent(), raw);
    const decrypted = await download('download-result');
    assert.deepEqual(decrypted.bytes, Buffer.from(raw));
  });
  await check('Experimental oversized source/cipher files rejected before reading; invalid UTF-8 rejects', async () => {
    await experimental(30);
    await encrypt();
    let readsBefore = await page.evaluate(() => window.__fileReads.length);
    await importText(Buffer.alloc(10001, 65));
    assert.equal(await page.evaluate(() => window.__fileReads.length), readsBefore);
    assert.equal(await $('message-status').evaluate(element => element.classList.contains('error')), true);
    await pending();
    await importText(Buffer.from([0xC3, 0x28]));
    assert.equal(await $('message-status').evaluate(element => element.classList.contains('error')), true);
    await pending();
    await page.locator('[name="mode"][value="decrypt"]').check();
    readsBefore = await page.evaluate(() => window.__fileReads.length);
    await importText(Buffer.alloc(MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH + 1, 65));
    assert.equal(await page.evaluate(() => window.__fileReads.length), readsBefore);
    assert.equal(await $('message-status').evaluate(element => element.classList.contains('error')), true);
    await pending();
  });
  await check('Worker busy response is ignored after text, key, count, direction or machine changes', async () => {
    const changes = [
      ['text', () => $('message').fill('Новое сообщение')],
      ['key', () => $('experimental-ring-0').selectOption('Z')],
      ['count', () => $('rotor-count').selectOption('8')],
      ['direction', () => page.locator('[name="mode"][value="decrypt"]').check()],
      ['machine', () => $('machine-mode').selectOption('classic')],
    ];
    for (const [name, change] of changes) {
      await experimental(30);
      await $('message').fill(source);
      await holdRequest();
      await change();
      await page.evaluate(() => window.__releaseWorkerResponses());
      await settle();
      assert.equal(await $('exact-result').textContent(), '', name);
      assert.equal(await $('share-telegram').isDisabled(), true, name);
      assert.equal(await $('copy-result').isDisabled(), true, name);
    }
    return { staleChanges: changes.map(([name]) => name) };
  });
  await check('Earlier worker response cannot replace the result of a newer request', async () => {
    await experimental(30);
    await $('message').fill('Первое');
    await holdRequest();
    await $('message').fill('Второе');
    await page.evaluate(() => { window.__holdWorkerResponses = false; });
    await processExact();
    const latest = await $('exact-result').textContent();
    assert.equal(latest, encryptExact('Второе', await readKey(), { machine: 'experimental' }));
    await page.evaluate(() => window.__releaseWorkerResponses());
    await settle();
    assert.equal(await $('exact-result').textContent(), latest);
  });
  await check('30 rotors ×10000 bytes uses a reusable native Worker with responsive main thread', async () => {
    await experimental(30);
    await $('message').fill('ё'.repeat(5000));
    await page.evaluate(() => {
      window.__longTasks = [];
      window.__perfObserver = new PerformanceObserver(list => { window.__longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))); });
      window.__perfObserver.observe({ type: 'longtask', buffered: false });
    });
    await processExact();
    const cipher = await $('exact-result').textContent();
    assert.equal(cipher.length, MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH);
    assert.equal(await $('share-telegram').isDisabled(), true);
    const performance = await page.evaluate(() => {
      window.__perfObserver.disconnect();
      return { request: window.__workerRequests.at(-1), workerCount: window.__workerInstances.length, longTasks: window.__longTasks };
    });
    assert.equal(performance.workerCount, 1);
    assert.ok(performance.request.heartbeats > 0, 'main-thread timers must run during Worker computation');
    assert.deepEqual(performance.longTasks, [], JSON.stringify(performance.longTasks));
    await reuseDecrypt('ё'.repeat(5000));
    assert.equal(await $('message').getAttribute('maxlength'), String(MAX_EXPERIMENTAL_EXACT_CIPHERTEXT_LENGTH));
    report.performance = performance;
    return performance;
  });
  await check('Experimental Telegram URL is only ciphertext plus public site; never opened', async () => {
    await experimental(30);
    const cipher = await encrypt();
    await $('share-telegram').click();
    const captured = await page.evaluate(() => window.__capturedShare);
    assert.equal(captured.length, 1);
    const [address, target, features] = captured[0];
    const url = new URL(address);
    assert.equal(url.origin, 'https://t.me');
    assert.equal(url.pathname, '/share/url');
    assert.deepEqual([...url.searchParams.keys()], ['url', 'text']);
    assert.equal(url.searchParams.get('url'), 'https://nursultannurmukhamet.github.io/enigma/');
    assert.equal(url.searchParams.get('text'), cipher);
    assert.equal(address.includes(encodeURIComponent(source)), false);
    assert.equal(target, '_blank');
    assert.equal(features, 'noopener,noreferrer');
    assert.equal(context.pages().length, 1);
  });
  await check('No requests after initial static assets for typing, Worker operations, keys or share', async () => {
    assert.equal(network.every(request => new URL(request.url).origin === new URL(baseURL).origin), true);
    assert.deepEqual(network.slice(afterLoad), []);
    return { initialRequests: afterLoad, afterInputRequests: network.length - afterLoad };
  });
  for (const width of [320, 360, 390, 768, 1280]) {
    await check(`30-rotor mobile containment ${width}px: collapsed, expanded, busy, success, error`, async () => {
      await experimental(30);
      for (const group of await page.locator('#experimental-rotors details.rotor-group').all()) {
        if (await group.getAttribute('open') !== null) await group.locator('summary').click();
      }
      const counts = [await layout(width, 'collapsed')];
      for (const group of await page.locator('#experimental-rotors details.rotor-group').all()) await group.locator('summary').click();
      counts.push(await layout(width, 'expanded'));
      await $('message').fill(source);
      await holdRequest();
      counts.push(await layout(width, 'busy'));
      await page.evaluate(() => window.__releaseWorkerResponses());
      await page.waitForFunction(() => document.getElementById('exact-result').getAttribute('aria-busy') !== 'true');
      counts.push(await layout(width, 'success'));
      await $('experimental-wiring-29').fill('A'.repeat(26));
      counts.push(await layout(width, 'error'));
      await $('random-key').click();
      return { inspectedElementsPerState: counts };
    });
  }
  await check('Experimental messages and keys are not persisted; reload is classic defaults', async () => {
    assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie })), { local: {}, session: {}, cookies: '' });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await $('machine-mode').inputValue(), 'classic');
    assert.equal(await $('message').inputValue(), '');
    await $('message').fill('AAAAA');
    assert.equal(await $('result').inputValue(), 'BDZGO');
  });
  await check('No uncaught browser errors', async () => assert.deepEqual(pageErrors, []));
} catch (error) {
  failures += 1;
  report.checks.push({ name: 'Browser harness completed', passed: false, error: error.stack });
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter(check => check.passed).length;
  report.failed = failures;
  await writeFile(resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
if (failures) process.exitCode = 1;
