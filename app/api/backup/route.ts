import { ensureWorkspace, getDb, jsonError, runtimeEnv } from '../../../lib/storage';
import { exportTables, restoreTables } from '../../../lib/backup-data';

function desktopOnly() {
  if (runtimeEnv().FLOWCUT_DESKTOP_RUNTIME !== '1') throw new Error('数据备份仅支持本机桌面程序');
}
export async function GET() {
  try {
    desktopOnly(); await ensureWorkspace();
    const tables = await exportTables(getDb());
    const bucket = runtimeEnv().MEDIA;
    if (!bucket) throw new Error('本机媒体库未连接');
    const media = []; let cursor: string | undefined;
    do {
      const page = await bucket.list({ cursor, include: ['httpMetadata', 'customMetadata'] });
      media.push(...page.objects.map(item => ({ key: item.key, httpMetadata: item.httpMetadata || {}, customMetadata: item.customMetadata || {} })));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return Response.json({ tables, media }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
export async function POST(request: Request) {
  try {
    desktopOnly(); await ensureWorkspace();
    const body = await request.json() as { tables: Parameters<typeof restoreTables>[1] };
    return Response.json({ counts: await restoreTables(getDb(), body.tables) });
  } catch (error) { return jsonError(error); }
}
export async function PUT(request: Request) {
  try {
    desktopOnly();
    const key = new URL(request.url).searchParams.get('key');
    if (!key || !runtimeEnv().MEDIA) throw new Error('媒体参数无效');
    const metadata = JSON.parse(decodeURIComponent(request.headers.get('x-flowcut-media-metadata') || '%7B%7D'));
    await runtimeEnv().MEDIA!.put(key, request.body!, { httpMetadata: metadata.httpMetadata || {}, customMetadata: metadata.customMetadata || {} });
    return Response.json({ ok: true });
  } catch (error) { return jsonError(error); }
}
