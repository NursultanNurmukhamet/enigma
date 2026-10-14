/** Exact-text browser acceptance tests. Uses an installed Playwright and Chrome only.
 * Run with the same PLAYWRIGHT_MODULE/BROWSER_EXECUTABLE as tests/browser.mjs.
 * Telegram is stubbed before any click; this suite never opens it or sends messages.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { encryptExact, MAX_EXACT_BYTES, MAX_EXACT_CIPHERTEXT_LENGTH } from '../exact-text.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.argv[2] || 'http://127.0.0.1:4173/';
const publicSiteURL = 'https://nursultannurmukhamet.github.io/enigma/';
const outputDir = fileURLToPath(new URL('../output/exact-playwright/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const launch = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launch.executablePath = process.env.BROWSER_EXECUTABLE;
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
await context.addInitScript(() => {
  window.__capturedShare = [];
  window.open = (...args) => { window.__capturedShare.push(args); return null; };
});
const page = await context.newPage();
const network = [];
const pageErrors = [];
page.on('request', request => network.push({ method: request.method(), url: request.url() }));
page.on('pageerror', error => pageErrors.push(error.message));
const report = { baseURL, startedAt: new Date().toISOString(), checks: [], layouts: [], pageErrors };
let failures = 0;
const $ = id => page.locator(`#${id}`);
const baseKey = { rotors: ['I', 'II', 'III'], rings: 'AAA', positions: 'AAA', plugboard: '', reflector: 'B' };
const mixed = 'Привет, Ёж! ё/Ё — AbC xYz\n  Пробелы\tи знаки: <>&"\' + 123\n👩🏽‍💻 👨‍👩‍👧‍👦 🏳️‍🌈 中文 العربية\n';

async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
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
  }
}
async function exactBaseline(direction = 'encrypt') {
  await $('text-format').selectOption('exact');
  await page.locator(`[name="mode"][value="${direction}"]`).check();
  await $('reset-key').click();
  await $('clear-text').click();
}
async function expectPending() {
  assert.equal(await $('exact-result').textContent(), '');
  assert.equal(await $('result').inputValue(), '');
  for (const id of ['copy-result', 'reuse-result', 'share-telegram', 'download-result']) assert.equal(await $(id).isDisabled(), true, id);
}
async function expectFailure() {
  await expectPending();
  assert.equal(await $('input-error').isVisible(), true);
  assert.ok((await $('input-error').textContent()).length > 0);
  assert.equal(await $('message').getAttribute('aria-invalid'), 'true');
}
async function execute() {
  await $('process-exact').click();
  await settle();
}
async function encryptInput(text) {
  await exactBaseline();
  await $('message').fill(text);
  await execute();
  assert.equal(await $('input-error').isVisible(), false);
  return $('exact-result').textContent();
}
async function reuseDecrypt(source) {
  await $('reuse-result').click();
  assert.equal(await page.locator('[name="mode"][value="decrypt"]').isChecked(), true);
  await expectPending();
  await execute();
  assert.equal(await $('exact-result').textContent(), source);
  assert.equal(await $('input-error').isVisible(), false);
  assert.equal(await $('copy-result').isEnabled(), true);
  assert.equal(await $('reuse-result').isEnabled(), true);
  assert.equal(await $('share-telegram').isDisabled(), true);
}
async function importKey(content) {
  const chooserEvent = page.waitForEvent('filechooser');
  await $('import-key').click();
  await (await chooserEvent).setFiles({ name: 'enigma-key.json', mimeType: 'application/json', buffer: Buffer.from(content) });
  await page.waitForFunction(() => document.getElementById('key-file').value === '' && document.getElementById('key-status').textContent.length > 0);
}
async function importText(bytes, name = 'message.txt') {
  const chooserEvent = page.waitForEvent('filechooser');
  await $('import-text').click();
  await (await chooserEvent).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => document.getElementById('text-file').value === '' && document.getElementById('message-status').textContent.length > 0);
  await settle();
}
async function downloadResult() {
  const downloadEvent = page.waitForEvent('download');
  await $('download-result').click();
  const download = await downloadEvent;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}
async function layoutAt(width, state) {
  await page.setViewportSize({ width, height: 900 });
  await settle();
  const result = await page.evaluate(() => {
    const issues = [];
    let inspected = 0;
    const viewportWidth = document.documentElement.clientWidth;
    const visible = element => {
      const style = getComputedStyle(element), r = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 2 && r.height > 2;
    };
    const name = element => element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${String(element.className).replaceAll(' ', '.')}`;
    for (const element of document.body.querySelectorAll('*')) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      if (style.position === 'absolute' && (style.clip !== 'auto' || style.clipPath !== 'none')) continue;
      inspected += 1;
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > viewportWidth + 1) issues.push({ element: name(element), kind: 'viewport', left: rect.left, right: rect.right });
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && !['TEXTAREA', 'SELECT', 'INPUT'].includes(element.tagName)) issues.push({ element: name(element), kind: 'self-overflow', scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
      const parent = element.parentElement;
      if (!parent || !visible(parent) || ['BODY', 'HTML'].includes(parent.tagName) || getComputedStyle(parent).display === 'inline') continue;
      const pr = parent.getBoundingClientRect();
      if (rect.left < pr.left - 1 || rect.right > pr.right + 1) issues.push({ element: name(element), parent: name(parent), kind: 'parent-containment', left: rect.left, right: rect.right, parentLeft: pr.left, parentRight: pr.right });
    }
    return { width: viewportWidth, inspected, issues, pageScrollWidth: document.documentElement.scrollWidth };
  });
  report.layouts.push({ state, ...result });
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
  assert.equal(result.pageScrollWidth, width);
  await page.screenshot({ path: resolve(outputDir, `${state}-${width}.png`), fullPage: true });
  return result.inspected;
}

try {
  const response = await page.goto(baseURL, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await settle();
  const afterLoad = network.length;
  await check('Legacy is default; exact format and explicit action are discoverable', async () => {
    assert.equal(await $('text-format').inputValue(), 'legacy');
    assert.equal(await $('process-exact').isVisible(), false);
    await $('text-format').selectOption('exact');
    assert.equal(await $('process-exact').isVisible(), true);
    assert.match(await $('process-exact').textContent(), /Зашифровать/);
    assert.equal(await $('result').isVisible(), false);
    assert.equal(await $('exact-result').evaluate(element => element.tagName), 'PRE');
    assert.equal(await $('transliterate').isDisabled(), true);
    await expectPending();
  });
  await check('Mixed Unicode is unchanged after encrypt, reuse, explicit decrypt', async () => {
    const cipher = await encryptInput(mixed);
    assert.match(cipher, /^ENIGMA-UTF8-1:[A-Z]+$/);
    assert.equal(cipher.includes('Привет'), false);
    assert.equal(await $('share-telegram').isEnabled(), true);
    await reuseDecrypt(mixed);
    return { sourceCodeUnits: mixed.length, utf8Bytes: Buffer.byteLength(mixed), ciphertextLength: cipher.length };
  });
  await check('Combining marks, variation selectors and canonically distinct text retained', async () => {
    const source = 'e\u0301 ≠ é\nи\u0306 ≠ й\n\uFEFFstart\u200D\uFE0F☕️ 𐍈';
    await encryptInput(source);
    await reuseDecrypt(source);
  });
  await check('Leading/trailing spaces, tabs, repeated LF and blank lines retained', async () => {
    const source = '\n\n  Ёж\t  \n\n line\t\t\n  \n';
    await encryptInput(source);
    await reuseDecrypt(source);
  });
  await check('Empty source has an explicit successful container and empty decrypted result', async () => {
    const cipher = await encryptInput('');
    assert.ok(cipher.length > 0);
    await reuseDecrypt('');
    assert.match(await $('exact-state').textContent(), /Пустой текст.*0 байт/);
    assert.equal(await $('copy-result').isEnabled(), true);
    await $('reuse-result').click();
    assert.equal(await $('message').inputValue(), '');
    await expectPending();
    await execute();
    assert.equal(await $('exact-result').textContent(), cipher);
  });
  await check('Decrypted HTML-looking input is literal textContent with no inserted elements', async () => {
    const source = '<img src="https://invalid.example/leak" onerror="window.injected=true"><script>alert(1)</script> & <b>Ёж</b>';
    await encryptInput(source);
    await reuseDecrypt(source);
    assert.equal(await $('exact-result').locator('*').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
  });
  await check('Exact ciphertext and decrypted Unicode copy through real browser clipboard', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin });
    await page.evaluate(() => {
      const actualWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      window.__clipboardWrites = [];
      navigator.clipboard.writeText = text => { window.__clipboardWrites.push(text); return actualWrite(text); };
    });
    const cipher = await encryptInput(mixed);
    await $('copy-result').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), cipher);
    await reuseDecrypt(mixed);
    await $('copy-result').click();
    assert.deepEqual(await page.evaluate(() => window.__clipboardWrites), [cipher, mixed]);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    // Native Windows clipboard stores CRLF. The app must pass the original LF
    // string to the API; OS newline conversion is independent of the container.
    assert.equal(clipboard.replaceAll('\r\n', '\n'), mixed);
    return { exactWriteArgument: true, nativeClipboardNewlineConversion: clipboard !== mixed };
  });
  await check('CRLF, bare CR and NUL in valid container decode without normalization', async () => {
    const source = 'First\r\nВторая\rТретья\n\u0000конец';
    await exactBaseline('decrypt');
    const cipher = encryptExact(source, baseKey);
    await $('message').fill(cipher);
    await execute();
    assert.equal(await $('exact-result').textContent(), source);
    assert.equal(await $('exact-result').locator('*').count(), 0);
    await $('reuse-result').click();
    await expectPending();
    await execute();
    assert.equal(await $('exact-result').textContent(), cipher, 'raw reuse must not normalize CR/LF/NUL');
  });
  await check('Each input, rotor, ring, start, plugboard and direction edit invalidates exact output', async () => {
    const changes = [
      ['text', async () => $('message').fill('Changed')],
      ['rotor', async () => $('rotor-0').selectOption('IV')],
      ['ring', async () => $('ring-1').selectOption('B')],
      ['start', async () => $('position-2').selectOption('C')],
      ['plugboard', async () => $('plugboard').fill('AB CD')],
      ['direction', async () => page.locator('[name="mode"][value="decrypt"]').check()],
    ];
    for (const [name, change] of changes) {
      await encryptInput(mixed);
      await change();
      await expectPending();
      assert.ok((await $('exact-state').textContent()).length > 0, name);
    }
    return { invalidationPaths: changes.map(([name]) => name) };
  });
  await check('Random/reset key, clear and example buttons invalidate then require exact action', async () => {
    for (const id of ['random-key', 'reset-key', 'clear-text', 'sample-text']) {
      await encryptInput(mixed);
      await $(id).click();
      await expectPending();
      await execute();
      assert.equal(await $('input-error').isVisible(), false, id);
      assert.equal(await $('copy-result').isEnabled(), true, id);
    }
  });
  await check('Switching away from exact clears its old output and returning requires action', async () => {
    await encryptInput(mixed);
    await $('text-format').selectOption('legacy');
    assert.equal(await $('exact-result').textContent(), '');
    assert.equal(await $('process-exact').isVisible(), false);
    await $('text-format').selectOption('exact');
    await expectPending();
    await execute();
    await reuseDecrypt(mixed);
  });
  await check('Wrong key rejects instead of exposing stale successful plaintext', async () => {
    const cipher = await encryptInput(mixed);
    await reuseDecrypt(mixed);
    await $('position-2').selectOption('B');
    await expectPending();
    await execute();
    await expectFailure();
    await $('position-2').selectOption('A');
    await execute();
    assert.equal(await $('exact-result').textContent(), mixed);
    assert.equal(await $('message').inputValue(), cipher);
  });
  await check('Malformed version, alphabet, truncation and damaged ciphertext all fail closed', async () => {
    const cipher = await encryptInput(mixed);
    await page.locator('[name="mode"][value="decrypt"]').check();
    const mutated = cipher.slice(0, -1) + (cipher.at(-1) === 'A' ? 'B' : 'A');
    const cases = ['', 'HELLOWORLD', cipher.replace('UTF8-1:', 'UTF8-2:'), cipher.toLowerCase(), cipher + '!', cipher.slice(0, -1), mutated, cipher + 'AA', ' ' + cipher, cipher + '\n'];
    for (const value of cases) {
      await $('message').fill(value);
      await execute();
      await expectFailure();
    }
    return { rejectedCases: cases.length };
  });
  await check('Invalid rotor and plugboard settings block explicit exact processing', async () => {
    await encryptInput(mixed);
    await $('rotor-1').selectOption('I');
    await expectPending();
    assert.equal(await $('key-error').isVisible(), true);
    assert.equal(await $('export-key').isDisabled(), true);
    await $('rotor-1').selectOption('II');
    await $('plugboard').fill('AB AC');
    await expectPending();
    assert.equal(await $('key-error').isVisible(), true);
    await $('plugboard').fill('');
    await execute();
    await reuseDecrypt(mixed);
  });
  await check('Exact input accepts maximum 10000 UTF-8 bytes and entire 200xx container', async () => {
    for (const source of ['A'.repeat(MAX_EXACT_BYTES), 'ё'.repeat(MAX_EXACT_BYTES / 2), '😀'.repeat(MAX_EXACT_BYTES / 4)]) {
      const cipher = await encryptInput(source);
      assert.equal(cipher.length, MAX_EXACT_CIPHERTEXT_LENGTH);
      assert.equal(await $('share-telegram').isDisabled(), true);
      await $('reuse-result').click();
      assert.equal(await $('message').inputValue(), cipher);
      assert.equal(await $('message').getAttribute('maxlength'), String(MAX_EXACT_CIPHERTEXT_LENGTH));
      await execute();
      assert.equal(await $('exact-result').textContent(), source);
    }
    return { maxBytes: MAX_EXACT_BYTES, maxContainerLength: MAX_EXACT_CIPHERTEXT_LENGTH };
  });
  await check('Oversized Unicode bytes and programmatically oversized ciphertext are rejected', async () => {
    await exactBaseline();
    await $('message').fill('ё'.repeat(5001));
    await execute();
    await expectFailure();
    await $('message').evaluate(element => { element.value = 'A'.repeat(10001); element.dispatchEvent(new Event('input', { bubbles: true })); });
    await execute();
    await expectFailure();
    await page.locator('[name="mode"][value="decrypt"]').check();
    await $('message').evaluate((element, length) => { element.value = 'A'.repeat(length); element.dispatchEvent(new Event('input', { bubbles: true })); }, MAX_EXACT_CIPHERTEXT_LENGTH + 1);
    await execute();
    await expectFailure();
  });
  await check('Unpaired UTF-16 surrogate fails explicitly and recovers after correction', async () => {
    await exactBaseline();
    await $('message').evaluate(element => { element.value = 'A\uD800'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await execute();
    await expectFailure();
    await $('message').fill(mixed);
    await execute();
    await reuseDecrypt(mixed);
  });
  await check('Export contains settings only; import invalidates exact result and preserves input', async () => {
    const cipher = await encryptInput(mixed);
    const downloadEvent = page.waitForEvent('download');
    await $('export-key').click();
    const downloaded = await downloadEvent;
    const exported = await readFile(await downloaded.path(), 'utf8');
    const parsed = JSON.parse(exported);
    assert.deepEqual(Object.keys(parsed), ['format', 'version', 'settings']);
    assert.deepEqual(parsed.settings, baseKey);
    assert.equal(exported.includes(mixed), false);
    assert.equal(exported.includes(cipher), false);
    await $('random-key').click();
    await execute();
    await importKey(exported);
    await expectPending();
    assert.equal(await $('message').inputValue(), mixed);
    await execute();
    assert.equal(await $('exact-result').textContent(), cipher);
  });
  await check('UTF-8 text file round trip preserves raw bytes including BOM, CRLF, CR, NUL and empty', async () => {
    const sources = ['\uFEFFПривет, Ёж!\r\n e\u0301 ≠ é\r👩🏽‍💻\n\u0000конец\r\n', '', 'ё'.repeat(5000)];
    for (const source of sources) {
      const sourceBytes = Buffer.from(source, 'utf8');
      await exactBaseline();
      await importText(sourceBytes);
      await expectPending();
      assert.equal(await $('download-result').isDisabled(), true);
      await execute();
      const cipher = await $('exact-result').textContent();
      assert.equal(cipher, encryptExact(source, baseKey));
      const encryptedDownload = await downloadResult();
      assert.equal(encryptedDownload.name, 'enigma-ciphertext.txt');
      assert.deepEqual(encryptedDownload.bytes, Buffer.from(cipher));
      await exactBaseline('decrypt');
      await importText(encryptedDownload.bytes, 'enigma-ciphertext.txt');
      await expectPending();
      await execute();
      assert.equal(await $('exact-result').textContent(), source);
      const decryptedDownload = await downloadResult();
      assert.equal(decryptedDownload.name, 'enigma-text.txt');
      assert.deepEqual(decryptedDownload.bytes, sourceBytes);
    }
    return { byteExactSamples: sources.length, maxSourceBytes: 10000, maxContainerBytes: MAX_EXACT_CIPHERTEXT_LENGTH };
  });
  await check('Invalid UTF-8 and oversized text imports clear stale output, preserve source, recover', async () => {
    for (const bytes of [Buffer.from([0xC3, 0x28]), Buffer.from([0xED, 0xA0, 0x80]), Buffer.alloc(MAX_EXACT_BYTES + 1, 65)]) {
      await encryptInput(mixed);
      await importText(bytes);
      await expectPending();
      assert.equal(await $('download-result').isDisabled(), true);
      assert.equal(await $('message').inputValue(), mixed);
      assert.equal(await $('message-status').evaluate(element => element.classList.contains('error')), true);
      await execute();
      await reuseDecrypt(mixed);
    }
    await exactBaseline('decrypt');
    await importText(Buffer.alloc(MAX_EXACT_CIPHERTEXT_LENGTH + 1, 65));
    await expectPending();
    assert.equal(await $('message-status').evaluate(element => element.classList.contains('error')), true);
    return { rejectedFiles: 4 };
  });
  await check('Telegram receives only complete encrypted envelope and fixed public URL', async () => {
    const cipher = await encryptInput(mixed);
    await $('share-telegram').click();
    const captured = await page.evaluate(() => window.__capturedShare);
    assert.equal(captured.length, 1);
    const [address, target, features] = captured[0];
    const url = new URL(address);
    assert.equal(url.origin, 'https://t.me');
    assert.equal(url.pathname, '/share/url');
    assert.deepEqual([...url.searchParams.keys()], ['url', 'text']);
    assert.equal(url.searchParams.get('text'), cipher);
    assert.equal(url.searchParams.get('url'), publicSiteURL);
    assert.equal(address.includes(encodeURIComponent(mixed)), false);
    assert.equal(target, '_blank');
    assert.equal(features, 'noopener,noreferrer');
    assert.equal(context.pages().length, 1);
    assert.equal(network.some(item => item.url.startsWith('https://t.me')), false);
    return { parameterNames: [...url.searchParams.keys()], intercepted: true, telegramRequests: 0 };
  });
  await check('Exact operations, typing, export/import/copy and share made zero network requests', async () => {
    assert.deepEqual(network.slice(afterLoad), []);
    return { initialRequests: afterLoad, subsequentRequests: network.length - afterLoad };
  });
  for (const width of [320, 360, 390, 768, 1280]) {
    await check(`Exact element containment at ${width}px: pending, encrypt/decrypt success, error`, async () => {
      await exactBaseline();
      const counts = [];
      counts.push(await layoutAt(width, 'pending'));
      await $('message').fill(mixed + 'A'.repeat(400));
      await execute();
      counts.push(await layoutAt(width, 'encrypted'));
      await reuseDecrypt(mixed + 'A'.repeat(400));
      counts.push(await layoutAt(width, 'decrypted'));
      await $('message').fill('ENIGMA-UTF8-99:INVALID');
      await execute();
      await expectFailure();
      counts.push(await layoutAt(width, 'error'));
      for (const id of ['text-format', 'process-exact', 'import-text', 'download-result', 'copy-result', 'reuse-result', 'share-telegram']) {
        assert.equal(await $(id).isVisible(), true, id);
        const box = await $(id).boundingBox();
        assert.ok(box.width > 30 && box.height > 20, id);
      }
      return { inspectedElementsPerState: counts };
    });
  }
  await check('No messages or settings persisted; fresh page retains legacy compatibility', async () => {
    assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie })), { local: {}, session: {}, cookies: '' });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await $('message').inputValue(), '');
    assert.equal(await $('text-format').inputValue(), 'legacy');
    await $('message').fill('AAAAA');
    assert.equal(await $('result').inputValue(), 'BDZGO');
    await $('message').fill('HELLOWORLD');
    assert.equal(await $('result').inputValue(), 'ILBDAAMTAZ');
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
