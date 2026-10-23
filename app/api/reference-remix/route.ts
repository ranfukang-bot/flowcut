import { REMIX_GEM } from '../../../lib/remix-gem';
import { remixAction } from '../../../lib/remix-tasks';
import { planRemixSegments, FOLLOW_REFERENCE_LANGUAGE } from '../../../lib/remix-segments';
import { SPOKEN_LANGUAGE_OPTIONS } from '../../../lib/spoken-language';
import { taskDetail } from '../../../lib/task-list';
import { saveLibraryProduct } from "../../../lib/product-library";
import { getProviderConfig } from "../../../lib/provider-config";
import {
  normalizeReferenceRemixRegion,
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
    const db=getDb();
    const rows=await db.prepare("SELECT id FROM tasks WHERE task_role='remix' ORDER BY created_at DESC LIMIT 200").all<{id:string}>();
    return Response.json({gem:REMIX_GEM,groups:await Promise.all(rows.results.map(r=>taskDetail(db,r.id)))});
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
        { error: "爆款复刻需要 Gemini 网页版，请先在接口设置中切换到网页工作台" },
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

    const plan=planRemixSegments(form.get('videoSeconds'));
    const language=String(form.get('spokenLanguage') || 'auto');
    if(language!==FOLLOW_REFERENCE_LANGUAGE && language!=='auto' && !SPOKEN_LANGUAGE_OPTIONS.includes(language)) throw new Error('口播语言无效');
    const region = normalizeReferenceRemixRegion(form.get("region"));
    const productName = String(form.get("productName") || "").trim();
    const externalId = String(form.get("externalId") || "").trim();
    const geminiAccountId = String(form.get("geminiAccountId") || "").trim();
    const tiktokAccountName = await requireTikTokAccount(form.get("tiktokAccountName"));
    const archiveAccount = await getDb().prepare("SELECT archive_directory FROM tiktok_accounts WHERE lower(name) = lower(?)").bind(tiktokAccountName).first<{ archive_directory: string }>();
    const autoQueue = String(form.get("autoQueue") || "true") !== "false";
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

      const saved=await saveLibraryProduct(db,bucket,{externalId,name:productName,files:images,country:region});
      productId=saved.id;
      await db.prepare(`INSERT INTO tasks
        (id,product_id,gem_id,title,status,progress,duration,region,shooting_style,task_role,batch_round,batch_size,
         gemini_account_id,tiktok_account_name,archive_directory,auto_queue,provider,gem_content_snapshot,
         product_external_id_snapshot,image_keys_snapshot,remix_video_key,remix_video_name,remix_video_type,remix_video_size,
         remix_video_seconds,remix_plan_json,remix_spoken_language,remix_product_name,created_at,updated_at)
        VALUES (?,?,?,?,'remix_queued',5,?,?,'','remix',1,?,?,?,?,?,'gemini-web',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(taskId,productId,REMIX_GEM.id,`${productName || '图片识别商品'} · 爆款复刻`,plan.seconds || 0,region,plan.segments.length,
          geminiAccountId || null,tiktokAccountName,archiveAccount?.archive_directory || '',autoQueue?1:0,REMIX_GEM.content,
          externalId,JSON.stringify(saved.imageKeys),videoKey,video.name,video.type,video.size,
          plan.seconds,JSON.stringify(plan.segments),language,productName,now,now).run();
    } catch (error) {
      await Promise.all(uploadedKeys.map((key) => bucket.delete(key)));
      // A saved library product may be reused by other tasks; a remix failure
      // must not remove that product or its independent library images.
      throw error;
    }
    return Response.json({ id: taskId, status: "remix_queued" }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureWorkspace();
    const body=await request.json() as {region?:string};
    const region=normalizeReferenceRemixRegion(body.region);
    await getDb().prepare(`INSERT INTO reference_remix_settings(id,duration,region,updated_at) VALUES('default',15,?,?)
      ON CONFLICT(id) DO UPDATE SET region=excluded.region,updated_at=excluded.updated_at`).bind(region,new Date().toISOString()).run();
    return Response.json({ok:true,region});
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const body=await request.json() as {id:string;action?:string;clipId?:string;index?:number;note?:string};
    if(!body.id) return Response.json({error:'缺少复刻任务 ID'},{status:400});
    return remixAction(getDb(),body);
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
