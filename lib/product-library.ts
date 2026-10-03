type ProductInput = { externalId: string; name: string; features?: string; country?: string; files: File[] };

// A conditional INSERT is serialized by SQLite/D1, including requests from
// different workers. Blank IDs deliberately remain independent products.
export async function saveLibraryProduct(db: D1Database, bucket: R2Bucket | undefined, input: ProductInput) {
  const externalId = input.externalId.trim();
  const candidate = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO products (id,external_id,name,country,language,features,created_at)
    SELECT ?,?,?,?,'',?,? WHERE ?='' OR NOT EXISTS (SELECT 1 FROM products WHERE trim(external_id)=?)`)
    .bind(candidate,externalId,input.name.trim(),input.country || '',input.features || '',now,externalId,externalId).run();
  const product = externalId
    ? await db.prepare('SELECT id FROM products WHERE trim(external_id)=? ORDER BY created_at DESC,id LIMIT 1').bind(externalId).first<{id:string}>()
    : {id:candidate};
  if (!product) throw Error('商品保存失败，请重试');
  const id = product.id, created = id === candidate;
  const uploaded: Array<{id:string;key:string;file:File}> = [];
  let committed = false;
  try {
    for (const file of input.files) {
      if (!bucket) throw Error('素材存储尚未连接');
      const imageId = crypto.randomUUID(), key = `products/${id}/${imageId}`;
      await bucket.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:file.type}});
      uploaded.push({id:imageId,key,file});
    }
    const statements = [];
    if (uploaded.length) {
      // Freeze legacy tasks before replacing the library selection. Already
      // snapshotted tasks and their original media objects remain untouched.
      statements.push(db.prepare(`UPDATE tasks SET image_keys_snapshot=(SELECT json_group_array(object_key) FROM
        (SELECT object_key FROM product_images WHERE product_id=? ORDER BY sort_order))
        WHERE product_id=? AND image_keys_snapshot IS NULL`).bind(id,id));
      statements.push(db.prepare('DELETE FROM product_images WHERE product_id=?').bind(id));
      uploaded.forEach((item,index)=>statements.push(db.prepare(`INSERT INTO product_images
        (id,product_id,object_key,file_name,content_type,sort_order,created_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(item.id,id,item.key,item.file.name,item.file.type,index,now)));
      statements.push(db.prepare('UPDATE products SET image_key=?,image_name=? WHERE id=?').bind(uploaded[0].key,uploaded[0].file.name,id));
    }
    statements.push(db.prepare(`UPDATE products SET name=CASE WHEN ?='' THEN name ELSE ? END,
      features=CASE WHEN ?='' THEN features ELSE ? END WHERE id=?`)
      .bind(input.name.trim(),input.name.trim(),input.features?.trim() || '',input.features?.trim() || '',id));
    await db.batch(statements);
    committed = true;
    const imageKeys = uploaded.length ? uploaded.map(item=>item.key)
      : (await db.prepare('SELECT object_key FROM product_images WHERE product_id=? ORDER BY sort_order').bind(id).all<{object_key:string}>()).results.map(item=>item.object_key);
    return {id,reused:!created,imageKeys};
  } catch (error) {
    if (committed) throw error;
    await Promise.all(uploaded.map(item=>bucket?.delete(item.key).catch(()=>{})));
    // A concurrent request may already be filling the same nonblank ID.
    // Keep its identity on upload failure so retries reuse it safely.
    if (created && !externalId) await db.prepare(`DELETE FROM products WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM product_images WHERE product_id=?)
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE product_id=?)
      AND NOT EXISTS (SELECT 1 FROM reference_remix_tasks WHERE product_id=?)`).bind(id,id,id,id).run();
    throw error;
  }
}
