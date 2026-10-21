"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { SHOOTING_STYLES, TASK_DURATIONS, TASK_REGIONS } from '../lib/task-config';
import { useImageProductId } from './use-image-product-id';
import { buildGemRequest } from '../lib/gem-request';
import { SpokenLanguageSelect } from './spoken-language-select';
import { VariantConfigBlock, type VariantConfig } from './variant-config';
import type { Product, Task, Workspace, Page, SeedanceRuntime } from './studio-types';
import { formatTime, EmptyState } from './studio-ui';
import { taskStatusClass, taskStatusLabel } from './task-status';
import { APPROVED_REVIEW_STATUSES, VIDEO_DONE_STATUSES, VIDEO_FAILED_STATUSES } from '../lib/task-statuses';

export function ProductImagePicker({products, selectedId, onChoose, onClose}: {
  products: Product[]; selectedId: string; onChoose: (id:string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const matches = products.filter(product => !query.trim() ||
    `${product.name || ""} ${product.external_id || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <dialog ref={dialog} className="product-image-dialog" aria-labelledby="product-image-picker-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="product-image-dialog-head">
      <div><h2 id="product-image-picker-title">看图选择商品</h2><p>点击图片即可使用。当前商品会保持选中，直到你主动更换。</p></div>
      <button type="button" className="secondary" onClick={onClose}>取消</button>
    </div>
    <div className="product-image-search"><input autoFocus aria-label="搜索待选商品" placeholder="直接看图选择，也可搜索名称或商品 ID" value={query} onChange={event => setQuery(event.target.value)} /><span>{matches.length} 件商品</span></div>
    <div className="product-image-grid">
      {matches.map(product => <button type="button" className={`product-image-option ${product.id === selectedId ? "selected" : ""}`}
        key={product.id} data-product-id={product.id} aria-pressed={product.id === selectedId} onClick={() => onChoose(product.id)}>
        <span className="product-image-cover">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {product.images[0] ? <img loading="lazy" src={`/api/media?key=${encodeURIComponent(product.images[0].object_key)}`} alt={product.name?.trim() || "商品图片"} /> : <span>暂无图片</span>}
          <em>{product.images.length} 张图</em>{product.id === selectedId && <strong>✓ 当前商品</strong>}
        </span>
        <b>{product.name?.trim() || "未命名商品"}</b><small>ID：{product.external_id || "未填写"}</small>
      </button>)}
      {!matches.length && <p className="product-picker-empty">{products.length ? "没有匹配的商品，换个关键词试试。" : "商品库暂无商品，请先上传商品图片。"}</p>}
    </div>
  </dialog>;
}

export function Dashboard({
  data,
  selectedProduct,
  productMode,
  onProductMode: setProductMode,
  selectedGem,
  selectedTikTokAccount,
  selectedDuration,
  selectedRegion,
  selectedShootingStyle,
  gemRequestTemplate,
  spokenLanguage,
  onSpokenLanguage,
  onGemRequestTemplate,
  variantConfig,
  onVariantConfig,
  autoQueue,
  busy,
  onProduct,
  onGem,
  onTikTokAccount,
  onDuration,
  onRegion,
  onShootingStyle,
  onAddTikTokAccount,
  onManageTikTokAccounts,
  onChooseArchiveDirectory,
  onAutoQueue,
  onRun,
  onAddProduct,
  onAddGem,
  onPreview,
  onNavigate,
  seedanceRuntime,
}: {
  data: Workspace;
  selectedProduct: string;
  productMode: "new" | "library";
  onProductMode: (mode: "new" | "library") => void;
  selectedGem: string;
  selectedTikTokAccount: string;
  selectedDuration: number;
  selectedRegion: string;
  selectedShootingStyle: string;
  gemRequestTemplate: string;
  spokenLanguage: string;
  onSpokenLanguage: (value:string)=>void;
  onGemRequestTemplate: (value: string) => void;
  variantConfig: VariantConfig;
  onVariantConfig: (value: VariantConfig) => void;
  autoQueue: boolean;
  busy: boolean;
  onProduct: (value: string) => void;
  onGem: (value: string) => void;
  onTikTokAccount: (value: string) => void;
  onDuration: (value: number) => void;
  onRegion: (value: string) => void;
  onShootingStyle: (value: string) => void;
  onAddTikTokAccount: () => void;
  onManageTikTokAccounts: () => void;
  onChooseArchiveDirectory: () => void;
  onAutoQueue: (value: boolean) => void;
  onRun: (input: {
    mode: "new" | "library";
    files: File[];
    productName: string;
    externalId: string;
  }) => Promise<boolean>;
  onAddProduct: () => void;
  onAddGem: () => void;
  onPreview: (task: Task) => void;
  onNavigate: (page: Page) => void;
  seedanceRuntime: SeedanceRuntime;
}) {
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const chosenProduct = data.products.find(product => product.id === selectedProduct);
  const [quickFiles, setQuickFiles] = useState<File[]>([]);
  const [quickDragging, setQuickDragging] = useState(false);
  const [quickError, setQuickError] = useState("");
  const [quickProductName, setQuickProductName] = useState("");
  const [quickExternalId, setQuickExternalId] = useImageProductId(quickFiles);
  const quickPreviews = useMemo(
    () => quickFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [quickFiles]
  );
  const archiveProductId =
    productMode === "new"
      ? quickExternalId.trim()
      : data.products
          .find((product) => product.id === selectedProduct)
          ?.external_id?.trim() || "";

  useEffect(
    () => () => quickPreviews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [quickPreviews]
  );

  function receiveQuickFiles(incoming: File[]) {
    setQuickError("");
    const images = incoming.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      setQuickError("请选择商品图片");
      return;
    }
    const oversized = images.find((file) => file.size > 12 * 1024 * 1024);
    if (oversized) {
      setQuickError(`${oversized.name} 超过 12MB`);
      return;
    }
    setQuickFiles((current) => {
      const next = [...current];
      for (const file of images) {
        const duplicate = next.some(
          (item) =>
            item.name === file.name &&
            item.size === file.size &&
            item.lastModified === file.lastModified
        );
        if (!duplicate) next.push(file);
      }
      if (next.length > 12) {
        setQuickError("一个商品最多上传 12 张参考图");
        return current;
      }
      if (next.reduce((total, file) => total + file.size, 0) > 48 * 1024 * 1024) {
        setQuickError("图片总大小不能超过 48MB");
        return current;
      }
      return next;
    });
  }

  return (
    <div className="page-body">
      {productPickerOpen && <ProductImagePicker products={data.products} selectedId={selectedProduct}
        onChoose={id => { onProduct(id); setProductMode("library"); setProductPickerOpen(false); }}
        onClose={() => setProductPickerOpen(false)} />}
      <section className="hero-grid">
        <div className="composer">
          <div className="composer-head">
            <div>
              <span className="step-kicker">QUICK CREATE</span>
              <h2>把商品图拖进来，直接生成成交视频</h2>
              <p>图片可分多次拖入；点击开始后一次性上传、识别并进入 Gemini → Seedance 流程。</p>
            </div>
            <span className="spark">✦</span>
          </div>
          <div className="quick-product-block">
            <div className="quick-step-title">
              <span><b>01</b> 选择商品来源</span>
              <div>
                <small>上传新商品与选择商品库二选一</small>
                {productMode === "new" && quickFiles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuickFiles([]);
                      setQuickError("");
                    }}
                  >
                    清空图片
                  </button>
                )}
              </div>
            </div>
            <div className="product-source-switch" role="radiogroup" aria-label="商品来源">
              <button
                type="button"
                className={productMode === "new" ? "active" : ""}
                role="radio"
                aria-checked={productMode === "new"}
                disabled={busy}
                onClick={() => setProductMode("new")}
              >
                <b>上传新商品</b>
                <small>图片会自动保存到商品库</small>
              </button>
              <button
                type="button"
                className={productMode === "library" ? "active" : ""}
                role="radio"
                aria-checked={productMode === "library"}
                onClick={() => {
                  setProductMode("library");
                  setProductPickerOpen(true);
                  setQuickError("");
                }}
                disabled={busy || !data.products.length}
              >
                <b>选择已有商品</b>
                <small>{data.products.length ? `商品库共 ${data.products.length} 个` : "商品库暂无商品"}</small>
              </button>
            </div>
            {productMode === "new" ? (
              <div className="quick-product-grid">
                <label
                  className={`quick-upload-zone ${quickDragging ? "dragging" : ""} ${quickFiles.length ? "has-files" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setQuickDragging(true);
                  }}
                  onDragLeave={() => setQuickDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setQuickDragging(false);
                    receiveQuickFiles(Array.from(event.dataTransfer.files));
                  }}
                >
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={busy}
                    onChange={(event) => {
                      receiveQuickFiles(Array.from(event.currentTarget.files || []));
                      event.currentTarget.value = "";
                    }}
                  />
                  {quickPreviews.length ? (
                    <div className="quick-preview-strip">
                      {quickPreviews.slice(0, 5).map((preview, index) => (
                        <span key={`${preview.file.name}-${index}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={preview.url} alt="" />
                          <button
                            type="button"
                            aria-label={`移除 ${preview.file.name}`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setQuickFiles((current) =>
                                current.filter((_, fileIndex) => fileIndex !== index)
                              );
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {quickPreviews.length > 5 && <em>+{quickPreviews.length - 5}</em>}
                    </div>
                  ) : (
                    <span className="quick-upload-icon">＋</span>
                  )}
                  <div>
                    <b>
                      {busy && quickFiles.length
                        ? `正在上传 ${quickFiles.length} 张并创建任务…`
                        : quickFiles.length
                          ? `已暂存 ${quickFiles.length} 张，可继续拖入追加`
                          : "拖拽商品图到这里，或点击批量选择"}
                    </b>
                    <small>
                      {quickFiles.length
                        ? "开始后保存到商品库；相同商品 ID 自动复用"
                        : "JPG / PNG / WebP · 最多 12 张 · 单张不超过 12MB"}
                    </small>
                  </div>
                </label>
                <div className="quick-product-options">
                  <label>
                    <span>商品名称 <small>选填</small></span>
                    <input
                      value={quickProductName}
                      onChange={(event) => setQuickProductName(event.target.value)}
                      placeholder="可留空，由 Gemini 根据图片识别"
                      disabled={busy}
                    />
                  </label>
                  <label>
                    <span>TikTok 商品 ID <small>选填</small></span>
                    <input
                      value={quickExternalId}
                      onChange={(event) => setQuickExternalId(event.target.value)}
                      placeholder="自动识别首张图片文件名中的 ID，可修改"
                      title="仅识别第一张图片；后续追加不会覆盖。清空图片后可识别下一组。"
                      disabled={busy}
                    />
                  </label>
                  <div className="source-explainer">
                    <b>新商品会自动入库</b>
                    <span>Gemini 会根据全部参考图识别品类、外观与可验证卖点。</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="library-product-picker" data-product-id={chosenProduct?.id || ""}>
                <div className="chosen-product-heading">
                  <div><b>{chosenProduct ? "当前制作商品" : "还未选择商品"}</b><small>选定后持续使用，换模板、换账号或创建任务都不会清空。</small></div>
                  <button type="button" className="choose-product-button" disabled={busy} onClick={() => setProductPickerOpen(true)}>{chosenProduct ? "看图更换商品" : "看图选择商品"}</button>
                </div>
                {chosenProduct && <>
                  <div className="quick-preview-strip" aria-label="已带入的商品图片">
                    {chosenProduct.images.map((image,index) => <span key={image.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/media?key=${encodeURIComponent(image.object_key)}`} alt={`商品参考图 ${index + 1}`} />
                    </span>)}
                  </div>
                  <b>{chosenProduct.name?.trim() || "未命名商品"}</b>
                  <small className="chosen-product-detail">商品 ID：{chosenProduct.external_id || "未填写"} · {chosenProduct.images.length} 张商品图</small>
                </>}
              </div>
            )}
            {quickError && <div className="quick-upload-error">{quickError}</div>}
          </div>
          <div className="creative-config-block">
            <div className="quick-step-title">
              <span><b>02</b> 设置本次视频</span>
              <small>参数只属于当前任务，不会修改 Gem</small>
            </div>
            <div className="creative-settings-grid">
              <label>
                <span>视频秒数</span>
                <select
                  value={selectedDuration}
                  onChange={(event) => onDuration(Number(event.target.value))}
                >
                  {TASK_DURATIONS.map((duration) => (
                    <option key={duration} value={duration}>
                      {duration === 30 ? "双段 30 秒（15秒＋15秒，自动拼接）" : `${duration} 秒${duration === 15 ? "（常用）" : ""}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>投放地区</span>
                <select
                  value={selectedRegion}
                  onChange={(event) => onRegion(event.target.value)}
                >
                  {TASK_REGIONS.map((region) => (
                    <option key={region} value={region}>{region}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>拍摄风格</span>
                <select
                  value={selectedShootingStyle}
                  onChange={(event) => onShootingStyle(event.target.value)}
                >
                  {SHOOTING_STYLES.map((style) => (
                    <option key={style} value={style}>{style}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="task-config-grid">
            <label>
              <span><b>03</b> 选择 Gem</span>
              <select value={selectedGem} onChange={(event) => onGem(event.target.value)}>
                {!data.gems.length && <option value="">请先创建 Gem</option>}
                {data.gems.map((gem) => (
                  <option key={gem.id} value={gem.id}>{gem.name}</option>
                ))}
              </select>
            </label>
            {data.integrations.geminiMode === "web" && (
                <label>
                  <span><b>04</b> Gemini 账号</span>
                  <input value="自动分配空闲账号" readOnly aria-label="Gemini 账号分配" />
                </label>
            )}
            <label>
              <span>
                <b>{data.integrations.geminiMode === "web" ? "05" : "04"}</b>{" "}
                归档账号 / 保存文件夹
              </span>
              <div className="tk-account-picker">
                <select
                  aria-label="TK 归档账号"
                  value={selectedTikTokAccount}
                  onChange={(event) => onTikTokAccount(event.target.value)}
                >
                  <option value="">
                    {data.tiktokAccounts.length
                      ? "请选择 TK 账号"
                      : "请先添加 TK 账号"}
                  </option>
                  {data.tiktokAccounts.map((account) => (
                    <option key={account.id} value={account.name}>
                      {account.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary"
                  onClick={onAddTikTokAccount}
                >
                  ＋ 添加
                </button>
                <button type="button" className="secondary" onClick={onManageTikTokAccounts}>管理</button>
              </div>
              <button type="button" className="secondary archive-folder-button" onClick={onChooseArchiveDirectory}>选择 / 更改保存文件夹</button>
              <small className="download-destination">
                成片自动保存到：{data.tiktokAccounts.find(account => account.name === selectedTikTokAccount)?.archive_directory || `${data.integrations.seedanceRuntime?.downloadDirectory || "视频下载目录"}\\${selectedTikTokAccount || "账号名"}`}
                \{archiveProductId ? `${archiveProductId}.mp4` : "原视频文件名"}
              </small>
            </label>
            <label>
              <span>
                <b>{data.integrations.geminiMode === "web" ? "06" : "05"}</b>{" "}
                生成方式
              </span>
              <select value={autoQueue ? "auto" : "prompt"} onChange={(event) => onAutoQueue(event.target.value === "auto")}>
                <option value="auto">提示词 + 自动进 Seedance</option>
                <option value="prompt">仅生成提示词</option>
              </select>
            </label>
          </div>
          {data.integrations.geminiMode === "web" && <div className="creative-config-block">
            <SpokenLanguageSelect region={selectedRegion} value={spokenLanguage} onChange={onSpokenLanguage} />
            <label>
              <span>发送给 Gem 的文字（可编辑）</span>
              <textarea aria-label="发送给 Gem 的文字" rows={6} maxLength={12000}
                value={gemRequestTemplate} onChange={event => onGemRequestTemplate(event.target.value)}
                style={{ width: "100%", resize: "vertical", marginTop: 8 }} />
            </label>
            <p style={{ fontSize: 12, color: "#a6b5c6" }}>会记住你的修改。可用 {"{时长}、{地区}、{口播语言}、{拍摄风格}"} 自动带入参数；发送时会补齐口播语言，不会附加代码块要求，Gem 设定保持原样。</p>
            <details>
              <summary>查看实际发送内容</summary>
              <pre data-testid="gem-request-preview" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{buildGemRequest(gemRequestTemplate, { duration: selectedDuration, region: selectedRegion, shooting_style: selectedShootingStyle,spoken_language:spokenLanguage })}</pre>
            </details>
          </div>}
          {data.integrations.geminiMode === "web" && <VariantConfigBlock value={variantConfig} gems={data.gems}
            duration={selectedDuration} region={selectedRegion} shootingStyle={selectedShootingStyle}
            disabledReason={selectedDuration === 30 ? "双段 30 秒任务不支持变体两轮" : ""} onChange={onVariantConfig} />}
          <div className="composer-foot">
            <div className="chips">
              <span>{selectedDuration === 30 ? "双段 30 秒 · 消耗两次视频生成额度" : `${selectedDuration} 秒`}</span>
              {selectedDuration === 30 && <span>请选择双段 Gem：需输出「视频1｜上半段」和「视频2｜下半段」两份完整提示词</span>}
              {selectedDuration !== 30 && data.integrations.geminiMode === "web" && <span>{variantConfig.enabled ? "变体两轮 · " : ""}每个代码块生成一条视频，有几个代码块消耗几次额度</span>}
              <span>9:16</span>
              <span>{selectedShootingStyle}</span>
              <span>{selectedRegion}</span>
            </div>
            <button
              className="primary"
              onClick={async () => {
                const accepted = await onRun({
                    mode: productMode,
                    files: quickFiles,
                    productName: quickProductName,
                    externalId: quickExternalId,
                  });
                  if (accepted && productMode === "new") {
                    setQuickFiles([]);
                    setQuickProductName("");
                    setQuickExternalId("");
                    setQuickError("");
                }
              }}
              disabled={
                busy ||
                (productMode === "new" ? !quickFiles.length : !selectedProduct) ||
                !selectedGem ||
                !selectedTikTokAccount
              }
            >
              {busy ? <><i className="spinner" /> 正在提交…</> : <>加入并发任务 <b>↗</b></>}
            </button>
          </div>
        </div>

        <div className="pipeline-card">
          <span className="step-kicker">PIPELINE</span>
          <h3>自动化链路</h3>
          {[
            [
              "1",
              "Gemini 视觉理解",
              data.integrations.geminiMode === "web"
                ? data.integrations.gemini
                  ? `${data.integrations.geminiRuntime?.accounts?.filter((account) => account.authenticated).length || 0} 个 Gemini 网页账号在线`
                  : data.integrations.geminiRuntime?.online
                    ? "等待登录 Gemini 账号"
                    : "本机网页执行器未连接"
                : data.integrations.gemini
                  ? "API 已配置"
                  : "API 未配置 · 禁止生成",
            ],
            [
              "2",
              "脚本与提示词",
              data.integrations.gemini ? "使用所选 Gem 自动生成" : "等待 Gemini",
            ],
            ["3", "Seedance 2.0", seedanceRuntime.label],
            ["4", "自动下载归档", "所选文件夹 / 商品 ID 或原文件名"],
          ].map((item, index) => (
            <div
              className={`pipeline-step ${
                index === 0 && !data.integrations.gemini
                  ? "blocked"
                  : index === 2 && seedanceRuntime.status !== "ready"
                    ? "blocked"
                    : ""
              }`}
              key={item[1]}
            >
              <span>{item[0]}</span>
              <div><b>{item[1]}</b><small>{item[2]}</small></div>
              {index < 3 && <i />}
            </div>
          ))}
        </div>
      </section>

      <section className="workflow-summary" aria-label="任务概况">
        <span>共 <b>{data.taskCounts?.total ?? data.tasks.length}</b> 条任务</span>
        <span>处理中 <b>{data.taskCounts?.active ?? data.tasks.filter((task) => ![...VIDEO_DONE_STATUSES, ...VIDEO_FAILED_STATUSES].includes(task.status)).length}</b></span>
        <span>待检查 <b>{data.taskCounts?.review ?? data.tasks.filter(task => VIDEO_DONE_STATUSES.includes(task.status) && !APPROVED_REVIEW_STATUSES.includes(task.review_status || '')).length}</b></span>
        <span>已完成 <b>{data.taskCounts?.completed ?? data.tasks.filter((task) => VIDEO_DONE_STATUSES.includes(task.status) && APPROVED_REVIEW_STATUSES.includes(task.review_status || '')).length}</b></span>
        <button onClick={() => onNavigate("tasks")}>需处理 <b>{data.taskCounts?.attention ?? data.tasks.filter((task) => VIDEO_FAILED_STATUSES.includes(task.status)).length}</b> →</button>
      </section>

      <section className="content-grid">
        <div className="panel">
          <div className="panel-head">
            <div><span className="step-kicker">RECENT RUNS</span><h3>最近任务</h3></div>
            <button className="text-button" onClick={() => onNavigate("tasks")}>查看全部 →</button>
          </div>
          {data.tasks.length ? (
            <div className="task-list">
              {data.tasks.slice(0, 5).map((task) => (
                <button className="task-row" key={task.id} onClick={() => onPreview(task)}>
                  <div className="task-thumb">▶</div>
                  <div className="task-copy"><b>{task.product_name || task.title}</b><span>{task.gem_name}</span></div>
                  <div className="task-progress"><span style={{ width: `${Math.max(task.progress, 8)}%` }} /></div>
                  <span className={`status ${taskStatusClass(task)}`}>{taskStatusLabel(task)}</span>
                  <time>{formatTime(task.created_at)}</time>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState icon="↗" title="还没有创作任务" text="添加商品后，从上方快速创建开始。" />
          )}
        </div>

        <div className="panel quick-panel">
          <div className="panel-head"><div><span className="step-kicker">LIBRARY</span><h3>快速管理</h3></div></div>
          <button onClick={onAddProduct}><span>▣</span><div><b>添加商品</b><small>上传产品图与卖点</small></div><em>＋</em></button>
          <button onClick={onAddGem}><span>◇</span><div><b>新建 Gem</b><small>定义身份和输出框架</small></div><em>＋</em></button>
          <button onClick={() => onNavigate("settings")}><span>⚙</span><div><b>账号与下载位置</b><small>管理登录和成片保存目录</small></div><em>→</em></button>
        </div>
      </section>
    </div>
  );
}
