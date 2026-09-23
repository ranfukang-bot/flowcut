import { ensureWorkspace, getDb, jsonError, runtimeEnv } from "../../../lib/storage";

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const form = await request.formData();
    const name = String(form.get("name") || "").trim();
    const files = form
      .getAll("images")
      .filter((item): item is File => item instanceof File && item.size > 0);
    const id = crypto.randomUUID();
    if (files.length > 12) {
      return Response.json({ error: "每个商品最多上传 12 张图片" }, { status: 400 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > 48 * 1024 * 1024) {
      return Response.json({ error: "单个商品的图片总大小不能超过 48MB" }, { status: 400 });
    }
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        return Response.json({ error: "请上传图片文件" }, { status: 400 });
      }
      if (file.size > 12 * 1024 * 1024) {
        return Response.json({ error: "单张图片不能超过 12MB" }, { status: 400 });
      }
      const bucket = runtimeEnv().MEDIA;
      if (!bucket) throw new Error("素材存储尚未连接");
    }
    const bucket = runtimeEnv().MEDIA;
    if (files.length && !bucket) throw new Error("素材存储尚未连接");

    const uploaded: Array<{
      id: string;
      key: string;
      name: string;
      type: string;
      order: number;
    }> = [];
    try {
      for (const [index, file] of files.entries()) {
        const imageId = crypto.randomUUID();
        const safeName = file.name.replace(/[^\w.\-]+/g, "-");
        const key = `products/${id}/${String(index + 1).padStart(2, "0")}-${imageId}-${safeName}`;
        await bucket!.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type },
        });
        uploaded.push({
          id: imageId,
          key,
          name: file.name,
          type: file.type,
          order: index,
        });
      }
    } catch (error) {
      await Promise.all(uploaded.map((item) => bucket!.delete(item.key)));
      throw error;
    }

    await getDb()
      .prepare(
        `INSERT INTO products
         (id, external_id, name, country, language, features, image_key, image_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        String(form.get("externalId") || ""),
        name,
        String(form.get("country") || ""),
        "",
        String(form.get("features") || ""),
        uploaded[0]?.key || null,
        uploaded[0]?.name || null,
        new Date().toISOString()
      )
      .run();
    if (uploaded.length) {
      const now = new Date().toISOString();
      await getDb().batch(
        uploaded.map((item) =>
          getDb()
            .prepare(
              `INSERT INTO product_images
               (id, product_id, object_key, file_name, content_type, sort_order, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(item.id, id, item.key, item.name, item.type, item.order, now)
        )
      );
    }
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as {
      id?: string;
      name?: string;
      externalId?: string;
      features?: string;
    };
    if (!body.id) {
      return Response.json({ error: "缺少商品 ID" }, { status: 400 });
    }
    const existing = await getDb()
      .prepare("SELECT id FROM products WHERE id = ?")
      .bind(body.id)
      .first<{ id: string }>();
    if (!existing) {
      return Response.json({ error: "商品不存在或已被删除" }, { status: 404 });
    }
    await getDb()
      .prepare(
        `UPDATE products
         SET name = ?, external_id = ?, features = ?
         WHERE id = ?`
      )
      .bind(
        String(body.name || "").trim(),
        String(body.externalId || "").trim(),
        String(body.features || "").trim(),
        body.id
      )
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  const uploaded: Array<{ id: string; key: string; file: File }> = [];
  const bucket = runtimeEnv().MEDIA;
  try {
    await ensureWorkspace();
    const form = await request.formData();
    const id = String(form.get("id") || "");
    const existing = await getDb().prepare("SELECT id FROM products WHERE id = ?").bind(id).first();
    if (!existing) throw new Error("商品不存在");
    if (!bucket) throw new Error("素材存储尚未连接");
    const count = await getDb().prepare("SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?").bind(id).first<{ n: number }>();
    const files = form.getAll("images").filter((item): item is File => item instanceof File && item.size > 0);
    if (!files.length || files.length + Number(count?.n || 0) > 12) throw new Error("每个商品最多保存 12 张图片");
    if (files.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 12 * 1024 * 1024) || files.reduce((n, file) => n + file.size, 0) > 48 * 1024 * 1024) throw new Error("请使用 JPG、PNG 或 WebP，单张最多 12MB，合计最多 48MB");
    for (const file of files) {
      const imageId = crypto.randomUUID(), key = `products/${id}/${imageId}`;
      await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
      uploaded.push({ id: imageId, key, file });
    }
    await getDb().batch([
      ...uploaded.map((item, index) => getDb().prepare("INSERT INTO product_images (id, product_id, object_key, file_name, content_type, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(item.id, id, item.key, item.file.name, item.file.type, Number(count?.n || 0) + index, new Date().toISOString())),
      getDb().prepare("UPDATE products SET image_key = COALESCE(image_key, ?), image_name = COALESCE(image_name, ?) WHERE id = ?").bind(uploaded[0].key, uploaded[0].file.name, id),
    ]);
    return Response.json({ ok: true, added: uploaded.length });
  } catch (error) {
    await Promise.all(uploaded.map(item => bucket?.delete(item.key).catch(() => {})));
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const { id } = (await request.json()) as { id?: string };
    if (!id) return Response.json({ error: "缺少产品 ID" }, { status: 400 });
    const images = await getDb()
      .prepare("SELECT object_key FROM product_images WHERE product_id = ?")
      .bind(id)
      .all<{ object_key: string }>();
    if (runtimeEnv().MEDIA) {
      await Promise.all(
        images.results.map((image: { object_key: string }) =>
          runtimeEnv().MEDIA!.delete(image.object_key)
        )
      );
    }
    await getDb().batch([
      getDb().prepare("DELETE FROM product_images WHERE product_id = ?").bind(id),
      getDb().prepare("DELETE FROM products WHERE id = ?").bind(id),
      getDb().prepare("DELETE FROM tasks WHERE product_id = ?").bind(id),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
