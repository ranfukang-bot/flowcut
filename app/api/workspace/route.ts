import {
  ensureWorkspace,
  getDb,
  getProviderRuntime,
  jsonError,
} from "../../../lib/storage";
import { getProviderConfig } from "../../../lib/provider-config";

export async function GET() {
  try {
    await ensureWorkspace();
    const db = getDb();
    const [gems, products, productImages, tasks, schedules, tiktokAccounts, referenceRemixTasks, referenceRemixAssets, referenceRemixSettings, scriptPipelineTasks, gemini, geminiRuntime, seedance, seedanceRuntime] = await Promise.all([
      db.prepare("SELECT * FROM gems ORDER BY is_default DESC, updated_at DESC").all(),
      db.prepare("SELECT * FROM products ORDER BY created_at DESC").all(),
      db.prepare("SELECT * FROM product_images ORDER BY sort_order ASC").all(),
      db
        .prepare(
          `SELECT t.*, p.name AS product_name, COALESCE(t.product_external_id_snapshot, p.external_id) AS product_external_id, g.name AS gem_name,
                  (SELECT COUNT(*) FROM product_images pi
                   WHERE pi.product_id = t.product_id) AS image_count
           FROM tasks t
           LEFT JOIN products p ON p.id = t.product_id
           LEFT JOIN gems g ON g.id = t.gem_id
           ORDER BY t.created_at DESC LIMIT 60`
        )
        .all(),
      db
        .prepare(
          `SELECT s.*, t.title AS task_title
           FROM schedules s LEFT JOIN tasks t ON t.id = s.task_id
           ORDER BY s.scheduled_at ASC LIMIT 60`
        )
        .all(),
      db
        .prepare("SELECT * FROM tiktok_accounts ORDER BY created_at ASC")
        .all(),
      db
        .prepare("SELECT * FROM reference_remix_tasks ORDER BY created_at DESC LIMIT 60")
        .all(),
      db
        .prepare("SELECT * FROM reference_remix_assets ORDER BY sort_order ASC")
        .all(),
      db
        .prepare("SELECT duration, region FROM reference_remix_settings WHERE id = 'default'")
        .first(),
      db.prepare("SELECT * FROM script_pipeline_tasks ORDER BY created_at DESC LIMIT 60").all(),
      getProviderConfig("gemini"),
      getProviderRuntime("gemini-web"),
      getProviderConfig("seedance"),
      getProviderRuntime("seedance"),
    ]);
    const imagesByProduct = new Map<string, unknown[]>();
    for (const image of productImages.results as Array<Record<string, unknown>>) {
      const key = String(image.product_id);
      imagesByProduct.set(key, [...(imagesByProduct.get(key) || []), image]);
    }
    const productRows = (products.results as Array<Record<string, unknown>>).map(
      (product) => ({
        ...product,
        images: imagesByProduct.get(String(product.id)) || [],
      })
    );
    const remixAssetsByTask = new Map<string, unknown[]>();
    for (const asset of referenceRemixAssets.results as Array<Record<string, unknown>>) {
      const key = String(asset.task_id);
      remixAssetsByTask.set(key, [...(remixAssetsByTask.get(key) || []), asset]);
    }
    const referenceRemixRows = (
      referenceRemixTasks.results as Array<Record<string, unknown>>
    ).map((task) => ({
      ...task,
      assets: remixAssetsByTask.get(String(task.id)) || [],
    }));
    return Response.json(
      {
        gems: gems.results,
        products: productRows,
        tasks: tasks.results,
        schedules: schedules.results,
        tiktokAccounts: tiktokAccounts.results,
        referenceRemixTasks: referenceRemixRows,
        referenceRemixSettings: referenceRemixSettings || {
          duration: 15,
          region: "马来西亚",
        },
        scriptPipelineTasks: scriptPipelineTasks.results,
        integrations: {
          gemini:
            gemini.config.mode === "web"
              ? geminiRuntime.online &&
                Boolean(geminiRuntime.authenticated)
              : gemini.secretConfigured,
          geminiMode: gemini.config.mode,
          geminiRuntime,
          seedance:
            seedance.config.mode === "local-api"
              ? seedance.secretConfigured &&
                seedanceRuntime.online &&
                Boolean(seedanceRuntime.authenticated) &&
                Boolean(seedanceRuntime.queueRunning)
              : Boolean(seedance.config.endpoint),
          seedanceMode: seedance.config.mode,
          seedanceRuntime,
          tiktok: false,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
