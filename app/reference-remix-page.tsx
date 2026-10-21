"use client";

import { DragEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { confirmAction } from './confirm-action';
import { useImageProductId } from './use-image-product-id';
import { GeminiModelInfo } from './gemini-model-settings';
import { SeedanceTaskDetail } from './seedance-task-detail';
import { api } from './studio-client';
import type { TikTokAccount, ReferenceRemixTask, Workspace } from './studio-types';
import { PageIntro, EmptyState } from './studio-ui';
import { statusLabels } from './task-status';

export function ReferenceRemixPage({
  tasks,
  settings,
  geminiAccounts,
  defaultGeminiAccountId,
  tiktokAccounts,
  integrations,
  onReload,
  onNotice,
}: {
  tasks: ReferenceRemixTask[];
  settings: { duration: number; region: string };
  geminiAccounts: Array<{ id: string; name: string; authenticated: boolean; busy?: boolean }>;
  defaultGeminiAccountId: string;
  tiktokAccounts: TikTokAccount[];
  integrations: Workspace["integrations"];
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [video, setVideo] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [images, setImages] = useState<File[]>([]);
  const [region, setRegion] = useState(settings.region || "马来西亚");
  const [duration, setDuration] = useState(Number(settings.duration || 15));
  const [productName, setProductName] = useState("");
  const [externalId, setExternalId] = useImageProductId(images);
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [autoQueue, setAutoQueue] = useState(true);
  const [geminiAccountId, setGeminiAccountId] = useState(
    defaultGeminiAccountId || geminiAccounts.find((account) => account.authenticated)?.id || ""
  );
  const [tiktokAccountName, setTikTokAccountName] = useState(tiktokAccounts[0]?.name || "");
  const [busy, setBusy] = useState(false);
  const [dragTarget, setDragTarget] = useState<"video" | "images" | "">("");
  const [expanded, setExpanded] = useState<string>("");

  const videoPreview = useMemo(() => (video ? URL.createObjectURL(video) : ""), [video]);
  const imagePreviews = useMemo(
    () => images.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [images]
  );
  useEffect(() => {
    return () => {
      if (videoPreview) URL.revokeObjectURL(videoPreview);
      imagePreviews.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [videoPreview, imagePreviews]);

  function chooseVideo(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      onNotice("请上传 MP4、MOV 或 WebM 对标视频");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      onNotice("对标视频不能超过 100MB");
      return;
    }
    setVideo(file);
    setVideoDuration(0);
  }

  function appendImages(files: File[]) {
    const valid = files.filter((file) => file.type.startsWith("image/"));
    if (valid.length !== files.length) onNotice("已忽略非图片文件");
    if (valid.some((file) => file.size > 12 * 1024 * 1024)) {
      onNotice("单张产品图片不能超过 12MB");
      return;
    }
    setImages((current) => {
      const known = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      const appended = valid.filter(
        (file) => !known.has(`${file.name}:${file.size}:${file.lastModified}`)
      );
      if (current.length + appended.length > 12) {
        onNotice("产品图片最多 12 张");
      }
      return [...current, ...appended].slice(0, 12);
    });
  }

  async function saveDefaults() {
    try {
      await api("/api/reference-remix", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ duration, region }),
      });
      onNotice(`默认参数已保存：${region} · ${duration}秒`);
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存默认参数失败");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!video) return onNotice("请上传一条对标视频");
    if (!images.length) return onNotice("请上传产品图片");
    if (videoDuration > 60) return onNotice("对标视频超过 60 秒，请先裁剪后再上传");
    if (!geminiAccountId) return onNotice("请选择一个已登录的 Gemini 网页账号");
    if (!tiktokAccountName) return onNotice("请先在创作中心添加 TK 归档账号");
    if (!integrations.gemini || integrations.geminiMode !== "web") {
      return onNotice("爆款复刻需要在线的 Gemini 网页执行器");
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("video", video, video.name);
      images.forEach((file) => form.append("images", file, file.name));
      form.set("duration", String(duration));
      form.set("region", region.trim());
      form.set("productName", productName.trim());
      form.set("externalId", externalId.trim());
      form.set("saveToLibrary", String(saveToLibrary));
      form.set("autoQueue", String(autoQueue));
      form.set("geminiAccountId", geminiAccountId);
      form.set("tiktokAccountName", tiktokAccountName);
      await api("/api/reference-remix", { method: "POST", body: form });
      setVideo(null);
      setVideoDuration(0);
      setImages([]);
      setProductName("");
      setExternalId("");
      onNotice("爆款复刻任务已加入队列；两轮 Gemini 会在同一个对话中完成");
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建爆款复刻任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, requestedAction: "retry" | "queue" | "delete") {
    try {
      if (requestedAction === "delete") {
        if (!await confirmAction("确认删除这条复刻任务及其临时素材？已保存到商品库的副本不会删除。")) return;
        await api("/api/reference-remix", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } else {
        await api("/api/reference-remix", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, action: requestedAction }),
        });
      }
      onNotice(
        requestedAction === "retry"
          ? "任务已从第一轮重新开始"
          : requestedAction === "queue"
            ? "已提交 Seedance 队列"
            : "复刻任务已删除"
      );
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <div className="page-body remix-page">
      <PageIntro
        title="爆款视频复刻"
        text="先让 Gemini 拆解对标视频，再在同一对话上传产品图完成改编，最终自动送入 Seedance。该模块与普通 Gem 创作完全隔离。"
      />
      <form className="remix-builder" onSubmit={submit}>
        <div className="remix-builder-head">
          <div>
            <span className="step-kicker">REFERENCE REMIX</span>
            <h3>一条对标视频 + 一组产品图</h3>
            <p>建议对标视频控制在 20 秒内；最长接受 60 秒、100MB。</p>
          </div>
          <div className="locked-gem-card">
            <span>内置 Gem · 已锁定</span>
            <b>爆款视频结构复刻智能体</b>
            <small>仅本模块使用，不会出现在普通 Gem 列表</small>
          </div>
        </div>

        <div className="remix-upload-grid">
          <label
            className={`remix-drop ${dragTarget === "video" ? "dragging" : ""} ${video ? "has-file" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragTarget("video"); }}
            onDragLeave={() => setDragTarget("")}
            onDrop={(event: DragEvent<HTMLLabelElement>) => {
              event.preventDefault();
              setDragTarget("");
              chooseVideo(event.dataTransfer.files[0]);
            }}
          >
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={(event) => chooseVideo(event.target.files?.[0])}
            />
            {videoPreview ? (
              <video
                src={videoPreview}
                controls
                onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
              />
            ) : (
              <div className="remix-drop-empty"><b>01</b><strong>拖入对标爆款视频</strong><span>MP4 / MOV / WebM · 建议 ≤20秒</span></div>
            )}
            {video && (
              <div className="remix-file-caption">
                <b>{video.name}</b>
                <span>{(video.size / 1024 / 1024).toFixed(1)}MB{videoDuration ? ` · ${videoDuration.toFixed(1)}秒` : ""}</span>
                {videoDuration > 20 && <em>可用，但建议先压缩到 20 秒内</em>}
              </div>
            )}
          </label>

          <label
            className={`remix-drop product-drop ${dragTarget === "images" ? "dragging" : ""} ${images.length ? "has-file" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragTarget("images"); }}
            onDragLeave={() => setDragTarget("")}
            onDrop={(event: DragEvent<HTMLLabelElement>) => {
              event.preventDefault();
              setDragTarget("");
              appendImages(Array.from(event.dataTransfer.files));
            }}
          >
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={(event) => appendImages(Array.from(event.target.files || []))}
            />
            {!images.length && (
              <div className="remix-drop-empty"><b>02</b><strong>拖入你的产品图片</strong><span>最多 12 张 · 可分多次继续添加</span></div>
            )}
            {imagePreviews.length > 0 && (
              <div className="remix-image-strip">
                {imagePreviews.map((item, index) => (
                  <span key={`${item.file.name}-${item.file.lastModified}`}>
                    <img src={item.url} alt={item.file.name} />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        setImages((current) => current.filter((_, itemIndex) => itemIndex !== index));
                      }}
                    >×</button>
                  </span>
                ))}
                <em>{images.length}/12 张</em>
              </div>
            )}
          </label>
        </div>

        <div className="remix-config-grid">
          <label><span>投放地区</span><input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="例如：马来西亚" /></label>
          <label><span>视频秒数</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={15}>15 秒</option></select></label>
          <button className="secondary remix-save-default" type="button" onClick={saveDefaults}>保存地区与秒数为默认</button>
          <label><span>商品名称 <small>选填</small></span><input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="留空则由 Gemini 识别" /></label>
          <label><span>商品 ID <small>选填</small></span><input value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder="自动识别首张图片文件名中的 ID，可修改" /></label>
          <label><span>Gemini 网页账号</span><select value={geminiAccountId} onChange={(event) => setGeminiAccountId(event.target.value)}><option value="">请选择已登录账号</option>{geminiAccounts.map((account) => <option key={account.id} value={account.id} disabled={!account.authenticated}>{account.name}{account.authenticated ? account.busy ? "（忙碌）" : "" : "（未登录）"}</option>)}</select></label>
          <label><span>TK 归档账号</span><select value={tiktokAccountName} onChange={(event) => setTikTokAccountName(event.target.value)}><option value="">请选择归档文件夹</option>{tiktokAccounts.map((account) => <option key={account.id} value={account.name}>{account.name}</option>)}</select></label>
        </div>
        <div className="remix-options">
          <label><input type="checkbox" checked={saveToLibrary} onChange={(event) => setSaveToLibrary(event.target.checked)} /> 同时把产品图保存到普通商品库</label>
          <label><input type="checkbox" checked={autoQueue} onChange={(event) => setAutoQueue(event.target.checked)} /> 提示词完成后自动进入 Seedance</label>
          <button className="primary" type="submit" disabled={busy}>{busy ? "正在上传…" : "开始自动复刻 ↗"}</button>
        </div>
      </form>

      <div className="remix-task-section">
        <div className="section-title"><div><span className="eyebrow">REMIX RUNS</span><h3>复刻任务</h3></div><span>{tasks.length} 条</span></div>
        {!tasks.length ? (
          <EmptyState icon="◎" title="还没有复刻任务" text="上传一条对标视频和产品图，系统会自动跑完双轮对话与视频生成。" />
        ) : tasks.map((task) => {
          const activeStage = task.status === "reference_queued" ? 1 : ["reference_analyzing", "product_adapting"].includes(task.status) ? 2 : ["prompt_ready", "seedance_blocked"].includes(task.status) ? 3 : ["video_queued", "video_generating"].includes(task.status) ? 4 : task.status === "video_ready" ? 5 : 0;
          const isExpanded = expanded === task.id;
          return (
            <article className="remix-task-card" key={task.id}>
              <button className="remix-task-summary" type="button" onClick={() => setExpanded(isExpanded ? "" : task.id)}>
                <div><b>{task.title}</b><span>{task.duration}秒 · {task.region} · TK：{task.tiktok_account_name}</span></div>
                <div className="remix-progress"><i style={{ width: `${task.progress}%` }} /></div>
                <span className={`status ${task.status}`}>{statusLabels[task.status] || task.status}</span>
                <em>{isExpanded ? "收起" : "详情"}</em>
              </button>
              <div className="remix-stage-chain">
                {["素材已保存", "拆解对标视频", "同对话换产品", "Seedance 生成", "成片归档"].map((label, index) => (
                  <div className={activeStage > index + 1 ? "done" : activeStage === index + 1 ? "active" : "waiting"} key={label}><span>{activeStage > index + 1 ? "✓" : index + 1}</span><b>{label}</b></div>
                ))}
              </div>
              {task.error && <div className="warning-box">{task.error}</div>}
              {isExpanded && (
                <div className="remix-task-detail">
                  <GeminiModelInfo value={task.gemini_model_info} />
                  <SeedanceTaskDetail taskId={task.id} />
                  <div><h4>第一轮 · 对标结构分析</h4><pre>{task.reference_analysis || "等待 Gemini 完成第一轮分析…"}</pre></div>
                  <div><h4>第二轮 · 最终 Seedance 提示词</h4><pre>{task.prompt || "等待同一对话上传产品图并继续改编…"}</pre></div>
                  {task.download_path && <p className="download-note">成片已归档：{task.download_path}</p>}
                  <div className="row-actions">
                    {task.prompt && <button type="button" onClick={() => navigator.clipboard.writeText(task.prompt).then(() => onNotice("最终提示词已复制"))}>复制最终提示词</button>}
                    {task.status === "prompt_ready" && <button type="button" onClick={() => action(task.id, "queue")}>提交 Seedance</button>}
                    {["failed", "seedance_blocked"].includes(task.status) && <button type="button" onClick={() => action(task.id, "retry")}>从第一轮重试</button>}
                    <button className="danger-text" type="button" onClick={() => action(task.id, "delete")}>删除</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
