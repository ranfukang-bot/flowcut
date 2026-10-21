"use client";

import { DragEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { useImageProductId } from './use-image-product-id';
import { api, desktopBridge } from './studio-client';
import type { Product } from './studio-types';
import { formatTime, PageIntro, ModalHead, EmptyState } from './studio-ui';

export function PickImportPanel({ onImported }: { onImported: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="pick-import-panel">
    <div><b>从 FastMoss 送入商品</b><p>商品 ID、名称和参考图一起导入。扫码添加橱窗后，在创作中心选择商品即可继续。</p></div>
    <div className="row-actions">
      <button className="secondary" onClick={async () => {
        try { const desktop = desktopBridge(); if (!desktop?.publisherOpenExtension) throw new Error("请在 FlowCut 桌面应用中使用"); await desktop.publisherOpenExtension(); setMessage("已打开插件目录。在浏览器扩展管理中选择“加载已解压的扩展”，加载这个文件夹；以后直接在选品插件点击“发送所选商品”。"); }
        catch (error) { setMessage(error instanceof Error ? error.message : "打开失败"); }
      }}>打开选品插件目录</button>
      <label className="secondary import-file-button">{busy ? "正在导入…" : "导入选品 JSON"}<input type="file" accept=".json,application/json" disabled={busy} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        setBusy(true);
        try { const desktop = desktopBridge(); if (!desktop?.publisherImport) throw new Error("请在 FlowCut 桌面应用中使用"); const parsed = JSON.parse(await file.text()); const result = await desktop.publisherImport(Array.isArray(parsed) ? parsed : parsed.rows); const missing = result.results.filter(r => r.warning).length; setMessage(`已处理 ${result.total} 件商品，新增 ${result.added} 件。${missing ? `${missing} 件商品需点击“编辑”补充图片。` : ""}`); await onImported(); }
        catch (error) { setMessage(error instanceof Error ? error.message : "导入失败"); }
        finally { setBusy(false); }
      }} /></label>
    </div>
    {message && <p className="integration-message" role="status">{message}</p>}
  </section>;
}

export function ProductsPage({
  products,
  onImported,
  onAdd,
  onEdit,
  onCreate,
  onDelete,
}: {
  products: Product[];
  onImported: () => Promise<void>;
  onAdd: () => void;
  onEdit: (product: Product) => void;
  onCreate: (product: Product) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const dayOf = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "日期未知" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const days = [...new Set(products.map(p => dayOf(p.created_at)))].sort().reverse();
  const groups = new Map<string, Product[]>();
  for (const product of [...products].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const day = dayOf(product.created_at);
    if (selectedDay && day !== selectedDay) continue;
    if (query && !`${product.name} ${product.external_id}`.toLowerCase().includes(query.toLowerCase())) continue;
    groups.set(day, [...(groups.get(day) || []), product]);
  }
  return (
    <div className="page-body">
      <PageIntro title="商品素材库" text="保存商品图、商品 ID 与真实卖点，Gemini 会把它们作为每次创作的事实来源。" action="添加商品" onAction={onAdd} />
      <PickImportPanel onImported={onImported} />
      <div className="product-library-toolbar">
        <input aria-label="搜索商品库" placeholder="搜索商品名称或商品 ID" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="添加日期" value={selectedDay} onChange={event => setSelectedDay(event.target.value)}><option value="">全部添加日期</option>{days.map(day => <option key={day} value={day}>{day}</option>)}</select>
        <span>共 {products.length} 件商品 · 相同商品 ID 自动复用，不按日期删除</span>
      </div>
      {products.length ? (
        <div className="product-date-groups">
          {!groups.size && <p>没有匹配的商品</p>}
          {[...groups].map(([day, items]) => <section className="product-date-group" key={day}>
          <h3>{day}<small>{items.length} 件商品</small></h3>
          <div className="product-grid">
          {items.map((product) => (
            <article className="product-card" key={product.id}>
              <div className="product-image">
                {product.images?.length || product.image_key ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media?key=${encodeURIComponent(
                      product.images?.[0]?.object_key || product.image_key || ""
                    )}`}
                    alt={product.name || "商品参考图"}
                  />
                ) : <span>NO IMAGE</span>}
                {product.images?.length > 1 && (
                  <b className="image-count">＋{product.images.length - 1}</b>
                )}
              </div>
              <div className="product-info">
                <small>
                  商品 ID：{product.external_id?.trim() || "未填写"}
                </small>
                <time className="product-added-at">添加于 {formatTime(product.created_at)}</time>
                <h3>{product.name?.trim() || "未命名商品"}</h3>
                <p>
                  {product.features?.trim() ||
                    "未填写卖点；生成时将由 Gemini 结合全部图片识别。"}
                </p>
                <div className="product-card-foot">
                  <span>{product.images?.length || 0} 张商品图</span>
                  <div className="product-card-actions">
                    <button className="product-create" onClick={() => onCreate(product)}>去制作</button>
                    <button onClick={() => onEdit(product)}>编辑</button>
                    <button
                      className="danger-text"
                      onClick={() => onDelete(product.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
          </div></section>)}
        </div>
      ) : <EmptyState icon="▣" title="商品库还是空的" text="上传第一张产品图，之后就可以选择 Gem 自动创作。" action="添加商品" onAction={onAdd} />}
    </div>
  );
}

export function ProductModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [externalId, setExternalId] = useImageProductId(files);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files]
  );

  useEffect(
    () => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [previews]
  );

  function addFiles(incoming: File[]) {
    setError("");
    const images = incoming.filter((file) => file.type.startsWith("image/"));
    if (images.length !== incoming.length) {
      setError("已忽略非图片文件");
    }
    const oversized = images.find((file) => file.size > 12 * 1024 * 1024);
    if (oversized) {
      setError(`${oversized.name} 超过 12MB`);
      return;
    }
    setFiles((current) => {
      const next = [...current];
      for (const file of images) {
        const duplicate = next.some(
          (item) => item.name === file.name && item.size === file.size
        );
        if (!duplicate && next.length < 12) next.push(file);
      }
      if (next.reduce((total, file) => total + file.size, 0) > 48 * 1024 * 1024) {
        setError("单个商品的图片总大小不能超过 48MB");
        return current;
      }
      if (current.length + images.length > 12) {
        setError("每个商品最多保留 12 张参考图");
      }
      return next;
    });
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length) {
      setError("请至少上传一张商品参考图");
      return;
    }
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    form.delete("images");
    files.forEach((file) => form.append("images", file, file.name));
    try {
      await api("/api/products", { method: "POST", body: form });
      onSaved();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "图片上传失败，请重试"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !busy && onClose()
      }
    >
      <form className="modal product-modal" onSubmit={submit}>
        <ModalHead
          title="添加商品"
          text="可拖拽或批量选择多张参考图；第一张会作为商品封面。"
          onClose={onClose}
        />
        <div className="form-body two-col product-form-grid">
          <div className="multi-upload-column">
            <label
              className={`upload-box multi-upload ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                name="images"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) =>
                  addFiles(Array.from(event.currentTarget.files || []))
                }
              />
              <span>＋</span>
              <b>拖拽商品图到这里</b>
              <small>或点击批量选择，最多 12 张，每张不超过 12MB</small>
            </label>
            {previews.length > 0 && (
              <div className="upload-previews">
                {previews.map((preview, index) => (
                  <div className="upload-preview" key={`${preview.file.name}-${index}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={preview.url} alt={preview.file.name} />
                    {index === 0 && <em>封面</em>}
                    <button
                      type="button"
                      aria-label={`移除 ${preview.file.name}`}
                      onClick={() =>
                        setFiles((current) =>
                          current.filter((_, fileIndex) => fileIndex !== index)
                        )
                      }
                    >
                      ×
                    </button>
                    <span>{preview.file.name}</span>
                  </div>
                ))}
                {previews.length < 12 && (
                  <label className="upload-more">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) =>
                        addFiles(Array.from(event.currentTarget.files || []))
                      }
                    />
                    ＋
                  </label>
                )}
              </div>
            )}
            {error && <div className="form-error">{error}</div>}
          </div>
          <div className="form-stack">
            <label>
              商品名称（选填）
              <input
                name="name"
                placeholder="留空则由 Gemini 根据商品图识别"
              />
            </label>
            <label>
              商品 ID
              <input
                name="externalId"
                value={externalId}
                onChange={(event) => setExternalId(event.target.value)}
                placeholder="自动识别首张图片文件名中的 ID，可修改"
              />
            </label>
            <label>
              核心功能与卖点
              <textarea
                name="features"
                rows={6}
                placeholder="只填写真实、可验证的功能。每行一个卖点，Gemini 会结合全部参考图进行判断。"
              />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <span>{files.length ? `已选择 ${files.length} 张参考图` : "尚未选择图片"}</span>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? `正在上传 ${files.length} 张图片…` : "保存商品"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ProductEditModal({
  product,
  onClose,
  onSaved,
}: {
  product: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/products", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: product.id,
          name: String(form.get("name") || ""),
          externalId: String(form.get("externalId") || ""),
          features: String(form.get("features") || ""),
        }),
      });
      const images = form.getAll("images").filter((file) => file instanceof File && file.size > 0);
      if (images.length) {
        const attachments = new FormData(); attachments.set("id", product.id);
        images.forEach((file) => attachments.append("images", file));
        await api("/api/products", { method: "PATCH", body: attachments });
      }
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "商品资料保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !busy && onClose()
      }
    >
      <form className="modal small-modal" onSubmit={submit}>
        <ModalHead
          title="编辑商品资料"
          text={`${product.images?.length || 0} 张商品图已保留；商品名称可以留空。`}
          onClose={onClose}
        />
        <div className="form-body form-stack">
          <label>
            商品名称（选填）
            <input
              name="name"
              defaultValue={product.name || ""}
              placeholder="留空则显示为“未命名商品”"
            />
          </label>
          <label>
            商品 ID（选填）
            <input
              name="externalId"
              defaultValue={product.external_id || ""}
              placeholder="TikTok Shop Product ID"
            />
          </label>
          <label>
            核心功能与卖点（选填）
            <textarea
              name="features"
              rows={6}
              defaultValue={product.features || ""}
              placeholder="可留空，让 Gemini 结合商品图识别"
            />
          </label>
          <label>补充商品图<input name="images" type="file" accept="image/jpeg,image/png,image/webp" multiple /><small>现有图片会保留，每个商品最多 12 张。</small></label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <span>不会修改或删除现有商品图片</span>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}
