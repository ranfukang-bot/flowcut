// Cookie values stay in memory. Callers must never log raw browser responses.
const fs = require('node:fs');
const path = require('node:path');

function loginError(code, message) { return Object.assign(new Error(message), { code }); }
function googleDomain(value) {
  if (typeof value !== 'string') return false;
  const host = value.replace(/^\./, '').toLowerCase();
  return /^[a-z0-9.-]+$/.test(host) && !host.includes('..') &&
    ['google.com', 'youtube.com'].some(root => host === root || host.endsWith('.' + root));
}

function normalizeGoogleCookies(rows, { source = 'electron', now = Date.now() / 1000 } = {}) {
  if (!Array.isArray(rows)) throw loginError('COOKIE_DATA_INVALID', '浏览器返回的登录资料无效');
  const normalized = new Map();
  let skippedPartitioned = 0;
  for (const row of rows) {
    let domain = source === 'firefox' ? row.host : row.domain;
    if (!domain && source === 'electron' && row.url) {
      try { const url = new URL(row.url); if (['https:', 'http:'].includes(url.protocol)) domain = url.hostname; } catch { /* Invalid rows are ignored. */ }
    }
    if (!googleDomain(domain)) continue;
    // A partitioned/container cookie cannot be faithfully imported into an
    // ordinary Electron cookie jar. Skip it without broadening its scope.
    if (row.partitionKey || row.partitionKeyOpaque || row.isPartitionedAttributeSet ||
        (source === 'firefox' && row.originAttributes)) {
      skippedPartitioned++;
      continue;
    }
    const secure = source === 'firefox' ? Boolean(row.isSecure) : Boolean(row.secure);
    const httpOnly = source === 'firefox' ? Boolean(row.isHttpOnly) : Boolean(row.httpOnly);
    const hostOnly = typeof row.hostOnly === 'boolean' ? row.hostOnly : !domain.startsWith('.');
    const host = domain.replace(/^\./, '').toLowerCase();
    const cookiePath = row.path || '/';
    if (typeof row.name !== 'string' || typeof row.value !== 'string' ||
        /[\x00-\x20;=]/.test(row.name) || !cookiePath.startsWith('/') || /[\r\n]/.test(cookiePath)) {
      throw loginError('COOKIE_DATA_INVALID', '浏览器返回的登录资料格式不受支持');
    }
    const cookie = { url: `${secure ? 'https' : 'http'}://${host}${cookiePath}`,
      name: row.name, value: row.value, path: cookiePath, secure, httpOnly };
    if (!hostOnly) cookie.domain = '.' + host;
    let sameSite;
    if (source === 'firefox') {
      // Firefox: NONE=0, LAX=1, STRICT=2. rawSameSite preserves unspecified.
      const raw = row.rawSameSite === 0 && row.sameSite === 1 ? 256 : (row.rawSameSite ?? row.sameSite);
      sameSite = raw === 2 ? 'strict' : raw === 1 ? 'lax' : raw === 0 ? 'no_restriction' : 'unspecified';
    } else {
      sameSite = { Strict: 'strict', Lax: 'lax', None: 'no_restriction',
        strict: 'strict', lax: 'lax', no_restriction: 'no_restriction', unspecified: 'unspecified' }[row.sameSite];
      if (row.sameSite !== undefined && !sameSite) throw loginError('COOKIE_DATA_INVALID', 'Cookie 的 SameSite 属性不受支持');
    }
    cookie.sameSite = sameSite || 'unspecified';
    const expires = source === 'firefox' ? row.expiry : (row.expirationDate ?? row.expires);
    const sessionCookie = source !== 'firefox' && (row.session === true || expires === -1);
    if (!sessionCookie && expires !== undefined) {
      if (!Number.isFinite(expires)) throw loginError('COOKIE_DATA_INVALID', 'Cookie 的有效期无效');
      if (expires <= now) continue;
      cookie.expirationDate = expires;
    }
    normalized.set([hostOnly, host, cookie.path, cookie.name].join('\0'), cookie);
  }
  return { cookies: [...normalized.values()], skippedPartitioned };
}

function readFirefoxGoogleCookies(profile, options = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(profile, 'cookies.sqlite');
  if (!fs.existsSync(file)) throw loginError('LOGIN_COOKIES_MISSING', 'Firefox 尚未保存登录，请先完成登录');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const columns = new Set(db.prepare('PRAGMA table_info(moz_cookies)').all().map(row => row.name));
    const names = ['name', 'value', 'host', 'path', 'expiry', 'isSecure', 'isHttpOnly', 'sameSite',
      'rawSameSite', 'originAttributes', 'isPartitionedAttributeSet'].filter(name => columns.has(name));
    if (!['name', 'value', 'host', 'path', 'expiry', 'isSecure', 'isHttpOnly'].every(name => columns.has(name))) {
      throw loginError('COOKIE_DATA_INVALID', 'Firefox 的 Cookie 数据结构不受支持');
    }
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    if (!Number.isInteger(schema) || schema < 1 || schema > 17) throw loginError('COOKIE_DATA_INVALID', 'Firefox Cookie 数据版本尚未验证');
    const rows = db.prepare(`SELECT ${names.join(',')} FROM moz_cookies`).all();
    if (schema >= 16) for (const row of rows) row.expiry /= 1000;
    return normalizeGoogleCookies(rows, { ...options, source: 'firefox' });
  } catch (error) {
    if (error.code && !String(error.code).startsWith('ERR_SQLITE')) throw error;
    throw loginError('COOKIE_READ_FAILED', 'Firefox 登录资料读取失败，未修改 FlowCut 账号');
  } finally { db?.close(); }
}

async function importIntoEmptyGoogleSession(target, rows, { skippedPartitioned: previouslySkipped = 0 } = {}) {
  // Experiments and new accounts only. Relogin replacement needs its separate
  // explicit confirmation and staging step; it must not reuse this guard.
  const existing = await target.cookies.get({});
  if (existing.some(cookie => googleDomain(cookie.domain))) {
    throw loginError('EXISTING_LOGIN_PROTECTED', '目标账号已有登录资料，已保护原登录，未覆盖');
  }
  const { cookies, skippedPartitioned } = normalizeGoogleCookies(rows);
  if (!cookies.some(cookie => ['SID', '__Secure-1PSID', '__Secure-3PSID'].includes(cookie.name))) {
    throw loginError('LOGIN_NOT_FINISHED', '尚未取得 Google 登录，请先在浏览器中完成登录');
  }
  const written = [];
  try {
    for (const cookie of cookies) { await target.cookies.set(cookie); written.push(cookie); }
    await target.cookies.flushStore();
    return { importedCount: written.length, skippedPartitioned: previouslySkipped + skippedPartitioned };
  } catch {
    let rolledBack = true;
    for (const cookie of written.reverse()) {
      try { await target.cookies.remove(cookie.url, cookie.name); } catch { rolledBack = false; }
    }
    try { await target.cookies.flushStore(); } catch { rolledBack = false; }
    throw loginError(rolledBack ? 'COOKIE_IMPORT_FAILED' : 'COOKIE_IMPORT_ROLLBACK_FAILED',
      rolledBack ? '导入失败，已清理本次新写入的登录资料；原账号未修改' : '新实验账号导入失败且清理不完整，请取消本次实验；原账号未修改');
  }
}

module.exports = { googleDomain, normalizeGoogleCookies, readFirefoxGoogleCookies,
  importIntoEmptyGoogleSession, loginError };
