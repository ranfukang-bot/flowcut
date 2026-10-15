const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { desktopRequestHeaders, protectMainNavigation, securedIpcHandle } = require('../src/desktop-security');
const report = require('./helpers/electron-test-report.cjs');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const windows = [], servers = [], external = [];
  const listen = async handler => {
    const server = http.createServer(handler); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const echo = (request, response) => { response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); response.end(JSON.stringify({ token: request.headers['x-flowcut-desktop-token'] || null })); };
  try {
    const otherOrigin = await listen(echo);
    const siteUrl = await listen((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: otherOrigin + '/probe' }); response.end(); }
      else if (request.url === '/probe') echo(request, response);
      else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<body>isolated security fixture</body>'); }
    });
    const sessionName = `security-test-${process.pid}`;
    const main = new BrowserWindow({ show: false, webPreferences: { partition: sessionName, preload: path.resolve(__dirname, '../src/preload-ui.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(main);
    const foreign = new BrowserWindow({ show: false, webPreferences: { partition: sessionName, preload: path.resolve(__dirname, '../src/preload-ui.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(foreign);
    const worker = new BrowserWindow({ show: false, webPreferences: { partition: `security-worker-${process.pid}`, preload: path.resolve(__dirname, '../src/gemini-preload-bridge.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(worker);
    const context = { mainId: main.webContents.id, geminiIds: [worker.webContents.id], siteUrl, publisherOrigin: 'http://127.0.0.1:18777', bootUrl: pathToFileURL(path.resolve(__dirname, '../src/boot.html')).href };
    let removals = 0;
    const handle = securedIpcHandle(ipcMain, () => context);
    handle('workbench:get-state', () => ({ ok: true }));
    handle('account:remove', () => { removals++; return true; });
    handle('gemini:select-model', () => ({ ok: true }));
    protectMainNavigation(main.webContents, () => context, url => external.push(url));
    main.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => callback({ requestHeaders: desktopRequestHeaders(details, context, 'isolated-test-token') }));
    await main.loadURL(siteUrl); await foreign.loadURL(siteUrl); await worker.loadURL('data:text/html,isolated-worker');
    const run = (window, script) => window.webContents.executeJavaScript(script, true);
    assert.deepEqual(await run(main, 'flowcutDesktop.getState()'), { ok: true });
    assert.match(await run(foreign, 'flowcutDesktop.removeAccount("fixture").catch(error=>error.message)'), /来源无效/); assert.equal(removals, 0);
    await run(main, 'flowcutDesktop.removeAccount("fixture")'); assert.equal(removals, 1);
    assert.deepEqual(await run(worker, 'flowcutGeminiNative.selectModel()'), { ok: true });
    for (const window of windows) assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    report({ pass: true, scenario: 'sandboxed real preloads work; foreign renderer cannot invoke main business IPC' });
    assert.equal((await run(main, 'fetch("/probe").then(response=>response.json())')).token, 'isolated-test-token');
    assert.equal((await run(foreign, 'fetch("/probe").then(response=>response.json())')).token, null);
    assert.equal((await run(main, 'fetch("/redirect").then(response=>response.json())')).token, null);
    report({ pass: true, scenario: 'real main requests receive token; foreign window and cross-origin redirect do not' });
    await run(main, 'window.open("https://example.test/docs"); true');
    await run(main, 'location.href="https://example.test/disallowed"; true');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(new URL(main.webContents.getURL()).origin, siteUrl);
    assert.equal(BrowserWindow.getAllWindows().length, 3);
    assert.ok(external.includes('https://example.test/docs')); assert.ok(external.includes('https://example.test/disallowed'));
    report({ pass: true, scenario: 'main navigation and new windows are denied; HTTPS is delegated without navigating the app' });
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
  app.exit(0);
}).catch(error => { report({ pass: false, error: String(error.stack || error) }); app.exit(1); });
