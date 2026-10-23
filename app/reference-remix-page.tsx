"use client";

import { DragEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { confirmAction } from './confirm-action';
import { useImageProductId } from './use-image-product-id';
import { api, desktopBridge } from './studio-client';
import type { TikTokAccount, ReferenceRemixTask, Workspace, Task } from './studio-types';
import { PageIntro, EmptyState } from './studio-ui';
import { TASK_STATUS_LABELS } from '../lib/task-statuses';
import { planRemixSegments } from '../lib/remix-segments';
import { SpokenLanguageSelect } from './spoken-language-select';
import { RemixGroupPanel } from './remix-group-panel';

export function ReferenceRemixPage({
  tasks,
  settings,
  geminiAccounts,
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
  const [spokenLanguage,setSpokenLanguage]=useState("auto");
  const [groups,setGroups]=useState<Task[]>([]);
  const [gemContent,setGemContent]=useState("");
  const [loadError,setLoadError]=useState("");
  const [productName, setProductName] = useState("");
  const [externalId, setExternalId] = useImageProductId(images);
  const [autoQueue, setAutoQueue] = useState(true);
  const [geminiAccountId, setGeminiAccountId] = useState(
    ""
  );
  const [tiktokAccountName, setTikTokAccountName] = useState(tiktokAccounts[0]?.name || "");
  const [busy, setBusy] = useState(false);
  const [dragTarget, setDragTarget] = useState<"video" | "images" | "">("");
  async function loadGroups() {
    const result=await api('/api/reference-remix') as {groups:Task[];gem:{content:string}};
    setGroups(result.groups);setGemContent(result.gem.content);setLoadError('');
  }
  useEffect(()=>{let alive=true;void api('/api/reference-remix').then(value=>{if(!alive)return;const result=value as {groups:Task[];gem:{content:string}};setGroups(result.groups);setGemContent(result.gem.content);setLoadError('');}).catch(e=>{if(alive)setLoadError(e.message);});return()=>{alive=false;};},[tasks,integrations]);
  let planText='时长读取后会显示分段计划；读不到时按视频实际内容拆解。';
  try {const plan=planRemixSegments(videoDuration);if(plan.seconds)planText=`${plan.seconds} 秒 → ${plan.segments.length} 段：${plan.segments.map(s=>s.duration+' 秒').join(' + ')}，生成 ${plan.segments.length} 条视频`;} catch {planText='对标视频超过 60 秒，请先裁剪';}

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
        body: JSON.stringify({ region }),
      });
      onNotice(`默认地区已保存：${region}`);
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
    if (!tiktokAccountName) return onNotice("请先在创作中心添加 TK 归档账号");
    if (!integrations.gemini || integrations.geminiMode !== "web") {
      return onNotice("爆款复刻需要在线的 Gemini 网页执行器");
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("video", video, video.name);
      images.forEach((file) => form.append("images", file, file.name));
      form.set("videoSeconds", String(videoDuration || ""));
      form.set("spokenLanguage",spokenLanguage);
      form.set("region", region.trim());
      form.set("productName", productName.trim());
      form.set("externalId", externalId.trim());
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
      await desktopBridge()?.setQueueRunning?.(true);
      if(autoQueue)await desktopBridge()?.seedanceSetRunning?.(true);
      await onReload();await loadGroups();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建爆款复刻任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteLegacy(id:string) {
    try {if(!await confirmAction('删除这条旧版记录及临时素材？'))return;await api('/api/reference-remix',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id})});await onReload();}catch(e){onNotice(e instanceof Error?e.message:'删除失败');}
  }

  return (
    <div className="page-body remix-page">
      <PageIntro
        title="爆款视频复刻"
        text="按参考视频实际时长分段，换品生成后逐段检查，再拼接并放入 TK 目录。"
      />
      <form className="remix-builder" onSubmit={submit}>
        <div className="remix-builder-head">
          <div>
            <span className="step-kicker">REFERENCE REMIX</span>
            <h3>一条对标视频 + 一组产品图</h3>
            <p>参考视频最长 60 秒、100MB；每段生成 4–15 秒。</p>
          </div>
          <div className="locked-gem-card">
            <span>内置 Gem · 已锁定</span>
            <b>爆款视频复刻智能体</b>
            <small>每个 Gemini 账号首次使用时自动创建</small>
            <details><summary>查看指令全文</summary><pre>{gemContent || "正在读取…"}</pre></details>
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
              <div className="remix-drop-empty"><b>01</b><strong>拖入对标爆款视频</strong><span>MP4 / MOV / WebM · ≤60秒</span></div>
            )}
            {video && (
              <div className="remix-file-caption">
                <b>{video.name}</b>
                <span>{(video.size / 1024 / 1024).toFixed(1)}MB{videoDuration ? ` · ${videoDuration.toFixed(1)}秒` : ""}</span>
                <em>{planText}</em>
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
          <SpokenLanguageSelect region={region} value={spokenLanguage} onChange={setSpokenLanguage} allowFollowReference />
          <button className="secondary remix-save-default" type="button" onClick={saveDefaults}>保存地区为默认</button>
          <label><span>商品名称 <small>选填</small></span><input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="留空则由 Gemini 识别" /></label>
          <label><span>商品 ID <small>选填</small></span><input value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder="自动识别首张图片文件名中的 ID，可修改" /></label>
          <label><span>Gemini 网页账号</span><select value={geminiAccountId} onChange={(event) => setGeminiAccountId(event.target.value)}><option value="">自动（首次领取时固定，必要时切换可用账号）</option>{geminiAccounts.map((account) => <option key={account.id} value={account.id} disabled={!account.authenticated}>{account.name}{account.authenticated ? account.busy ? "（忙碌）" : "" : "（未登录）"}</option>)}</select></label>
          <label><span>TK 归档账号</span><select value={tiktokAccountName} onChange={(event) => setTikTokAccountName(event.target.value)}><option value="">请选择归档文件夹</option>{tiktokAccounts.map((account) => <option key={account.id} value={account.name}>{account.name}</option>)}</select></label>
        </div>
        <div className="remix-options">
          <span>商品图自动保存到商品库；相同商品 ID 自动复用。</span>
          <label><input type="checkbox" checked={autoQueue} onChange={(event) => setAutoQueue(event.target.checked)} /> 提示词完成后自动进入 Seedance</label>
          <button className="primary" type="submit" disabled={busy}>{busy ? "正在上传…" : "开始自动复刻 ↗"}</button>
        </div>
      </form>

      {loadError&&<p className="form-error" role="alert">{loadError}</p>}
      <div className="remix-task-section">
        <div className="section-title"><h3>分段复刻任务</h3><span>{groups.length} 组</span></div>
        {!groups.length&&<EmptyState icon="◎" title="还没有分段复刻任务" text="上传参考视频和商品图片，开始分段复刻。" />}
        {groups.map(group=><RemixGroupPanel key={group.id} task={group} onUpdated={async message=>{if(message)onNotice(message);await onReload();await loadGroups();}} />)}
      </div>
      {tasks.length>0&&<section className="remix-task-section"><h3>旧版任务（只读）</h3>{tasks.map(task=><details className="remix-task-card" key={task.id}>
        <summary>{task.title} · {TASK_STATUS_LABELS[task.status] || task.status}</summary><p>{task.region} · TK：{task.tiktok_account_name}</p><pre>{task.reference_analysis}</pre><pre>{task.prompt}</pre>{task.error&&<p className="warning-box">{task.error}</p>}<button className="secondary danger-text" onClick={()=>void deleteLegacy(task.id)}>删除旧版记录</button>
      </details>)}</section>}
    </div>
  );
}
