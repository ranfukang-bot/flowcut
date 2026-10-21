const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { normalizeGoogleCookies, readFirefoxGoogleCookies, importIntoEmptyGoogleSession } = require('../src/gemini-login-import');
const { TemporaryBrowserLogin, assertTempProfile, closeBrowser } = require('../src/gemini-browser-login');
const future = Date.now() / 1000 + 86400;
const raw = (extra = {}) => ({ name: 'SID', value: 'synthetic-test-cookie', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: future, ...extra });
const directory = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-login-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('Cookie conversion preserves host-only, domain, expiry and security attributes and excludes unrelated/expired cookies', async () => {
  const rows = [raw(), raw({ name: '__Host-test', domain: 'accounts.google.com', sameSite: 'Strict' }),
    raw({ name: 'youtube', domain: '.youtube.com', session: true, expires: -1, sameSite: 'None' }),
    raw({ domain: '.google.com.evil.test' }), raw({ domain: '.notgoogle.com' }), raw({ expires: 1 })];
  const { cookies: result, skippedPartitioned } = normalizeGoogleCookies(rows);
  assert.equal(skippedPartitioned, 0);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { url: 'https://google.com/', name: 'SID', value: 'synthetic-test-cookie', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: future });
  assert.equal(result[1].domain, undefined); assert.equal(result[1].url, 'https://accounts.google.com/'); assert.equal(result[1].sameSite, 'strict');
  assert.equal(result[2].expirationDate, undefined); assert.equal(result[2].sameSite, 'no_restriction');
  assert.deepEqual(normalizeGoogleCookies(result).cookies, result, 'normalized cookies remain valid input without losing host-only cookies');
});

for (const schema of [14, 17]) test(`Firefox SQLite schema ${schema} preserves attributes and expiry units`, t => {
  const dir = directory(t), db = new DatabaseSync(path.join(dir, 'cookies.sqlite'));
  db.exec(`PRAGMA user_version=${schema}; CREATE TABLE moz_cookies(name TEXT,value TEXT,host TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT,${schema === 14 ? 'rawSameSite INTEGER,' : ''}isPartitionedAttributeSet INTEGER)`);
  const insert = db.prepare(`INSERT INTO moz_cookies VALUES (${Array(schema === 14 ? 11 : 10).fill('?').join(',')})`);
  const expiry = Math.floor(future);
  for (const [name, host, sameSite] of [['SID', '.google.com', 2], ['HOST', 'accounts.google.com', 1], ['wrong', '.google.com.evil.test', 1]]) {
    insert.run(name, 'synthetic-test-cookie', host, '/account', expiry * (schema >= 16 ? 1000 : 1), 1, 1, sameSite, '', ...(schema === 14 ? [sameSite] : []), 0);
  }
  db.close();
  const { cookies: result, skippedPartitioned } = readFirefoxGoogleCookies(dir);
  assert.equal(skippedPartitioned, 0, 'empty Firefox originAttributes imports normally');
  assert.equal(result.length, 2); assert.equal(result[0].expirationDate, expiry); assert.equal(result[0].sameSite, 'strict'); assert.equal(result[0].path, '/account');
  assert.equal(result[1].domain, undefined); assert.equal(result[1].sameSite, 'lax');
});

const partitionMarkers = [{ partitionKey: { topLevelSite: 'https://google.com' } },
  { partitionKeyOpaque: true }, { isPartitionedAttributeSet: true }];

test('mixed partitioned cookies are counted and never written as ordinary cookies', async () => {
  const target = jar();
  const ordinary = [raw(), raw({ name: 'HSID' })];
  const rows = [...ordinary, ...partitionMarkers.map(marker => raw({ ...marker, name: 'partitioned-only', value: 'must-not-import' }))];
  assert.deepEqual(await importIntoEmptyGoogleSession(target, rows), { importedCount: 2, skippedPartitioned: 3 });
  assert.deepEqual(target.values, normalizeGoogleCookies(ordinary).cookies);
});

for (const name of ['SID', '__Secure-1PSID', '__Secure-3PSID']) test(`partitioned ${name} cannot satisfy the login requirement`, async () => {
  const target = jar();
  await assert.rejects(importIntoEmptyGoogleSession(target, [raw({ name, partitionKey: 'synthetic-partition' }), raw({ name: 'HSID' })]),
    { code: 'LOGIN_NOT_FINISHED', message: '尚未取得 Google 登录，请先在浏览器中完成登录' });
  assert.deepEqual(target.values, [], 'no writes take place without an unpartitioned login cookie');
  assert.deepEqual(await importIntoEmptyGoogleSession(target, [raw({ name })]), { importedCount: 1, skippedPartitioned: 0 });
});

test('only partitioned cookies fail with LOGIN_NOT_FINISHED and no writes', async () => {
  const target = jar();
  await assert.rejects(importIntoEmptyGoogleSession(target, partitionMarkers.map(marker => raw(marker))), { code: 'LOGIN_NOT_FINISHED' });
  assert.deepEqual(target.values, []);
});

test('Firefox skips nonempty originAttributes and partition flags but keeps empty originAttributes', () => {
  const firefox = extra => ({ ...raw(), host: '.google.com', expiry: future, isSecure: 1, isHttpOnly: 1, sameSite: 1, originAttributes: '', ...extra });
  const result = normalizeGoogleCookies([firefox({}), firefox({ name: 'container', originAttributes: '^userContextId=1' }),
    firefox({ name: 'third-party', originAttributes: '^partitionKey=%28https%2Cexample.test%29' }),
    firefox({ name: 'flagged', isPartitionedAttributeSet: 1 })], { source: 'firefox' });
  assert.equal(result.skippedPartitioned, 3);
  assert.deepEqual(result.cookies.map(cookie => cookie.name), ['SID']);
});

function jar(initial = [], failAt = -1) {
  const values = [...initial]; let writes = 0;
  return { values, cookies: { async get() { return values; }, async set(cookie) { if (++writes === failAt) throw Error('secret must not escape'); values.push(cookie); },
    async remove(url, name) { const index = values.findIndex(c => c.url === url && c.name === name); if (index >= 0) values.splice(index, 1); }, async flushStore() {} } };
}

for (const includeOrdinary of [true, false]) test(`Firefox SQLite import ${includeOrdinary ? 'preserves skipped counts through both normalization passes' : 'rejects partitioned-only login'} and cleans the source`, async t => {
  const root = directory(t), target = jar();
  const run = new TemporaryBrowserLogin({ root, browser: { kind: 'firefox', executable: process.execPath },
    launch() { const child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; }, stop: async () => {} });
  await run.start();
  const db = new DatabaseSync(path.join(run.profile, 'cookies.sqlite'));
  db.exec(`PRAGMA user_version=17; CREATE TABLE moz_cookies(name TEXT,value TEXT,host TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT,isPartitionedAttributeSet INTEGER)`);
  const insert = db.prepare('INSERT INTO moz_cookies VALUES(?,?,?, ?,?,1,1,1,?,?)');
  if (includeOrdinary) insert.run('SID', 'synthetic-ordinary', '.google.com', '/', Math.floor(future) * 1000, '', 0);
  insert.run('__Secure-1PSID', 'synthetic-partitioned', '.google.com', '/', Math.floor(future) * 1000, '^partitionKey=synthetic', 0);
  insert.run('__Secure-3PSID', 'synthetic-partitioned', '.google.com', '/', Math.floor(future) * 1000, '', 1);
  db.close();
  if (includeOrdinary) {
    const result = await run.complete({ userConfirmed: true, target });
    assert.deepEqual(result, { importedCount: 1, skippedPartitioned: 2, browser: 'firefox', tempRemoved: true });
    assert.deepEqual(target.values.map(cookie => [cookie.name, cookie.value]), [['SID', 'synthetic-ordinary']]);
  } else {
    await assert.rejects(run.complete({ userConfirmed: true, target }), { code: 'LOGIN_NOT_FINISHED' });
    assert.deepEqual(target.values, []);
  }
  assert.equal(fs.existsSync(run.profile), false);
});
test('existing Google login is protected without writes', async () => {
  const target = jar([raw()]), snapshot = structuredClone(target.values);
  await assert.rejects(importIntoEmptyGoogleSession(target, [raw({ value: 'new' })]), { code: 'EXISTING_LOGIN_PROTECTED' });
  assert.deepEqual(target.values, snapshot);
});
test('failed import rolls back only newly written cookies and never exposes raw errors', async () => {
  const target = jar([{ domain: 'example.test', name: 'original', value: 'unchanged' }], 2), before = structuredClone(target.values);
  await assert.rejects(importIntoEmptyGoogleSession(target, [raw(), raw({ name: 'HSID' })]), error => error.code === 'COOKIE_IMPORT_FAILED' && !error.message.includes('secret'));
  assert.deepEqual(target.values, before);
});
test('successful import keeps every normalized cookie including host-only values', async () => {
  const target = jar(), { cookies: rows } = normalizeGoogleCookies([raw(), raw({ name: '__Host-test', domain: 'accounts.google.com' })]);
  assert.deepEqual(await importIntoEmptyGoogleSession(target, rows), { importedCount: 2, skippedPartitioned: 0 }); assert.deepEqual(target.values, rows);
});

for (const outcome of ['success', 'read-failure', 'write-failure', 'cancel']) test(`temporary login cleans its own profile on ${outcome}, waits for user confirmation before reading`, async t => {
  const root = directory(t), order = [], target = jar([], outcome === 'write-failure' ? 1 : -1);
  const browser = { kind: 'firefox', executable: process.execPath };
  const run = new TemporaryBrowserLogin({ root, browser, launch(executable, args) { assert.equal(executable, process.execPath); assert.ok(args.includes('-no-remote')); assert.ok(args.includes('-profile')); assert.equal(args.some(a => a.includes('debugging')), false); order.push('launch'); const child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; },
    read() { order.push('read'); if (outcome === 'read-failure') throw Error('raw secret'); return normalizeGoogleCookies([raw()]); },
    async stop() { order.push('stop'); } });
  await run.start(); assert.deepEqual(order, ['launch']); assert.ok(fs.existsSync(run.profile));
  await assert.rejects(run.complete({ userConfirmed: false, target }), { code: 'USER_CONFIRMATION_REQUIRED' }); assert.deepEqual(order, ['launch']);
  if (outcome === 'cancel') { await run.cancel(); assert.deepEqual(order, ['launch', 'stop']); }
  else if (outcome === 'success') { assert.equal((await run.complete({ userConfirmed: true, target })).tempRemoved, true); assert.equal(target.values.length, 1); }
  else await assert.rejects(run.complete({ userConfirmed: true, target }));
  assert.equal(fs.existsSync(run.profile), false);
  if (outcome !== 'success') assert.equal(target.values.length, 0);
});
test('cleanup rejects parent paths and symlinked temp profiles', t => {
  const root = directory(t);
  assert.throws(() => assertTempProfile(root, root), { code: 'UNSAFE_TEMP_PATH' });
  assert.throws(() => assertTempProfile(root, path.join(root, '../other')), { code: 'UNSAFE_TEMP_PATH' });
  const target = path.join(root, 'unrelated'); fs.mkdirSync(target);
  const link = path.join(root, 'login-00000000-0000-0000-0000-000000000000');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertTempProfile(root, link), { code: 'UNSAFE_TEMP_PATH' });
});
test('browser launch failure removes its temp directory before returning', async t => {
  const root = directory(t);
  const run = new TemporaryBrowserLogin({ root, browser: { kind: 'firefox', executable: process.execPath }, launch() {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('error', Error('synthetic launch failure'))); return child;
  } });
  await assert.rejects(run.start(), { code: 'BROWSER_LAUNCH_FAILED' });
  assert.equal(fs.existsSync(run.profile), false);
});

test('Firefox close error after process exit does not discard the login before Cookie reading', async t => {
  const root = directory(t), target = jar(), order = [];
  const run = new TemporaryBrowserLogin({ root, browser: { kind: 'firefox', executable: process.execPath },
    launch() { const child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; },
    stop: profile => closeBrowser(profile, { processes: async (_profile, action) => {
      assert.equal(_profile, run.profile); order.push(action || 'query');
      if (action === 'close') throw Error('process already exited');
      return [];
    }, wait: async () => assert.fail('An exited profile needs no wait') }),
    read() { order.push('read'); return normalizeGoogleCookies([raw()]); } });
  await run.start();const result = await run.complete({ userConfirmed: true, target });
  assert.equal(result.importedCount, 1);assert.equal(result.tempRemoved, true);
  assert.ok(order.indexOf('query') < order.indexOf('read'));assert.equal(target.values.length, 1);
});

test('Firefox close waits for actual exit after a raced close error', async () => {
  let queries = 0, waits = 0;
  await closeBrowser('owned-profile', { processes: async (_profile, action) => {
    if (action === 'close') throw Error('child exited while parent is closing');
    return ++queries < 3 ? [123] : [];
  }, wait: async () => { waits++; } });
  assert.equal(queries, 3);assert.equal(waits, 2);
});

test('Firefox close never assumes success when its profile still runs or process queries fail', async () => {
  await assert.rejects(closeBrowser('owned-profile', { processes: async (_profile, action) => {
    if (action === 'close') throw Error('private native detail');return [123];
  }, wait: async () => {} }), e => e.code === 'BROWSER_CLOSE_FAILED' && !e.message.includes('private'));
  await assert.rejects(closeBrowser('owned-profile', { processes: async () => { throw Error('private native detail'); } }),
    e => e.code === 'BROWSER_PROCESS_QUERY_FAILED' && !e.message.includes('private'));
});
