"use client";
import { useMemo, useState } from "react";
import { confirmAction } from "./confirm-action";

export type BatchTask = {
  id: string;
  status: string;
  task_role?: string | null;
  review_status?: string;
  download_path?: string | null;
  batch_index?: number | null;
  batch_round?: number | null;
  batch_size?: number | null;
  duration?: number;
  prompt?: string;
  prompt_note?: string | null;
  gemini_raw_reply?: string | null;
  variant_request_text?: string | null;
  variant_mode?: number;
  product_external_id?: string;
  tiktok_account_name?: string;
  children?: BatchTask[];
};

type ConcatBridge = { concatReviewVideos?: (groupId: string, ids: string[], confirmed: boolean) => Promise<{ id: string; file: string }> };

export function concatEligible(task: BatchTask) {
  return task.task_role === "clip" && ["video_ready", "scheduled"].includes(task.status)
    && Boolean(task.download_path) && (task.review_status || "pending") === "pending";
}

export function clipLabel(task: BatchTask) {
  if (task.task_role === "concat") return "拼接成片";
  const round = Number(task.batch_round || 1);
  return `${round > 1 ? `第 ${round} 批 · ` : ""}第 ${task.batch_index || "?"}/${task.batch_size || "?"} 条`;
}

// Group detail: the mother prompt and raw reply, every clip of the group,
// concatenation of selected clips and, for two-round tasks, a new split.
export function TaskBatchPanel({ task, statusLabel, onOpenTask, onUpdated, desktop, request }: {
  task: BatchTask;
  statusLabel: (task: BatchTask) => string;
  onOpenTask: (task: BatchTask) => void;
  onUpdated: (message: string) => Promise<void>;
  desktop: () => ConcatBridge | undefined;
  request: (path: string, init?: RequestInit) => Promise<unknown>;
}) {
  const children = useMemo(() => task.children || [], [task.children]);
  const eligible = children.filter(concatEligible);
  const [selected, setSelected] = useState<string[] | null>(null);
  const chosen = (selected ?? eligible.map(child => child.id)).filter(id => eligible.some(child => child.id === id));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const canResplit = Boolean(task.variant_mode) && ["split_done", "failed"].includes(task.status) && Boolean(task.prompt?.trim());

  function toggle(id: string, checked: boolean) {
    const current = selected ?? eligible.map(child => child.id);
    setSelected(checked ? [...new Set([...current, id])] : current.filter(item => item !== id));
  }
  async function concat() {
    if (busy || chosen.length < 2) return;
    const ordered = eligible.filter(child => chosen.includes(child.id));
    if (!await confirmAction(`确认把这 ${ordered.length} 条视频按顺序（${ordered.map(clipLabel).join(" → ")}）拼成一条？拼好的成片会进入待检查；这几条原视频不能再单独通过，删除拼接成片后它们会回到待检查。拼接在本机完成，不消耗生成额度。`)) return;
    setBusy("concat"); setError("");
    try {
      const bridge = desktop();
      if (!bridge?.concatReviewVideos) throw new Error("请在最新版 FlowCut 桌面程序中拼接");
      await bridge.concatReviewVideos(task.id, ordered.map(child => child.id), true);
      setSelected(null);
      await onUpdated("已拼接成一条新成片，请在待检查中审核");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "拼接失败"); }
    finally { setBusy(""); }
  }
  async function resplit() {
    if (busy) return;
    if (!await confirmAction("用同一份母版重新跑一次变体 Gem？会生成新一批视频并消耗生成额度；已有的视频保留，不满意的请自行删除。")) return;
    setBusy("resplit"); setError("");
    try {
      await request("/api/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: task.id, action: "resplit" }) });
      await onUpdated("已重新排队变体 Gem，生成后会新增一批视频");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "重新分裂失败"); }
    finally { setBusy(""); }
  }

  return <div className="download-result" aria-label="本组视频">
    <b>{task.variant_mode ? "变体两轮" : "按代码块分条"} · 共 {children.filter(child => child.task_role !== "concat").length} 条视频</b>
    <span>每个代码块生成一条视频，代码框外的说明和表格不会用于生成。每条可以单独通过或删除，也可以勾选几条拼成一条。</span>
    {task.prompt_note && <span>{task.prompt_note}</span>}
    <div role="list" className="batch-clip-list">
      {children.map(child => <div role="listitem" key={child.id} className="batch-clip">
        {eligible.length >= 2 && concatEligible(child)
          ? <input type="checkbox" aria-label={`拼接时包含${clipLabel(child)}`} checked={chosen.includes(child.id)} disabled={Boolean(busy)} onChange={event => toggle(child.id, event.target.checked)} />
          : <i aria-hidden="true" />}
        <b>{clipLabel(child)}</b>
        <span className="status">{statusLabel(child)}</span>
        <button type="button" className="batch-clip-open" onClick={() => onOpenTask(child)}>查看</button>
      </div>)}
      {!children.length && <span>{task.status === "split_done" ? "本组视频已全部删除" : "提示词生成后会在这里列出每条视频"}</span>}
    </div>
    {eligible.length >= 2 ? <button type="button" className="primary" disabled={Boolean(busy) || chosen.length < 2} onClick={() => void concat()}>
      {busy === "concat" ? "正在拼接…" : `拼接所选（${chosen.length} 条）`}
    </button> : children.length > 1 && <span>有 2 条以上待检查的视频时，可以勾选后拼成一条。</span>}
    {canResplit && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void resplit()}>
      {busy === "resplit" ? "正在排队…" : "用同一份母版重新分裂"}
    </button>}
    {error && <div role="alert" className="warning-box">{error}</div>}
    {Boolean(task.variant_mode) && task.prompt && <details>
      <summary>母版提示词（第一轮）</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{task.prompt}</pre>
    </details>}
    {task.variant_request_text && <details>
      <summary>第二轮发送给变体 Gem 的文字</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{task.variant_request_text}</pre>
    </details>}
    {task.gemini_raw_reply && <details>
      <summary>最近一次 Gemini 原始回复</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{task.gemini_raw_reply}</pre>
    </details>}
  </div>;
}
