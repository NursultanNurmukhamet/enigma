/**
 * Real-browser acceptance checks. Requires an existing Playwright installation;
 * this script never installs browsers or packages, and never opens Telegram.
 * PLAYWRIGHT_MODULE may be a package name or file: URL to playwright/index.mjs.
 * BROWSER_EXECUTABLE optionally selects an already installed Chromium browser.
 * Usage: node tests/browser.mjs [http://127.0.0.1:4173/]
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.argv[2] || 'http://127.0.0.1:4173/';
const publicSiteURL = process.env.PUBLIC_SITE_URL || 'https://nursultannurmukhamet.github.io/enigma/';
const outputDir = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const launch = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launch.executablePath = process.env.BROWSER_EXECUTABLE;
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
const page = await context.newPage();
const network = [];
const pageErrors = [];
page.on('request', request => network.push({ method: request.method(), url: request.url() }));
page.on('pageerror', error => pageErrors.push(error.message));
const report = { baseURL, startedAt: new Date().toISOString(), checks: [], layouts: [], pageErrors };
let failures = 0;

async function check(name, operation) {
  try {
    const detail = await operation();
    report.checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    report.checks.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: resolve(outputDir, `failure-${failures}.png`), fullPage: true }).catch(() => {});
  }
}

async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function layoutAt(width) {
  await page.setViewportSize({ width, height: 900 });
  await settle();
  return page.evaluate(() => {
    const issues = [];
    let inspected = 0;
    const viewportWidth = document.documentElement.clientWidth;
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
    };
    const describe = element => element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().replaceAll(' ', '.')}` : ''}`;
    for (const element of document.body.querySelectorAll('*')) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      if (style.position === 'absolute' && (style.clip !== 'auto' || style.clipPath !== 'none')) continue;
      inspected += 1;
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > viewportWidth + 1) issues.push({ element: describe(element), kind: 'viewport', left: rect.left, right: rect.right, viewportWidth });
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && !['TEXTAREA', 'SELECT', 'INPUT'].includes(element.tagName)) {
        issues.push({ element: describe(element), kind: 'self-overflow', scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
      }
      const parent = element.parentElement;
      if (!parent || !visible(parent) || ['BODY', 'HTML'].includes(parent.tagName) || getComputedStyle(parent).display === 'inline') continue;
      const parentRect = parent.getBoundingClientRect();
      if (rect.left < parentRect.left - 1 || rect.right > parentRect.right + 1) {
        issues.push({ element: describe(element), parent: describe(parent), kind: 'parent-containment', left: rect.left, right: rect.right, parentLeft: parentRect.left, parentRight: parentRect.right });
      }
    }
    return { width: viewportWidth, inspected, issues, pageScrollWidth: document.documentElement.scrollWidth };
  });
}

const $ = id => page.locator(`#${id}`);
const config = (overrides = {}) => ({ rotors: ['I', 'II', 'III'], rings: 'AAA', positions: 'AAA', plugboard: '', reflector: 'B', ...overrides });
const customKey = config({ rotors: ['V', 'III', 'I'], rings: 'BDF', positions: 'QEZ', plugboard: 'AV BS CG DL FU HZ IN KM OW RX' });
async function readKey() {
  return page.evaluate(() => ({
    rotors: [0, 1, 2].map(i => document.getElementById(`rotor-${i}`).value),
    rings: [0, 1, 2].map(i => document.getElementById(`ring-${i}`).value).join(''),
    positions: [0, 1, 2].map(i => document.getElementById(`position-${i}`).value).join(''),
    plugboard: document.getElementById('plugboard').value,
    reflector: 'B',
  }));
}
async function enterKey(settings) {
  for (let i = 0; i < 3; i += 1) {
    await $(`rotor-${i}`).selectOption(settings.rotors[i]);
    await $(`ring-${i}`).selectOption(settings.rings[i]);
    await $(`position-${i}`).selectOption(settings.positions[i]);
  }
  await $('plugboard').fill(settings.plugboard);
}
async function baseline() {
  await page.locator('[name="mode"][value="encrypt"]').check();
  await $('transliterate').uncheck();
  await $('reset-key').click();
  await $('clear-text').click();
}
async function expectOutput(text) {
  assert.equal(await $('result').inputValue(), text);
}
async function assertBlocked(errorID) {
  if (errorID) assert.equal(await $(errorID).isVisible(), true);
  await expectOutput('');
  for (const id of ['share-telegram', 'copy-result', 'reuse-result']) assert.equal(await $(id).isDisabled(), true, id);
}
async function importFile(name, content) {
  const chooserPromise = page.waitForEvent('filechooser');
  await $('import-key').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) });
  await page.waitForFunction(() => document.getElementById('key-file').value === '' && document.getElementById('key-status').textContent.length > 0);
  await settle();
}

try {
  const response = await page.goto(baseURL, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, 'The page must load successfully');
  await settle();
  await check('Russian UI, historical warning, no external resources', async () => {
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
    assert.match(await page.title(), /Энигма/);
    assert.match(await page.locator('.warning').textContent(), /Не используйте для настоящих секретов/);
    assert.equal(await $('transliterate').isChecked(), false);
    assert.equal(await $('result').getAttribute('readonly'), '');
    assert.equal(network.every(item => new URL(item.url).origin === new URL(baseURL).origin), true, JSON.stringify(network));
    await assertBlocked();
  });
  const afterLoad = network.length;

  await check('Known vector AAAAA → BDZGO, reset configuration', async () => {
    await baseline();
    assert.deepEqual(await readKey(), config());
    await $('message').fill('AAAAA');
    await expectOutput('BDZGO');
    assert.equal(await $('share-telegram').isEnabled(), true);
  });
  await check('Known vector HELLOWORLD → ILBDAAMTAZ, lowercase normalized', async () => {
    await $('message').fill('helloworld');
    await expectOutput('ILBDAAMTAZ');
  });
  await check('Every edit recomputes full message from initial positions', async () => {
    await baseline();
    await $('message').fill('AAA');
    await expectOutput('BDZ');
    await $('message').press('End');
    await $('message').pressSequentially('AA');
    await expectOutput('BDZGO');
    await $('message').fill('AAAA');
    await expectOutput('BDZG');
    await $('message').fill('AAAAA');
    await expectOutput('BDZGO');
    assert.equal((await readKey()).positions, 'AAA');
  });
  await check('Whitespace, punctuation, digits, emoji preserved without stepping', async () => {
    await baseline();
    await $('message').fill('a a-a\nA1a!?🙂');
    await expectOutput('B D-Z\nG1O!?🙂');
  });
  await check('Reuse button round trip switches encrypt/decrypt and disables sharing', async () => {
    await baseline();
    const source = 'HELLO WORLD! 2026\nDOUBLE STEP CHECK';
    await $('message').fill(source);
    const ciphertext = await $('result').inputValue();
    await $('reuse-result').click();
    assert.equal(await page.locator('[name="mode"][value="decrypt"]').isChecked(), true);
    assert.equal(await $('message').inputValue(), ciphertext);
    await expectOutput(source);
    assert.equal(await $('share-telegram').isDisabled(), true);
    assert.equal(await $('transliterate').isDisabled(), true);
    await $('reuse-result').click();
    assert.equal(await page.locator('[name="mode"][value="encrypt"]').isChecked(), true);
    await expectOutput(ciphertext);
  });
  await check('Manual rotors/rings/positions/plugboard, same-key round trip across turnover', async () => {
    await baseline();
    await enterKey(customKey);
    assert.deepEqual(await readKey(), customKey);
    const source = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(12);
    await $('message').fill(source);
    const cipher = await $('result').inputValue();
    assert.equal(cipher.length, source.length);
    assert.notEqual(cipher, source);
    await page.locator('[name="mode"][value="decrypt"]').check();
    await $('message').fill(cipher);
    await expectOutput(source);
    assert.deepEqual(await readKey(), customKey);
  });
  await check('Ring and start controls both affect wiring', async () => {
    await baseline();
    await enterKey(config({ rings: 'BBB', positions: 'BBB' }));
    await $('message').fill('AAAAA');
    await expectOutput('BDZGO');
    await $('position-2').selectOption('C');
    assert.notEqual(await $('result').inputValue(), 'BDZGO');
    await $('position-2').selectOption('B');
    await $('ring-2').selectOption('C');
    assert.notEqual(await $('result').inputValue(), 'BDZGO');
  });
  await check('Duplicate rotors show error and disable result/export/share', async () => {
    await baseline();
    await $('message').fill('HELLO');
    await $('rotor-1').selectOption('I');
    await assertBlocked('key-error');
    assert.equal(await $('export-key').isDisabled(), true);
    assert.equal(await $('rotor-1').getAttribute('aria-invalid'), 'true');
    await page.screenshot({ path: resolve(outputDir, 'validation-duplicate-rotor.png'), fullPage: true });
    await $('rotor-1').selectOption('II');
    await expectOutput('ILBDA');
  });
  await check('Bad plugboard: self-pair, repeated letter, malformed pair, non-Latin', async () => {
    await baseline();
    await $('message').fill('HELLO');
    for (const invalid of ['AA', 'AB AC', 'ABC', 'AB,CD', 'AЯ']) {
      await $('plugboard').fill(invalid);
      await assertBlocked('key-error');
      assert.equal(await $('export-key').isDisabled(), true);
      assert.equal(await $('plugboard').getAttribute('aria-invalid'), 'true');
    }
    await $('plugboard').fill('ab cd');
    assert.equal(await $('key-error').isVisible(), false);
    assert.equal(await $('share-telegram').isEnabled(), true);
  });
  await check('Random-key button produces valid, distinct rotors and ten disjoint pairs', async () => {
    await baseline();
    await $('message').fill('RANDOM KEY ROUND TRIP');
    for (let i = 0; i < 5; i += 1) {
      await $('random-key').click();
      const key = await readKey();
      assert.equal(new Set(key.rotors).size, 3);
      assert.match(key.rings, /^[A-Z]{3}$/);
      assert.match(key.positions, /^[A-Z]{3}$/);
      assert.equal(key.plugboard.split(' ').length, 10);
      assert.equal(new Set(key.plugboard.replaceAll(' ', '')).size, 20);
      assert.equal(await $('key-error').isVisible(), false);
      await $('reuse-result').click();
      await expectOutput('RANDOM KEY ROUND TRIP');
      await $('reuse-result').click();
    }
  });
  let exported;
  await check('Export button downloads versioned JSON containing settings only', async () => {
    await baseline();
    await enterKey(customKey);
    await $('message').fill('NEVER EXPORT THIS MESSAGE');
    const ciphertext = await $('result').inputValue();
    const downloadPromise = page.waitForEvent('download');
    await $('export-key').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'enigma-key.json');
    exported = await readFile(await download.path(), 'utf8');
    const parsed = JSON.parse(exported);
    assert.deepEqual(Object.keys(parsed), ['format', 'version', 'settings']);
    assert.equal(parsed.format, 'enigma-i');
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.settings, customKey);
    assert.equal(exported.includes('NEVER EXPORT THIS MESSAGE'), false);
    assert.equal(exported.includes(ciphertext), false);
    await download.saveAs(resolve(outputDir, 'exported-test-key.json'));
  });
  await check('Import chooser restores exported key and recomputes current text', async () => {
    await baseline();
    await $('message').fill('IMPORT CHECK');
    const oldCipher = await $('result').inputValue();
    await importFile('test-key.json', exported);
    assert.deepEqual(await readKey(), customKey);
    assert.equal(await $('message').inputValue(), 'IMPORT CHECK');
    assert.notEqual(await $('result').inputValue(), oldCipher);
    assert.equal(await $('key-status').evaluate(element => element.classList.contains('error')), false);
  });
  await check('Invalid import JSON/version/rings/rotors/plugboard/unknown fields is atomic', async () => {
    await enterKey(customKey);
    const before = await readKey();
    const originalText = await $('message').inputValue();
    const originalResult = await $('result').inputValue();
    const valid = JSON.parse(exported);
    const cases = ['{', '{}', JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, settings: { ...customKey, rings: 'A1A' } }),
      JSON.stringify({ ...valid, settings: { ...customKey, positions: 'AA' } }),
      JSON.stringify({ ...valid, settings: { ...customKey, rotors: ['I', 'I', 'III'] } }),
      JSON.stringify({ ...valid, settings: { ...customKey, plugboard: 'AB CD EF GH IJ KL MN OP QR ST UV' } }),
      JSON.stringify({ ...valid, settings: { ...customKey, source: 'FORBIDDEN' } })];
    for (const contents of cases) {
      await importFile('invalid.json', contents);
      assert.equal(await $('key-status').evaluate(element => element.classList.contains('error')), true);
      assert.deepEqual(await readKey(), before);
      assert.equal(await $('message').inputValue(), originalText);
      await expectOutput(originalResult);
    }
    return { rejectedCases: cases.length };
  });
  await check('Empty, oversized and wrong-extension imports preserve current key', async () => {
    const before = await readKey();
    for (const [name, contents] of [['empty.json', ''], ['huge.json', ' '.repeat(16385)], ['key.txt', exported]]) {
      await importFile(name, contents);
      assert.equal(await $('key-status').evaluate(element => element.classList.contains('error')), true);
      assert.deepEqual(await readKey(), before);
    }
    await page.screenshot({ path: resolve(outputDir, 'validation-import.png'), fullPage: true });
  });
  await check('Russian requires explicit opt-in and warns original spelling is lost', async () => {
    await baseline();
    await $('message').fill('Привет, ёж!');
    await assertBlocked('input-error');
    assert.match(await page.locator('.checkbox-help').textContent(), /не восстанов/);
    await $('transliterate').check();
    assert.equal(await $('input-error').isVisible(), false);
    assert.match(await $('result').inputValue(), /^[A-Z]+, [A-Z]+!$/);
    await $('reuse-result').click();
    await expectOutput('PRIVET, YOZH!');
    assert.equal(await $('share-telegram').isDisabled(), true);
    await page.locator('[name="mode"][value="encrypt"]').check();
    await $('transliterate').uncheck();
    await $('message').fill('Привет');
    await assertBlocked('input-error');
  });
  await check('Unsupported letters rejected instead of leaking plaintext', async () => {
    await baseline();
    for (const text of ['café', '中文', 'A\u0301']) {
      await $('message').fill(text);
      await assertBlocked('input-error');
    }
  });
  await check('Transliteration expansion beyond 10000 characters is blocked and recoverable', async () => {
    await baseline();
    await $('transliterate').check();
    await $('message').fill('Щ'.repeat(3000));
    await assertBlocked('input-error');
    assert.match(await $('input-error').textContent(), /10.?000/);
    await $('message').fill('Щ'.repeat(2500));
    assert.equal((await $('result').inputValue()).length, 10000);
    await $('reuse-result').click();
    await expectOutput('SHCH'.repeat(2500));
  });
  await check('Emoji presentation selectors preserved; lone UTF-16 surrogate rejected', async () => {
    await baseline();
    await $('message').fill('A❤️A');
    await expectOutput('B❤️D');
    await $('message').evaluate(element => { element.value = 'A\ud800'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await assertBlocked('input-error');
  });
  await check('Sample preserves key; reset restores defaults; clear empties output', async () => {
    await baseline();
    await enterKey(customKey);
    await $('sample-text').click();
    assert.deepEqual(await readKey(), customKey);
    assert.equal(await $('message').inputValue(), 'HELLO WORLD');
    await $('reset-key').click();
    assert.deepEqual(await readKey(), config());
    await expectOutput('ILBDA AMTAZ');
    await $('clear-text').click();
    assert.equal(await $('message').inputValue(), '');
    await assertBlocked();
  });
  await check('Copy button writes current result to browser clipboard', async () => {
    await baseline();
    await $('message').fill('AAAAA');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin });
    await $('copy-result').click();
    await page.waitForFunction(() => document.getElementById('message-status').textContent.length > 0);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'BDZGO');
  });
  await check('Telegram integration intercepted before navigation: ciphertext + fixed public URL only', async () => {
    await baseline();
    await enterKey(customKey);
    const source = 'PRIVATE ORIGINAL MESSAGE & ? # +\nNOT A KEY';
    await $('message').fill(source);
    const ciphertext = await $('result').inputValue();
    // The real open method is replaced first; this click cannot open Telegram.
    await page.evaluate(() => { window.__capturedShare = []; window.open = (...args) => { window.__capturedShare.push(args); return null; }; });
    await $('share-telegram').click();
    const captured = await page.evaluate(() => window.__capturedShare);
    assert.equal(captured.length, 1);
    const [address, target, features] = captured[0];
    const url = new URL(address);
    assert.equal(url.origin, 'https://t.me');
    assert.equal(url.pathname, '/share/url');
    assert.deepEqual([...url.searchParams.keys()], ['url', 'text']);
    assert.equal(url.searchParams.get('text'), ciphertext);
    assert.equal(url.searchParams.get('url'), publicSiteURL);
    assert.equal(url.searchParams.get('text').includes('PRIVATE ORIGINAL'), false);
    for (const key of ['rings', 'positions', 'rotors', 'plugboard']) assert.equal(url.searchParams.has(key), false);
    assert.equal(target, '_blank');
    assert.equal(features, 'noopener,noreferrer');
    assert.equal(context.pages().length, 1);
    assert.equal(network.some(item => item.url.startsWith('https://t.me')), false);
    return { origin: url.origin, path: url.pathname, parameterNames: [...url.searchParams.keys()], intercepted: true, telegramRequests: 0 };
  });
  await check('Telegram unavailable for empty, punctuation-only, decrypt, errors, oversized URL', async () => {
    await baseline();
    assert.equal(await $('share-telegram').isDisabled(), true);
    await $('message').fill('123 !?\n🙂');
    assert.equal(await $('share-telegram').isDisabled(), true);
    await $('message').fill('A'.repeat(10000));
    assert.equal(await $('share-telegram').isDisabled(), true);
    assert.match(await $('share-help').textContent(), /слишком длинный/);
    await $('message').fill('AAAAA');
    await page.locator('[name="mode"][value="decrypt"]').check();
    assert.equal(await $('share-telegram').isDisabled(), true);
    await page.locator('[name="mode"][value="encrypt"]').check();
    await $('plugboard').fill('AA');
    assert.equal(await $('share-telegram').isDisabled(), true);
  });
  await check('Editing/settings/import/export/copy/share stub made zero network requests', async () => {
    assert.deepEqual(network.slice(afterLoad), []);
    return { initialRequests: afterLoad, subsequentRequests: network.length - afterLoad };
  });
  await check('Messages/settings not persisted in localStorage/sessionStorage/cookies or reload', async () => {
    await baseline();
    await enterKey(customKey);
    await $('message').fill('DO NOT PERSIST ME');
    assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie })), { local: {}, session: {}, cookies: '' });
    await page.reload({ waitUntil: 'networkidle' });
    await expectOutput('');
    assert.equal(await $('message').inputValue(), '');
    assert.deepEqual(await readKey(), config());
  });
  await check('Instructions disclosure explains reset, formatting and historical simplifications', async () => {
    await page.locator('details summary').click();
    assert.equal(await page.locator('details').getAttribute('open'), '');
    const instructions = await page.locator('.instructions-body').textContent();
    assert.match(instructions, /двойной шаг/);
    assert.match(instructions, /исходных позиций/);
    assert.match(instructions, /пробелов/);
  });
  for (const width of [320, 360, 390, 768, 1280]) {
    await check(`Element containment and overflow at ${width}px, normal and error states`, async () => {
      await baseline();
      await $('message').fill('A'.repeat(600));
      const normal = await layoutAt(width);
      report.layouts.push({ state: 'normal', ...normal });
      assert.deepEqual(normal.issues, [], JSON.stringify(normal.issues));
      assert.equal(normal.pageScrollWidth, width);
      await $('plugboard').fill('AB AC');
      const invalid = await layoutAt(width);
      report.layouts.push({ state: 'invalid', ...invalid });
      assert.deepEqual(invalid.issues, [], JSON.stringify(invalid.issues));
      assert.equal(invalid.pageScrollWidth, width);
      if (width === 320 || width === 1280) await page.screenshot({ path: resolve(outputDir, `validation-${width}.png`), fullPage: true });
      await $('plugboard').fill('');
      await $('sample-text').click();
      await page.screenshot({ path: resolve(outputDir, `layout-${width}.png`), fullPage: true });
      return { normalElements: normal.inspected, errorElements: invalid.inspected };
    });
  }
  await check('No uncaught page errors during all checks', async () => assert.deepEqual(pageErrors, []));
} catch (error) {
  failures += 1;
  report.checks.push({ name: 'Browser harness completed', passed: false, error: error.stack });
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter(item => item.passed).length;
  report.failed = failures;
  await writeFile(resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
if (failures) process.exitCode = 1;
