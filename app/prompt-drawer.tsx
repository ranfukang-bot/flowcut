"use client";

import { useRef, useState } from 'react';
import { DEFAULT_SHOOTING_STYLE, DEFAULT_TASK_DURATION, DEFAULT_TASK_REGION } from '../lib/task-config';
import { confirmAction } from './confirm-action';
import { GeminiModelInfo } from './gemini-model-settings';
import { SeedanceTaskDetail } from './seedance-task-detail';
import { TaskBatchPanel, clipLabel } from './task-batch-panel';
import { FissionBatchPanel } from './fission-batch-panel';
import { api, desktopBridge } from './studio-client';
import type { Gem, Task } from './studio-types';
import { formatTime } from './studio-ui';
import { TaskChain, taskStatusClass, taskStatusLabel } from './task-status';
import { APPROVED_REVIEW_STATUSES, CONCAT_REVIEW_STATUSES, PROMPT_ONLY_STATUSES, VIDEO_DONE_STATUSES, VIDEO_RUNNING_STATUSES } from '../lib/task-statuses';

export function PromptDrawer({
  task,
  gems,
  onClose,
  onUpdated,
  onOpenTask,
}: {
  task: Task;
  gems: Gem[];
  onClose: () => void;
  onUpdated: (message: string) => Promise<void>;
  onOpenTask: (task: Task) => void;
}) {
  const isFission=task.task_role==='fission';
  const isFissionChild=task.task_role==='fission_child';
  const isGroup = task.task_role === "group" || isFission;
  const isClip = task.task_role === "clip" || isFissionChild;
  const isConcat = task.task_role === "concat";
  const merged = CONCAT_REVIEW_STATUSES.includes(task.review_status || '');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const [recreateError, setRecreateError] = useState("");
  const [recreateGemId, setRecreateGemId] = useState("");
  const [recreateRequested, setRecreateRequested] = useState(false);
  const recreateRequest = useRef<string | null>(null);
  const recreateMode = useRef<boolean | null>(null);
  const recreateLock = useRef(false);
  async function recreateTask(rewriteMother=false) {
    if (recreateLock.current) return;
    recreateLock.current = true;
    setBusy("recreate");
    setRecreateError("");
    try {
      if(recreateRequested && recreateMode.current!==null)rewriteMother=recreateMode.current;
      const gemLabel = recreateGemId ? gems.find(gem => gem.id === recreateGemId)?.name : '原任务 Gem 设定';
      const confirmText = rewriteMother
        ? '确认用母版重新写这条提示词并生成新视频？将重新运行本商品的变体 Gem，使用原商品图片、商品 ID 和共用母版，会额外消耗一次视频额度。旧视频会删除，新视频仍需检查。'
        : isClip
        ? `确认删除这条视频并用同一条提示词重新生成？不经过 Gemini，旧视频将永久删除，会消耗一次视频生成额度。新视频仍为待检查，不会自动发布。`
        : `确认删除旧成片并重新生成？本次使用：${gemLabel}。旧视频将永久删除，旧任务也会从列表移除。沿用本任务的图片、商品 ID 和视频参数，从提示词开始重新生成，会消耗生成额度。新成片仍为待检查，不会自动发布。`;
      if (!await confirmAction(confirmText)) return;
      recreateRequest.current ||= crypto.randomUUID();
      recreateMode.current=rewriteMother;
      setRecreateRequested(true);
      const result = await api("/api/tasks/recreate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: task.id, requestId: recreateRequest.current, gemId: isClip ? undefined : recreateGemId || undefined, rewriteMother }),
      }) as { id: string; status?: string; created: boolean };
      let message = !result.created ? "已有重做任务，未重复创建"
        : rewriteMother ? '已保存重写任务，将用原母版和本商品图片重新运行变体 Gem'
        : isClip ? (result.status === "prompt_ready" ? "已新建重做任务（同一条提示词），请打开它点“提交 Seedance”" : "已新建重做任务，将用同一条提示词重新生成视频")
        : "已新建重做任务，将从 Gemini 提示词开始完整生成视频";
      const desktop = desktopBridge();
      if (!desktop?.discardReviewVideo) throw new Error('重做任务已保存，但旧视频尚未删除：请在最新版桌面程序中操作');
      try { await desktop.discardReviewVideo(task.id, result.id); }
      catch (error) { throw new Error(`重做任务已保存，但旧视频或旧任务删除失败，请重试：${error instanceof Error ? error.message : error}`); }
      try {
        const desktop = desktopBridge();
        await desktop?.setQueueRunning?.(true);
        await desktop?.seedanceSetRunning?.(true);
      } catch {
        message += "；任务已保存，请在账号与设置中启动队列";
      }
      await onUpdated(message);
      onClose();
    } catch (error) {
      setRecreateError(error instanceof Error ? error.message : "重做任务创建失败，请重试");
    } finally {
      recreateLock.current = false;
      setBusy("");
    }
  }
  async function copy() {
    await navigator.clipboard.writeText(task.prompt || '');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  async function reviewAction(action: 'open' | 'approve' | 'folder' | 'delete') {
    if (busy) return;
    setBusy(action); setRecreateError('');
    try {
      const desktop = desktopBridge();
      if (action === 'delete') {
        if (!await confirmAction(isConcat
          ? `确认删除这条拼接成片？成片文件会永久删除，参与拼接的 ${task.batch_size || ''} 条原视频会回到待检查，可以重新拼接或单独通过。`
          : `确认删除该任务并永久删除该视频？商品 ID：${task.product_external_id || '未填写'}，TK 账号：${task.tiktok_account_name || '未填写'}。临时目录中的这条视频和任务记录将一起删除，不会重新生成。商品图片和 Gem 模板保留。`)) return;
        if (!desktop?.deletePendingReviewVideo) throw Error('请在最新版 FlowCut 桌面程序中删除任务和视频');
        await desktop.deletePendingReviewVideo(task.id, true);
        await onUpdated(isConcat ? '已删除拼接成片，原视频已回到待检查' : '已删除该任务及临时视频，没有重新生成');
        onClose();
      } else if (action === 'folder') {
        if (!desktop?.openReviewFolder) throw Error('请在最新版 FlowCut 桌面程序中打开临时目录');
        await desktop.openReviewFolder(task.id);
      } else if (action === 'open') {
        if (!desktop?.openReviewVideo) throw Error('请在新版 FlowCut 桌面程序中查看视频');
        await desktop.openReviewVideo(task.id);
      } else {
        if (!await confirmAction(`确认通过此成片？商品 ID：${task.product_external_id || '未填写'}，账号：${task.tiktok_account_name}。通过后将送入本任务设置的发布文件夹；如果自动发布正在运行，可能很快开始上传。请确认内容和账号橱窗无误。${isConcat ? '通过后，参与拼接的原视频会从待检查中删除。' : ''}`)) return;
        if (!desktop?.approveReviewVideo) throw Error('请在新版 FlowCut 桌面程序中审核');
        const approved = await desktop.approveReviewVideo(task.id, true) as { cleanupWarning?: string };
        await onUpdated(approved?.cleanupWarning ? `已审核通过；${approved.cleanupWarning}` : '已审核通过，视频已送入原发布目录');
      }
    } catch(error) { setRecreateError(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(''); }
  }
  async function taskAction(action: "queue" | "check" | "retry" | "regenerate") {
    setBusy(action);
    try {
      await api("/api/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          action,
          autoQueue: action === "regenerate",
        }),
      });
      await onUpdated(
        action === "queue"
          ? "已提交到 Seedance 视频生成队列"
          : action === "regenerate"
            ? "Gemini 已重新识别商品图，并提交到 Seedance"
          : action === "check"
            ? "已刷新视频生成状态"
            : "任务已恢复到提示词就绪状态"
      );
    } catch (error) {
      setBusy("");
      await onUpdated(error instanceof Error ? error.message : "任务操作失败");
    }
  }
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <span className="step-kicker">AUTOMATION RESULT</span>
            <h2>{isFission?task.title:task.product_name || task.title}</h2>
            <p>{task.gem_name}{isClip || isConcat ? ` · ${clipLabel(task)}` : ""}</p>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <div className="drawer-status">
          <span className={`status ${taskStatusClass(task)}`}>
            {taskStatusLabel(task)}
          </span>
          <em>
            {task.provider === "demo-engine"
              ? "旧版演示结果 · 未识别图片"
              : isConcat
                ? "本机拼接成片"
              : task.provider.startsWith("seedance")
                ? "Gemini → Seedance"
                : task.provider === "gemini-web"
                  ? "Gemini 网页版真实结果"
                  : "Gemini API 真实结果"}
          </em>
          {task.tiktok_account_name && (
            <em className="tk-task-badge">TK：{task.tiktok_account_name}</em>
          )}
          <em className="task-config-badge">
            {task.duration || DEFAULT_TASK_DURATION}秒 ·{" "}
            {task.region || DEFAULT_TASK_REGION} ·{" "}
            {task.shooting_style || DEFAULT_SHOOTING_STYLE}
          </em>
          <time>{formatTime(task.created_at)}</time>
        </div>
        {task.duration === 30 && !task.task_role && <div className="download-result"><b>双段 30 秒 · 15秒＋15秒</b><span>{task.segment_progress || "等待 Gemini 生成两段提示词"}</span></div>}
        <div className="drawer-chain-wrap">
          <span>本任务执行链路</span>
          <GeminiModelInfo value={task.gemini_model_info} />
          {!isGroup && !isConcat && <SeedanceTaskDetail taskId={task.id} />}
          <TaskChain task={task} />
        </div>
        {task.prompt_note && !isGroup && <div className="warning-box">{task.prompt_note}</div>}
        {isFission && <FissionBatchPanel task={task} statusLabel={taskStatusLabel} onOpenTask={onOpenTask} />}
        {isGroup && !isFission && <TaskBatchPanel task={task} statusLabel={child => taskStatusLabel(child as Task)}
          onOpenTask={child => onOpenTask(child as Task)} onUpdated={onUpdated} desktop={desktopBridge} request={api} />}
        {merged && <div className="download-result">
          <b>{task.review_status === 'merging' ? '正在拼接这条视频' : '这条视频已用于拼接'}</b>
          <span>请审核拼接成片。如果不满意，删除拼接成片后这条视频会回到待检查，可以单独通过或重新拼接。</span>
          {task.merged_into_task_id && <button className="secondary" onClick={() => onOpenTask({ ...task, id: task.merged_into_task_id! })}>查看拼接成片</button>}
        </div>}
        {task.provider === "demo-engine" && (
          <div className="warning-box strong-warning">
            这段提示词不是根据你的商品图生成的。商品图片已经保存，但当时 Gemini
            未配置，旧版系统错误地塞入了演示内容。保存 Gemini Key
            后，点击下方按钮即可用原来的全部商品图重新识别。
          </div>
        )}
        {task.error && (
          <div className="warning-box">
            {task.error === "Failed to fetch"
              ? "上次 Seedance 提交失败：浏览器无法访问本机工作台。请在接口设置中重新测试，并允许浏览器访问本地网络。"
              : task.error}
          </div>
        )}
        {task.download_path && (
          <div className="download-result">
            <b>{task.review_status === 'approved' ? '成片已审核通过' : '成片已下载 · 请检查'}</b>
            <span>{task.approved_path || task.download_path}</span>
            <button className="secondary" disabled={Boolean(busy) || task.review_status === 'replaced'} onClick={() => reviewAction('open')}>外部打开视频</button>
            {!APPROVED_REVIEW_STATUSES.includes(task.review_status || '') && <button className="secondary" disabled={Boolean(busy)} onClick={() => reviewAction('folder')}>打开临时存放目录</button>}
            {!['approved','replaced','deleting','merging','merged'].includes(task.review_status || '') && <button className="primary" disabled={Boolean(busy)} onClick={() => reviewAction('approve')}>通过检查并送入发布目录</button>}
            {task.approved_path && <span>已放行至：{task.approved_path}</span>}
            {!task.download_path.includes('review-videos') && task.review_status !== 'approved' && <span>这是旧版已下载的文件，可能早已在发布目录中。此状态不会撤回已开始的发布。</span>}
          </div>
        )}
        {isConcat && VIDEO_DONE_STATUSES.includes(task.status) && ['pending','deleting'].includes(task.review_status || 'pending') && task.download_path && (
          <div className="download-result">
            <b>拼接成片不满意？</b>
            <span>删除这条拼接成片后，参与拼接的原视频会回到待检查，可以单独通过、重做或重新拼接。</span>
            <button className="secondary" disabled={Boolean(busy)} onClick={() => reviewAction('delete')}>
              {busy === 'delete' ? '正在删除…' : '删除拼接成片'}
            </button>
          </div>
        )}
        {!isConcat && !merged && VIDEO_DONE_STATUSES.includes(task.status) && !['approved','approving'].includes(task.review_status || '') && (
          <div className="download-result">
            <b>{isClip ? "这条视频不满意？" : "成片不满意？用这些素材重新制作"}</b>
            <span>{isClip
              ? "用同一条提示词重新生成视频（不经过 Gemini），旧视频会删除，新视频放回本组同一位置，仍需检查。"
              : "删除旧成片和旧任务，复用原图片和商品 ID，从提示词开始重做。默认沿用原 Gem，也可切换。新成片仍需检查。"}</span>
            {!isClip && <label>重做使用的 Gem
              <select aria-label="重做使用的 Gem" value={recreateGemId} disabled={Boolean(busy) || recreateRequested || ['replaced','deleting'].includes(task.review_status || '')} onChange={event => setRecreateGemId(event.target.value)}>
                <option value="">沿用原任务 Gem（{task.gem_name || '原设定'}）</option>
                {gems.map(gem => <option key={gem.id} value={gem.id}>{gem.name}</option>)}
              </select>
            </label>}
            <button className="secondary" disabled={Boolean(busy) || task.review_status === 'deleting'} onClick={()=>void recreateTask()}>
              {busy === "recreate" ? "正在处理…" : task.review_status === 'replaced' ? '完成旧成片清理（不重复生成）' : "重新生成该任务"}
            </button>
            {isFissionChild && <button className="secondary" disabled={Boolean(busy)||recreateRequested||task.review_status==='replaced'} onClick={()=>void recreateTask(true)}>用母版重新写这条提示词</button>}
            {['pending','deleting'].includes(task.review_status || 'pending') && task.download_path && <button className="secondary" disabled={Boolean(busy) || recreateRequested} onClick={() => reviewAction('delete')}>
              {busy === 'delete' ? '正在删除…' : '删除该任务并删除该视频'}
            </button>}
          </div>
        )}
        {recreateError && <div role="alert" className="warning-box">{recreateError}</div>}
        {task.archive_directory && <p className="download-destination">本任务保存到：{task.archive_directory}</p>}
        {task.download_error && (
          <div className="warning-box">
            下载状态：{task.download_error}
          </div>
        )}
        {!isGroup && task.error && task.gemini_raw_reply && <details className="warning-box">
          <summary>查看 Gemini 原始回复</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{task.gemini_raw_reply}</pre>
        </details>}
        {!isConcat && !isGroup && <>
        <div className="prompt-title">
          <b>{task.provider === "demo-engine" ? "旧演示提示词（不可提交）" : isClip ? `本条视频的提示词（${clipLabel(task)}）` : "Gemini 生成的 Seedance 提示词"}</b>
        </div>
        <pre>{task.prompt || "尚未生成提示词"}</pre>
        </>}
        <div className="drawer-foot">
          {!isConcat && (!isGroup || Boolean(task.variant_mode)) && <button
            className="secondary"
            onClick={copy}
            disabled={!task.prompt || task.provider === "demo-engine"}
          >
            {copied ? "已复制" : isGroup ? "复制母版提示词" : "复制提示词"}
          </button>}
          {task.provider === "demo-engine" && (
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={() => taskAction("regenerate")}
            >
              {busy === "regenerate" ? "Gemini 识别中…" : "重新用 Gemini 识别并生成视频"}
            </button>
          )}
          {PROMPT_ONLY_STATUSES.includes(task.status) &&
            task.provider !== "demo-engine" && (
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={() => taskAction("queue")}
            >
              {busy === "queue" ? "提交中…" : task.status === "seedance_blocked" ? "重试提交 Seedance" : "提交 Seedance"}
            </button>
          )}
          {VIDEO_RUNNING_STATUSES.includes(task.status) &&
            task.provider_status_url &&
            task.provider !== "seedance-bridge" && (
              <button
                className="primary"
                disabled={Boolean(busy)}
                onClick={() => taskAction("check")}
              >
                {busy === "check" ? "查询中…" : "刷新生成状态"}
              </button>
            )}
          {task.status === "failed" && (
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={() => taskAction("retry")}
            >
              恢复任务
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </aside>
    </div>
  );
}
