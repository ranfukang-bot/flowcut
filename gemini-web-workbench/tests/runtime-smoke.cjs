// Exercises the packaged dependency subset, real HTTP routes, and rendered UI.
// All data belongs to an isolated temporary profile; no live accounts are used.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const packageRoot = path.resolve(process.argv[2] || path.join(__dirname, "../release/win-unpacked"));
const packageVersion = JSON.parse(require("@electron/asar").extractFile(path.join(packageRoot, "resources/app.asar"), "package.json")).version;
const site = path.join(packageRoot, "resources/flowcut-site");
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
const { unstable_dev } = require(path.join(site, "node_modules/wrangler/wrangler-dist/cli.js"));
const { chromium } = require(process.env.FLOWCUT_PLAYWRIGHT_PATH || "playwright-core");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-smoke-"));
const evidence = path.resolve(__dirname, "../verification");
fs.mkdirSync(evidence, { recursive: true });
let worker, browser;
const token = crypto.randomBytes(32).toString("hex");
const headers = { "x-flowcut-desktop-token": token, "content-type": "application/json" };
async function main() {
  worker = await unstable_dev(path.join(site, "dist/server/index.js"), {
    config: path.join(site, "dist/server/wrangler.json"), ip: "127.0.0.1", port: 4197,
    persistTo: temporary,
    vars: { FLOWCUT_PERSONAL_MODE: "1", FLOWCUT_DESKTOP_RUNTIME: "1", FLOWCUT_DESKTOP_TOKEN: token, CREDENTIALS_MASTER_KEY: crypto.randomBytes(32).toString("base64") },
    experimental: { watch: false, disableExperimentalWarning: true },
  });
  const base = "http://127.0.0.1:4197";
  async function api(route, options = {}) {
    const response = await fetch(base + route, { ...options, headers: { ...headers, ...options.headers } });
    assert.equal(response.ok, true, `${route}: ${response.status}`);
    return response.json();
  }
  assert.equal((await fetch(base + "/api/workspace")).status, 401);
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "gemini", config: { mode: "web" } }) });
  const testGemini = () => fetch(base + "/api/settings", { method: "POST", headers, body: JSON.stringify({ provider: "gemini", config: { mode: "web" } }) });
  assert.equal((await testGemini()).status, 409, '离线执行器仍然不能通过连接测试');
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "seedance", config: { mode: "local-api" }, apiKey: "smoke-bridge-only" }) });
  await api("/api/gemini-bridge", { method: "POST", headers: { authorization: "Bearer smoke-bridge-only" }, body: JSON.stringify({
    action: "heartbeat", workerId: "test-worker", queueRunning: false, accounts: [{ id: "not-logged-in", name: "未登录", authenticated: false }],
  }) });
  assert.equal((await testGemini()).status, 409, '在线但未登录仍然不能通过连接测试');
  await api("/api/gemini-bridge", { method: "POST", headers: { authorization: "Bearer smoke-bridge-only" }, body: JSON.stringify({
    action: "heartbeat", workerId: "test-worker", queueRunning: false, activeCount: 1,
    accounts: [{ id: "test-account", name: "测试账号", authenticated: true }, { id: "test-account-2", name: "测试账号2", authenticated: true }],
    activeJobs: [{ taskId: "test-running", accountName: "测试账号", stage: "Gemini 正在生成 · 已接收 320 字 · 12 秒" }],
  }) });
  assert.equal((await api("/api/workspace")).integrations.gemini, true, '已登录但队列暂停：必须允许创建任务');
  const pausedConnection = await testGemini();
  assert.equal(pausedConnection.status, 200);
  assert.match((await pausedConnection.json()).message, /队列已暂停/);
  assert.equal((await api("/api/workspace")).integrations.geminiRuntime.queueRunning, false, '测试连接不能启动历史任务');
  assert.equal((await fetch(base + "/api/license/session", { headers })).status, 404);
  assert.equal((await fetch(base + "/api/updates/windows/latest.yml", { headers })).status, 404);
  const product = new FormData(); product.set("externalId", "1735360337668113923"); product.set("name", "选品导入测试");
  const createdResponse = await fetch(base + "/api/products", { method: "POST", headers: { "x-flowcut-desktop-token": token }, body: product });
  assert.equal(createdResponse.status, 201); const created = await createdResponse.json();
  const attachments = new FormData(); attachments.set("id", created.id);
  attachments.append("images", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWzUAAAAASUVORK5CYII=", "base64")], { type: "image/png" }), "sample.png");
  const added = await fetch(base + "/api/products", { method: "PATCH", headers: { "x-flowcut-desktop-token": token }, body: attachments });
  assert.equal(added.status, 200);
  const workspace = await api("/api/workspace");
  assert.equal(workspace.products[0].external_id, "1735360337668113923");
  assert.equal(workspace.products[0].images.length, 1);
  assert.equal(workspace.integrations.geminiRuntime.activeJobs[0].taskId, "test-running");
  await api("/api/settings", { method: "PUT", body: JSON.stringify({ provider: "gemini", config: { mode: "web" } }) });
  await api("/api/tiktok-accounts", { method: "POST", body: JSON.stringify({ name: "clear-test" }) });
  const testGem = await api("/api/gems", { method: "POST", body: JSON.stringify({ name: "clear-test", content: "Test template" }) });
  for (let i = 0; i < 65; i++) await api("/api/tasks", { method: "POST", body: JSON.stringify({ productId: created.id, gemId: testGem.id, tiktokAccountName: "clear-test" }) });
  assert.equal((await api("/api/workspace")).tasks.length, 60);
  const cleared = await api("/api/tasks?all=1", { method: "DELETE" });
  assert.equal(cleared.deleted, 65); assert.equal(cleared.ids.length, 65);
  const retained = await api("/api/workspace");
  assert.equal(retained.tasks.length, 0); assert.equal(retained.products.length, workspace.products.length);
  assert.equal(retained.products[0].images.length, 1); assert.equal(retained.gems.length, workspace.gems.length + 1);
  const archiveAccount = await api("/api/tiktok-accounts", { method: "POST", body: JSON.stringify({ name: "archive-test", archiveDirectory: "D:\\Videos\\Original" }) });
  const oldContent = "CHOSEN_TEMPLATE_143: original instructions";
  await api("/api/gems", { method: "PUT", body: JSON.stringify({ id: testGem.id, name: "clear-test", content: oldContent }) });
  const archivedTask = await api("/api/tasks", { method: "POST", body: JSON.stringify({ productId: created.id, gemId: testGem.id, tiktokAccountName: "archive-test" }) });
  await api("/api/tiktok-accounts", { method: "PUT", body: JSON.stringify({ id: archiveAccount.id, archiveDirectory: "E:\\Videos\\Changed" }) });
  await api("/api/gems", { method: "PUT", body: JSON.stringify({ id: testGem.id, name: "clear-test", content: "NEW_TEMPLATE_MUST_NOT_REPLACE_OLD_TASK" }) });
  await api("/api/products", { method: "PUT", body: JSON.stringify({ id: created.id, name: "选品导入测试", externalId: "1735360337668113999" }) });
  const bridgeHeaders = { authorization: "Bearer smoke-bridge-only" };
  const jobs = await api("/api/gemini-bridge?workerId=archive-smoke&capacity=1", { headers: bridgeHeaders });
  assert.equal(jobs.jobs[0].id, archivedTask.id);
  assert.match(jobs.jobs[0].prompt, /CHOSEN_TEMPLATE_143/);
  assert.doesNotMatch(jobs.jobs[0].prompt, /NEW_TEMPLATE_MUST_NOT_REPLACE/);
  await api("/api/gemini-bridge", { method: "POST", headers: bridgeHeaders, body: JSON.stringify({ action: "result", taskId: archivedTask.id, workerId: "archive-smoke", prompt: "Video prompt ".repeat(40) }) });
  const videoJobs = await api("/api/seedance-bridge?workerId=archive-smoke", { headers: bridgeHeaders });
  assert.equal(videoJobs.jobs[0].id, archivedTask.id);
  assert.equal(videoJobs.jobs[0].archiveDirectory, "D:\\Videos\\Original");
  assert.equal(videoJobs.jobs[0].productExternalId, "1735360337668113923");
  const archiveRow = (await api("/api/workspace")).tasks[0];
  assert.equal(archiveRow.archive_directory, "D:\\Videos\\Original");
  assert.equal(archiveRow.product_external_id, "1735360337668113923");
  await api("/api/tasks?all=1", { method: "DELETE" });
  const originalProduct = workspace.products[0];
  workspace.products = [
    { ...originalProduct, id: "old-day", created_at: "2026-09-15T04:00:00Z" },
    { ...originalProduct, id: "new-day", created_at: "2026-09-17T04:00:00Z" },
  ];
  const task = { product_id: "product-test", product_external_id: "1735360337668113923", gem_id: "gem-test", title: "商品视频", product_name: "测试商品", provider: "gemini-web", prompt: "", duration: 15, region: "印度尼西亚", shooting_style: "", gem_name: "带货模板", tiktok_account_name: "测试TK账号", created_at: new Date().toISOString() };
  workspace.tasks = [
    { ...task, id: "test-running", status: "prompt_generating", progress: 12 },
    { ...task, id: "test-failed", title: "待恢复任务", product_name: "待恢复商品", status: "failed", progress: 12, error: "Gemini 连续 3 分钟没有新输出，任务将自动恢复" },
    { ...task, id: "test-ready", product_name: "已完成商品", status: "video_ready", progress: 100 },
  ];
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  // Browser supplies the correct multipart boundary for image uploads.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { "x-flowcut-desktop-token": token } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/workspace", route => route.fulfill({ json: workspace }));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("navigation").getByRole("button", { name: "任务队列" }).waitFor();
  assert.equal(await page.getByRole("navigation").getByRole("button", { name: "剧本提示词" }).count(), 0);
  assert.equal(await page.getByText("本月生成额度").count(), 0);
  assert.equal(await page.getByText("个人本机版", { exact: true }).count(), 1);
  assert.equal(await page.getByText("退出账号", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "检查更新", exact: true }).count(), 0);
  await require('./image-product-id-ui.cjs')(page, api);
  await page.screenshot({ path: path.join(evidence, "创作中心.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "更多工具" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "剧本提示词" }).waitFor();
  await page.getByRole("button", { name: "更多工具" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "任务队列" }).click();
  await page.getByText("测试账号 · Gemini 正在生成 · 已接收 320 字 · 12 秒").waitFor();
  assert.equal(await page.locator(".nav-list button.active").innerText(), "↗\n任务队列\n3");
  await page.screenshot({ path: path.join(evidence, "任务进度.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "需处理", exact: true }).click();
  assert.equal(await page.locator(".table-row").count(), 1);
  await page.getByRole("button", { name: "查看 / 继续" }).waitFor();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索任务" }).fill("1735360337668113923");
  assert.equal(await page.locator(".table-row").count(), 3);
  await page.getByRole("textbox", { name: "搜索任务" }).fill("does-not-exist");
  await page.getByText("没有匹配的任务").waitFor();
  await page.getByRole("button", { name: "清除全部任务", exact: true }).waitFor();
  await page.getByRole("navigation").getByRole("button", { name: "商品库" }).click();
  assert.equal(await page.locator(".product-date-group").count(), 2);
  assert.match(await page.locator(".product-date-group h3").first().innerText(), /2026-09-17/);
  await page.getByLabel("添加日期", { exact: true }).selectOption("2026-09-15");
  assert.equal(await page.locator(".product-card").count(), 1);
  await page.getByLabel("添加日期", { exact: true }).selectOption("");
  await page.screenshot({ path: path.join(evidence, "商品按日期.png"), fullPage: true });
  // Exercise the actual template API and keyboard input after a confirmation.
  await page.unroute("**/api/workspace");
  await page.addInitScript(() => {
    window.queueStartCalls = [];
    window.modelDecisions = [];
    window.seedanceTestState = { ready: true, authenticated: true, settings: { running: false, downloadDirectory: "D:\\Videos" }, tasks: [], accountState: { activeAccountId: "ad-a", items: [{ id: "ad-a", name: "广告户 A", enabled: true, authenticated: true, preferredModel: "2000012", effectiveModel: "2000012", quotaDate: "2026-09-19" }] } };
    window.seedanceListeners = [];
    window.emitSeedanceTestState = () => window.seedanceListeners.forEach(listener => listener({ seedance: structuredClone(window.seedanceTestState) }));
    window.flowcutDesktop = {
      chooseArchiveDirectory: async () => "D:\\Chosen Videos\\中文归档",
      setQueueRunning: async value => window.queueStartCalls.push(["gemini", value]),
      seedanceSetRunning: async value => window.queueStartCalls.push(["seedance", value]),
      seedanceState: async () => structuredClone(window.seedanceTestState),
      onState: listener => { window.seedanceListeners.push(listener); return () => { window.seedanceListeners = window.seedanceListeners.filter(item => item !== listener); }; },
      seedanceSetPreferredModel: async (id, model) => {
        const account = window.seedanceTestState.accountState.items.find(item => item.id === id);
        account.preferredModel = model; account.effectiveModel = model;
        window.emitSeedanceTestState(); return structuredClone(window.seedanceTestState);
      },
      seedanceDecideFastFallback: async (id, choice, date) => {
        window.modelDecisions.push({ id, choice, date });
        const account = window.seedanceTestState.accountState.items.find(item => item.id === id);
        account.needsModelDecision = false; account.fallbackDecision = choice;
        account.effectiveModel = choice === "standard" ? "2000004" : "";
        window.emitSeedanceTestState(); return structuredClone(window.seedanceTestState);
      },
    };
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Gemini 已登录 · 队列已暂停", { exact: true }).waitFor();
  await page.getByRole("navigation").getByRole("button", { name: "账号与设置" }).click();
  const geminiCard = page.locator("form.connection-card").filter({ hasText: "提示词引擎" });
  await geminiCard.getByText("已登录 · 队列已暂停", { exact: true }).waitFor();
  assert.equal(await geminiCard.getByText("已登录 · 空闲", { exact: true }).count(), 2);
  await geminiCard.getByRole("button", { name: "测试连接", exact: true }).click();
  await page.getByText(/本次连接测试不会启动任务/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.queueStartCalls), []);
  await geminiCard.getByRole("button", { name: "启动 Gemini 队列", exact: true }).click();
  await page.getByRole("dialog", { name: "确认操作" }).getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.queueStartCalls), [], '取消队列启动不能启动任何任务');
  await page.screenshot({ path: path.join(evidence, "Gemini已登录队列暂停.png"), fullPage: true });
  await page.getByRole("navigation").getByRole("button", { name: "创作中心" }).click();
  await page.getByRole("button", { name: "＋ 添加", exact: true }).click();
  await page.getByLabel("归档名称（例如对应的 TK 账号）").fill("界面归档测试");
  await page.getByRole("button", { name: "选择保存文件夹", exact: true }).click();
  assert.equal(await page.getByLabel("视频保存文件夹", { exact: true }).inputValue(), "D:\\Chosen Videos\\中文归档");
  await page.getByRole("button", { name: "添加并选择", exact: true }).click();
  await page.getByText("成片自动保存到：", { exact: false }).filter({ hasText: "Chosen Videos" }).waitFor();
  assert.equal((await api("/api/tiktok-accounts")).accounts.find(a => a.name === "界面归档测试").archive_directory, "D:\\Chosen Videos\\中文归档");
  await page.getByRole("button", { name: "选择 / 更改保存文件夹", exact: true }).click();
  await page.screenshot({ path: path.join(evidence, "自选归档文件夹.png"), fullPage: true });
  await page.getByRole("radio", { name: /选择已有商品/ }).click();
  await page.getByRole("button", { name: /加入并发任务/ }).click();
  await page.getByText("任务已创建，将按所选模板生成并保存到归档文件夹", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.queueStartCalls), [["gemini", true], ["seedance", true]]);
  assert.equal((await api("/api/workspace")).tasks[0].archive_directory, "D:\\Chosen Videos\\中文归档");
  await api("/api/tasks?all=1", { method: "DELETE" });
  let nativeDialogs = 0;
  page.on("dialog", async dialog => { nativeDialogs++; await dialog.dismiss(); });
  await page.getByRole("navigation").getByRole("button", { name: "Gem 模板" }).click();
  await page.locator(".gem-card").filter({ hasText: "clear-test" }).getByRole("button", { name: "删除", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认操作" });
  await confirmation.waitFor(); await page.keyboard.press("Escape");
  assert.equal((await api("/api/workspace")).gems.length, 1);
  await page.getByRole("button", { name: "新建 Gem" }).click();
  let editor = page.getByRole("dialog", { name: "创建新的 Gem" });
  await editor.waitFor();
  await page.keyboard.type("Keyboard Gem");
  assert.equal(await editor.getByLabel("Gem 名称", { exact: true }).inputValue(), "Keyboard Gem");
  await editor.getByLabel("模板简介").fill("输入修复验证");
  await editor.getByLabel("完整 Gem 指令").click();
  await page.keyboard.insertText("中文输入第一行\n第二行 English 123");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  assert.match(await editor.getByLabel("完整 Gem 指令").inputValue(), /第二行 English 123/);
  await editor.getByRole("button", { name: "保存 Gem", exact: true }).click();
  await page.getByText("新 Gem 已创建", { exact: true }).waitFor();
  await page.locator(".gem-card").filter({ hasText: "Keyboard Gem" }).getByRole("button", { name: "编辑指令" }).click();
  editor = page.getByRole("dialog", { name: "编辑 Gem 指令" });
  await editor.getByLabel("完整 Gem 指令").fill("修改后的中文指令\n不会因刷新丢失");
  await page.route("**/api/gems", async route => {
    await route.fulfill({ status: 500, json: { error: "模拟保存失败" } });
  }, { times: 1 });
  await editor.getByRole("button", { name: "保存 Gem", exact: true }).click();
  await editor.getByRole("alert").getByText("模拟保存失败").waitFor();
  assert.match(await editor.getByLabel("完整 Gem 指令").inputValue(), /修改后的中文指令/);
  await editor.getByRole("button", { name: "保存 Gem", exact: true }).click();
  await page.getByText("Gem 已更新", { exact: true }).waitFor();
  const savedGem = (await api("/api/workspace")).gems.find(g => g.name === "Keyboard Gem");
  assert.equal(savedGem.content, "修改后的中文指令\n不会因刷新丢失");
  await page.locator(".gem-card").filter({ hasText: "clear-test" }).getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "确认操作" }).getByRole("button", { name: "确认", exact: true }).click();
  await page.getByText("已删除", { exact: true }).waitFor();
  assert.equal((await api("/api/workspace")).gems.length, 1);
  assert.equal(nativeDialogs, 0);
  await page.locator(".gem-card").filter({ hasText: "Keyboard Gem" }).getByRole("button", { name: "编辑指令" }).click();
  await page.screenshot({ path: path.join(evidence, "Gem编辑验证.png"), fullPage: true });
  await page.getByRole("dialog", { name: "编辑 Gem 指令" }).getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "账号与设置" }).click();
  await page.getByLabel("广告户 A 首选模型", { exact: true }).selectOption("2000004");
  await page.getByText("当前使用：Seedance 2.0", { exact: true }).waitFor();
  await page.getByLabel("广告户 A 首选模型", { exact: true }).selectOption("2000012");
  assert.deepEqual(await page.getByLabel("广告户 A 首选模型", { exact: true }).locator("option").evaluateAll(options => options.map(option => option.value)), ["2000012", "2000004"]);
  await page.getByRole("navigation").getByRole("button", { name: "创作中心" }).click();
  await page.evaluate(() => { Object.assign(window.seedanceTestState.accountState.items[0], { fastExhaustedToday: true, needsModelDecision: true, effectiveModel: "", quotaReason: "daily quota exceeded" }); window.emitSeedanceTestState(); });
  const quotaNotice = page.getByRole("status", { name: "广告户 A Fast 额度提醒" });
  await quotaNotice.getByRole("button", { name: "今天改用 2.0（消耗更高）" }).click();
  await page.getByRole("dialog", { name: "确认操作" }).getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.modelDecisions), []);
  await page.screenshot({ path: path.join(evidence, "Fast额度提醒.png"), fullPage: true });
  await quotaNotice.getByRole("button", { name: "等待 Fast 恢复" }).click();
  assert.equal((await page.evaluate(() => window.modelDecisions))[0].choice, "wait");
  await page.evaluate(() => { window.seedanceTestState.accountState.items[0].needsModelDecision = true; window.emitSeedanceTestState(); });
  await quotaNotice.getByRole("button", { name: "今天改用 2.0（消耗更高）" }).click();
  await page.getByRole("dialog", { name: "确认操作" }).getByRole("button", { name: "确认", exact: true }).click();
  assert.equal((await page.evaluate(() => window.modelDecisions))[1].choice, "standard");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, "runtime-smoke.json"), JSON.stringify({ passed: true, version: packageVersion, checks: ["packaged runtime startup", "desktop HTTP authentication", "Gemini progress round trip", "paused authenticated accounts can create tasks", "connection test never starts queues", "queue resume cancellation", "compact navigation", "task filtering", "product ID search", "first-image filename product ID", "append/manual-edit/reset behavior", "product ID multipart save", "no renderer errors"] }, null, 2));
  console.log("Packaged runtime and UI smoke: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await worker?.stop();
  if (temporary.startsWith(path.join(os.tmpdir(), "flowcut-smoke-"))) fs.rmSync(temporary, { recursive: true, force: true });
});
