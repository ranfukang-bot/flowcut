import { getProviderConfig } from "../../../lib/provider-config";
import {
  normalizeReferenceRemixDuration,
  normalizeReferenceRemixRegion,
  referenceRemixGemPreview,
} from "../../../lib/reference-remix";
import { ensureWorkspace, getDb, jsonError, runtimeEnv } from "../../../lib/storage";
import { validateTikTokAccountName } from "../../../lib/tiktok-accounts";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES_BYTES = 48 * 1024 * 1024;

function safeName(name: string) {
  return name.replace(/[^\w.\-\u4e00-\u9fff]+/g, "-").slice(-120) || "asset";
}

async function requireTikTokAccount(nameValue: unknown) {
  const name = validateTikTokAccountName(nameValue);
  const account = await getDb()
    .prepare("SELECT id FROM tiktok_accounts WHERE lower(name) = lower(?)")
    .bind(name)
    .first<{ id: string }>();
  if (!account) throw new Error("选择的 TK 账号不存在，请重新选择");
  return name;
}

export async function GET() {
  try {
    await ensureWorkspace();
    return Response.json({ gem: referenceRemixGemPreview() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const gemini = await getProviderConfig("gemini");
    if (gemini.config.mode !== "web") {
      return Response.json(
        { error: "爆款复刻需要 Gemini 网页 Pro，请先在接口设置中切换到网页工作台" },
        { status: 409 }
      );
    }
    const form = await request.formData();
    const video = form.get("video");
    const images = form
      .getAll("images")
      .filter((item): item is File => item instanceof File && item.size > 0);
    if (!(video instanceof File) || !video.size) {
      return Response.json({ error: "请上传一条对标视频" }, { status: 400 });
    }
    if (!video.type.startsWith("video/")) {
      return Response.json({ error: "对标素材必须是视频文件" }, { status: 400 });
    }
    if (video.size > MAX_VIDEO_BYTES) {
      return Response.json({ error: "对标视频不能超过 100MB" }, { status: 400 });
    }
    if (!images.length) {
      return Response.json({ error: "请至少上传 1 张产品图片" }, { status: 400 });
    }
    if (images.length > 12) {
      return Response.json({ error: "产品图片最多 12 张" }, { status: 400 });
    }
    if (images.reduce((total, file) => total + file.size, 0) > MAX_IMAGES_BYTES) {
      return Response.json({ error: "产品图片总大小不能超过 48MB" }, { status: 400 });
    }
    for (const file of images) {
      if (!file.type.startsWith("image/")) {
        return Response.json({ error: "产品素材中包含非图片文件" }, { status: 400 });
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return Response.json({ error: "单张产品图片不能超过 12MB" }, { status: 400 });
      }
    }

    const duration = normalizeReferenceRemixDuration(form.get("duration"));
    const region = normalizeReferenceRemixRegion(form.get("region"));
    const productName = String(form.get("productName") || "").trim();
    const externalId = String(form.get("externalId") || "").trim();
    const geminiAccountId = String(form.get("geminiAccountId") || "").trim();
    const tiktokAccountName = await requireTikTokAccount(form.get("tiktokAccountName"));
    const archiveAccount = await getDb().prepare("SELECT archive_directory FROM tiktok_accounts WHERE lower(name) = lower(?)").bind(tiktokAccountName).first<{ archive_directory: string }>();
    const autoQueue = String(form.get("autoQueue") || "true") !== "false";
    const saveToLibrary = String(form.get("saveToLibrary") || "false") === "true";
    const bucket = runtimeEnv().MEDIA;
    if (!bucket) throw new Error("素材存储尚未连接");

    const db = getDb();
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    const uploadedKeys: string[] = [];
    let productId: string | null = null;
    try {
      const videoId = crypto.randomUUID();
      const videoKey = `reference-remix/${taskId}/reference-${videoId}-${safeName(video.name)}`;
      const videoData = await video.arrayBuffer();
      await bucket.put(videoKey, videoData, {
        httpMetadata: { contentType: video.type || "video/mp4" },
      });
      uploadedKeys.push(videoKey);

      const imageRows: Array<{
        id: string;
        key: string;
        file: File;
        data: ArrayBuffer;
        order: number;
      }> = [];
      for (const [index, file] of images.entries()) {
        const id = crypto.randomUUID();
        const key = `reference-remix/${taskId}/product-${String(index + 1).padStart(2, "0")}-${id}-${safeName(file.name)}`;
        const data = await file.arrayBuffer();
        await bucket.put(key, data, {
          httpMetadata: { contentType: file.type },
        });
        uploadedKeys.push(key);
        imageRows.push({ id, key, file, data, order: index });
      }

      if (saveToLibrary) {
        productId = crypto.randomUUID();
        const libraryImages: Array<{ id: string; key: string; file: File; order: number }> = [];
        for (const item of imageRows) {
          const id = crypto.randomUUID();
          const key = `products/${productId}/${String(item.order + 1).padStart(2, "0")}-${id}-${safeName(item.file.name)}`;
          await bucket.put(key, item.data, {
            httpMetadata: { contentType: item.file.type },
          });
          uploadedKeys.push(key);
          libraryImages.push({ id, key, file: item.file, order: item.order });
        }
        await db
          .prepare(
            `INSERT INTO products
             (id, external_id, name, country, language, features, image_key, image_name, created_at)
             VALUES (?, ?, ?, '', '', '', ?, ?, ?)`
          )
          .bind(
            productId,
            externalId,
            productName,
            libraryImages[0]?.key || null,
            libraryImages[0]?.file.name || null,
            now
          )
          .run();
        await db.batch(
          libraryImages.map((item) =>
            db
              .prepare(
                `INSERT INTO product_images
                 (id, product_id, object_key, file_name, content_type, sort_order, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(item.id, productId, item.key, item.file.name, item.file.type, item.order, now)
          )
        );
      }

      await db
        .prepare(
          `INSERT INTO reference_remix_tasks
           (id, title, status, progress, duration, region, product_name,
            product_external_id, save_to_library, product_id, gemini_account_id,
            tiktok_account_name, archive_directory, auto_queue, provider, created_at, updated_at)
           VALUES (?, ?, 'reference_queued', 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gemini-web', ?, ?)`
        )
        .bind(
          taskId,
          `${productName || "图片识别商品"} · 爆款复刻`,
          duration,
          region,
          productName,
          externalId,
          saveToLibrary ? 1 : 0,
          productId,
          geminiAccountId || null,
          tiktokAccountName,
          archiveAccount?.archive_directory || "",
          autoQueue ? 1 : 0,
          now,
          now
        )
        .run();
      await db.batch([
        db
          .prepare(
            `INSERT INTO reference_remix_assets
             (id, task_id, kind, object_key, file_name, content_type, file_size, sort_order, created_at)
             VALUES (?, ?, 'reference_video', ?, ?, ?, ?, 0, ?)`
          )
          .bind(videoId, taskId, videoKey, video.name, video.type, video.size, now),
        ...imageRows.map((item) =>
          db
            .prepare(
              `INSERT INTO reference_remix_assets
               (id, task_id, kind, object_key, file_name, content_type, file_size, sort_order, created_at)
               VALUES (?, ?, 'product_image', ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              item.id,
              taskId,
              item.key,
              item.file.name,
              item.file.type,
              item.file.size,
              item.order,
              now
            )
        ),
      ]);
    } catch (error) {
      await Promise.all(uploadedKeys.map((key) => bucket.delete(key)));
      if (productId) {
        await db.batch([
          db.prepare("DELETE FROM product_images WHERE product_id = ?").bind(productId),
          db.prepare("DELETE FROM products WHERE id = ?").bind(productId),
        ]);
      }
      throw error;
    }
    return Response.json({ id: taskId, status: "reference_queued" }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as { duration?: number; region?: string };
    const duration = normalizeReferenceRemixDuration(body.duration);
    const region = normalizeReferenceRemixRegion(body.region);
    await getDb()
      .prepare(
        `INSERT INTO reference_remix_settings (id, duration, region, updated_at)
         VALUES ('default', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET duration = excluded.duration,
           region = excluded.region, updated_at = excluded.updated_at`
      )
      .bind(duration, region, new Date().toISOString())
      .run();
    return Response.json({ ok: true, duration, region });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as { id?: string; action?: string };
    if (!body.id) return Response.json({ error: "缺少复刻任务 ID" }, { status: 400 });
    const db = getDb();
    const now = new Date().toISOString();
    const task = await db
      .prepare("SELECT id, prompt FROM reference_remix_tasks WHERE id = ?")
      .bind(body.id)
      .first<{ id: string; prompt: string }>();
    if (!task) return Response.json({ error: "复刻任务不存在" }, { status: 404 });
    if (body.action === "retry") {
      await db
        .prepare(
          `UPDATE reference_remix_tasks SET status = 'reference_queued', progress = 5,
           reference_analysis = '', prompt = '', provider = 'gemini-web',
           provider_job_id = NULL, provider_status_url = NULL,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = 0, gemini_retry_at = NULL, output_url = NULL,
           download_path = NULL, download_error = NULL, error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .bind(now, body.id)
        .run();
      return Response.json({ ok: true });
    }
    if (body.action === "queue") {
      if (String(task.prompt || "").trim().length < 300) {
        return Response.json({ error: "最终提示词尚未生成完整" }, { status: 409 });
      }
      await db
        .prepare(
          `UPDATE reference_remix_tasks SET provider = 'seedance-bridge',
           status = 'video_queued', progress = 68, error = NULL,
           bridge_claimed_at = NULL, bridge_worker_id = NULL, updated_at = ?
           WHERE id = ?`
        )
        .bind(now, body.id)
        .run();
      return Response.json({ ok: true });
    }
    return Response.json({ error: "不支持的操作" }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const url = new URL(request.url);
    if (url.searchParams.get("completed") === "1") {
      const completed = await getDb()
        .prepare("SELECT id FROM reference_remix_tasks WHERE status IN ('video_ready', 'scheduled')")
        .all<{ id: string }>();
      let deleted = 0;
      for (const row of completed.results) {
        const assets = await getDb()
          .prepare("SELECT object_key FROM reference_remix_assets WHERE task_id = ?")
          .bind(row.id)
          .all<{ object_key: string }>();
        const bucket = runtimeEnv().MEDIA;
        if (bucket) {
          await Promise.all(assets.results.map((item) => bucket.delete(item.object_key)));
        }
        await getDb().batch([
          getDb().prepare("DELETE FROM reference_remix_assets WHERE task_id = ?").bind(row.id),
          getDb().prepare("DELETE FROM reference_remix_tasks WHERE id = ?").bind(row.id),
        ]);
        deleted += 1;
      }
      return Response.json({ ok: true, deleted });
    }
    const body = (await request.json()) as { id?: string };
    if (!body.id) return Response.json({ error: "缺少复刻任务 ID" }, { status: 400 });
    const assets = await getDb()
      .prepare("SELECT object_key FROM reference_remix_assets WHERE task_id = ?")
      .bind(body.id)
      .all<{ object_key: string }>();
    const bucket = runtimeEnv().MEDIA;
    if (bucket) await Promise.all(assets.results.map((item) => bucket.delete(item.object_key)));
    await getDb().batch([
      getDb().prepare("DELETE FROM reference_remix_assets WHERE task_id = ?").bind(body.id),
      getDb().prepare("DELETE FROM reference_remix_tasks WHERE id = ?").bind(body.id),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
