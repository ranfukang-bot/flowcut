import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { loadAllAccounts } from './config.js';
import { fetchMedia, imageType, verifyVideo } from './workflow-media.js';

export function accountFolder(root, name) {
  const label = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'account';
  return path.join(root, 'videos', `${label}-${createHash('sha256').update(String(name)).digest('hex').slice(0, 10)}`);
}
function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || '')), b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
export function normalizePickedProduct(row) {
  const linked = String(row.url || '').match(/\/detail\/(\d+)/)?.[1];
  const raw = row.productId || linked;
  if (typeof raw !== 'string' || !/^\d{10,30}$/.test(raw)) throw new Error('商品 ID 必须是完整的数字文本，请重新从 FastMoss 导出');
  if (linked && raw !== linked) throw new Error('商品 ID 与 FastMoss 详情链接不一致');
  return { ...row, productId: raw, name: String(row.name || '').slice(0, 300), region: String(row.region || '').slice(0, 20) };
}
async function flowcutApi(route, init = {}) {
  const base = process.env.FLOWCUT_URL;
  const response = await fetch(base + route, {
    ...init, headers: { 'x-flowcut-desktop-token': process.env.FLOWCUT_DESKTOP_TOKEN, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `FlowCut HTTP ${response.status}`);
  return result;
}
export async function importProducts(rows, root, api = flowcutApi) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('每次请选择 1–100 个商品');
  const normalized = rows.map(normalizePickedProduct);
  const workspace = await api('/api/workspace');
  const known = new Map(workspace.products.filter(p => p.external_id).map(p => [p.external_id, p.id]));
  const results = [];
  for (const row of normalized) {
    if (known.has(row.productId)) { results.push({ productId: row.productId, id: known.get(row.productId), existing: true }); continue; }
    const form = new FormData();
    form.set('name', row.name); form.set('externalId', row.productId);
    form.set('country', row.region);
    form.set('features', [row.category, row.region && `市场：${row.region}`, row.url && `FastMoss：${row.url}`].filter(Boolean).join('\n'));
    let warning = '';
    const temp = path.join(root, 'temp', randomUUID() + '.image');
    try {
      if (row.imageUrl) {
        await fetchMedia(row.imageUrl, temp, { maxBytes: 12 * 1024 * 1024, referer: 'https://www.fastmoss.com/', timeoutMs: 10_000, budgetMs: 15_000 });
        const bytes = fs.readFileSync(temp), image = imageType(bytes);
        form.append('images', new Blob([bytes], { type: image.type }), `product.${image.ext}`);
      } else warning = '未获取商品图，请在 FlowCut 中补充图片';
    } catch { warning = '商品图读取失败，商品 ID 已保留，请在 FlowCut 中补充图片'; }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    const result = await api('/api/products', { method: 'POST', body: form });
    known.set(row.productId, result.id);
    results.push({ productId: row.productId, id: result.id, warning });
  }
  return { total: results.length, added: results.filter(r => !r.existing).length, results };
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file);
}
export function releaseVideo({ task, account, root, downloadRoot, confirmed }) {
  if (confirmed !== true) throw new Error('请先确认已检查成片，且已给对应账号添加橱窗');
  if (!['video_ready', 'scheduled'].includes(task.status)) throw new Error('视频尚未生成完成');
  const productId = task.product_external_id;
  if (typeof productId !== 'string' || !/^\d{10,30}$/.test(productId)) throw new Error('请先补全这个商品的 TikTok 商品 ID');
  if (!task.tiktok_account_name || account.name !== task.tiktok_account_name) throw new Error('发布账号必须与制作时选择的 TK 归档账号一致，请先在发布管理中核对账号名称');
  const ledgerFile = path.join(root, 'state', 'flowcut-reviews.json');
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
  const key = createHash('sha256').update(`${task.id}\0${account.name}`).digest('hex');
  if (ledger[key]?.status === 'released') return { ...ledger[key], alreadyReleased: true };
  const source = fs.realpathSync(task.download_path || '');
  const allowedRoot = fs.realpathSync(task.archive_directory || downloadRoot);
  const relative = path.relative(allowedRoot, source);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('成片路径不在 FlowCut 下载目录内');
  verifyVideo(source);
  const folder = accountFolder(root, account.name);
  if (path.resolve(account.videoFolder) !== path.resolve(folder)) throw new Error('发布目录不一致，请先在发布管理中保存账号设置');
  const file = path.join(folder, key, productId + '.mp4');
  const digest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const record = { taskId: task.id, accountName: account.name, productId, file, digest, status: 'copying', reviewedAt: new Date().toISOString() };
  ledger[key] = record; writeJson(ledgerFile, ledger);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) throw new Error('目标文件内容不一致，已阻止重复放行');
  record.status = 'released'; writeJson(ledgerFile, ledger);
  return record;
}
export function installFlowCutRoutes(app, express, root) {
  let imports = Promise.resolve();
  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const local = origin === process.env.FLOWCUT_URL;
    if (extension || local) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Workflow-Key, X-Flowcut-Desktop-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    const connectorRoute = ['/api/workflow/products/import', '/api/flowcut/open'].includes(req.path);
    const desktop = sameSecret(req.headers['x-flowcut-desktop-token'], process.env.FLOWCUT_DESKTOP_TOKEN);
    const connector = connectorRoute && sameSecret(req.headers['x-workflow-key'], process.env.FLOWCUT_CONNECTOR_KEY);
    if (!desktop && !connector) return res.status(401).json({ error: '请从 FlowCut 打开此页面，或重新加载 FlowCut 选品插件' });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/flowcut/health', (_req, res) => res.json({ app: 'flowcut-publisher', running: true }));
  app.post('/api/flowcut/open', (_req, res) => { process.parentPort?.postMessage({ type: 'show-workbench' }); res.json({ ok: true }); });
  app.post('/api/workflow/products/import', (req, res) => {
    const operation = imports.then(() => importProducts(req.body.rows, root));
    imports = operation.catch(() => {});
    operation.then(result => res.json(result), error => res.status(400).json({ error: error.message }));
  });
  app.post('/api/flowcut/review', async (req, res) => {
    try {
      const workspace = await flowcutApi('/api/workspace');
      const task = workspace.tasks.find(t => t.id === req.body.taskId);
      if (!task) throw new Error('任务不存在，请刷新 FlowCut 任务列表');
      const account = loadAllAccounts().find(a => a.name === task.tiktok_account_name);
      if (!account) throw new Error(`请先在发布管理中添加同名账号：${task.tiktok_account_name}`);
      const seedance = JSON.parse(fs.readFileSync(process.env.FLOWCUT_SEEDANCE_STATE, 'utf8'));
      res.json(releaseVideo({ task, account, root, downloadRoot: seedance.settings.downloadDirectory, confirmed: req.body.confirmed }));
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}
