"use client";

import { useState } from 'react';
import { DEFAULT_TASK_DURATION, DEFAULT_TASK_REGION } from '../lib/task-config';
import { ApprovalStats } from './approval-stats';
import { useTaskPage } from './use-task-page';
import { clipLabel } from './task-batch-panel';
import { desktopBridge } from './studio-client';
import type { Task, Workspace } from './studio-types';
import { formatTime, PageIntro, EmptyState } from './studio-ui';
import { withChildren, TaskChain, taskStatusClass, taskStatusLabel } from './task-status';
import { APPROVED_REVIEW_STATUSES, CONCAT_REVIEW_STATUSES, GEMINI_STATUSES, GROUP_ROLES, VIDEO_DONE_STATUSES, VIDEO_FAILED_STATUSES } from '../lib/task-statuses';

export function TasksPage({
  tasks,
  geminiRuntime,
  onPreview,
  onDelete,
  onClearCompleted,
  onClearAll,
}: {
  tasks: Task[];
  geminiRuntime?: Workspace["integrations"]["geminiRuntime"];
  onPreview: (task: Task) => void;
  onDelete: (task: Task) => void;
  onClearCompleted: () => void;
  onClearAll: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [videoError, setVideoError] = useState("");
  const refreshKey = withChildren(tasks).map(task => `${task.id}:${task.updated_at}:${task.status}:${task.review_status}`).join('|');
  const { tasks: visibleTasks, hasMore, loading, error: listError, resetPages, loadMore } = useTaskPage(tasks, filter, query, refreshKey);
  async function openVideo(task: Task) {
    setVideoError("");
    try {
      const desktop = desktopBridge();
      if (!desktop?.openReviewVideo) throw Error('请在新版 FlowCut 桌面程序中查看本地视频');
      await desktop.openReviewVideo(task.id);
    } catch (error) { setVideoError(error instanceof Error ? error.message : '视频打开失败'); }
  }
  const completed = (task: Task) => VIDEO_DONE_STATUSES.includes(task.status) && APPROVED_REVIEW_STATUSES.includes(task.review_status || '');
  const pendingReview = (task: Task) => VIDEO_DONE_STATUSES.includes(task.status) && !completed(task) && !CONCAT_REVIEW_STATUSES.includes(task.review_status || '');
  const failed = (task: Task) => VIDEO_FAILED_STATUSES.includes(task.status);
  const progressText = (task: Task) => {
    if (GEMINI_STATUSES.includes(task.status)) {
      if (!geminiRuntime?.online) return "Gemini 执行器离线，请在账号与设置中检查";
      const active = geminiRuntime.activeJobs?.find((job) => job.taskId === task.id);
      if (active) return `${active.accountName || "Gemini"} · ${active.stage || "正在处理"}`;
      if (!geminiRuntime.queueRunning) return "队列已暂停，请在账号与设置中继续";
      if (!geminiRuntime.authenticated) return "等待 Gemini 账号登录";
      return task.error || "排队中，账号空闲后自动开始";
    }
    return task.download_error || task.error || task.segment_progress || "";
  };
  return (
    <div className="page-body">
      <PageIntro
        title="自动化任务队列"
        text="每个任务都保留完整提示词和执行状态，失败后可以从断点继续。"
        action="清除已完成"
        actionIcon="✓"
        actionTone="secondary"
        onAction={onClearCompleted}
      />
      <button className="secondary danger-text clear-all-tasks" onClick={onClearAll}>清除全部任务</button>
      <ApprovalStats refreshKey={withChildren(tasks).map(task=>`${task.id}:${task.review_status}`).join('|')} />
      <button className="secondary" onClick={async () => {
        setVideoError('');
        try {
          const desktop = desktopBridge();
          if (!desktop?.openReviewFolder) throw Error('请在新版 FlowCut 桌面程序中打开待检查文件夹');
          await desktop.openReviewFolder();
        } catch (error) { setVideoError(error instanceof Error ? error.message : '文件夹打开失败'); }
      }}>打开待检查文件夹</button>
      {videoError && <div role="alert" className="form-error">{videoError}</div>}
      {listError && <div role="alert" className="form-error">{listError}</div>}
      <div className="task-toolbar">
        <div role="group" aria-label="筛选任务">
          {[["all", "全部"], ["active", "进行中"], ["review", "待检查"], ["attention", "需处理"], ["completed", "已完成"]].map(([value, label]) => (
            <button key={value} className={filter === value ? "active" : ""} onClick={() => { setFilter(value); resetPages(); }} aria-pressed={filter === value}>{label}</button>
          ))}
        </div>
        <input aria-label="搜索任务" placeholder="搜索商品、商品 ID 或 TK 账号" value={query} onChange={(event) => { setQuery(event.target.value); resetPages(); }} />
      </div>
      <div className="table-panel tasks-table">
        <div className="table-head"><span>商品与账号</span><span>制作进度</span><span>当前状态</span><span>操作</span></div>
        {visibleTasks.map((task) => (
          <div className="table-row" key={task.id}>
            <button className="task-name task-product-summary" onClick={() => onPreview(task)}>
              <TaskProductThumbnail task={task} />
              <span className="task-product-copy">
              <b>{task.task_role==='fission'?task.title:task.product_name || task.title}</b>
              <small>
                {task.gem_name}
                {` · ${task.duration || DEFAULT_TASK_DURATION}秒 · ${
                  task.region || DEFAULT_TASK_REGION
                }`}
                {task.tiktok_account_name
                  ? ` · TK：${task.tiktok_account_name}`
                  : ""}
              </small>
              <small>{task.product_external_id ? `ID ${task.product_external_id} · ` : ""}{formatTime(task.created_at)}</small>
              </span>
            </button>
            <TaskChain task={task} compact />
            <div className="task-live-status"><span className={`status ${taskStatusClass(task)}`}>{taskStatusLabel(task)}</span><small>{progressText(task)}</small></div>
            <div className="row-actions">{task.download_path && task.review_status === 'approved' && <button onClick={() => void openVideo(task)}>查看视频</button>}<button onClick={() => onPreview(task)}>{failed(task) ? "查看 / 继续" : pendingReview(task) ? "审核" : "查看"}</button><button aria-label={task.task_role === "group" ? "删除整组" : "删除任务"} onClick={() => onDelete(task)}>×</button></div>
            {GROUP_ROLES.includes(task.task_role||'') && Boolean(task.children?.length) && <div className="task-batch-rows" role="list" aria-label="本组视频">
              {task.children!.map(child => <div className="task-batch-row" role="listitem" key={child.id}>
                <button className="task-name" onClick={() => onPreview(child)}><b>{task.task_role==='fission'?(child.product_name||child.title):clipLabel(child)}</b><small>{task.task_role==='fission'?`商品 ID：${child.product_external_id}`:`${child.duration || task.duration} 秒`}</small></button>
                <div className="task-live-status"><span className={`status ${taskStatusClass(child)}`}>{taskStatusLabel(child)}</span><small>{progressText(child)}</small></div>
                <div className="row-actions">{child.download_path && child.review_status === 'approved' && <button onClick={() => void openVideo(child)}>查看视频</button>}<button onClick={() => onPreview(child)}>{failed(child) ? "查看 / 继续" : pendingReview(child) ? "审核" : "查看"}</button><button aria-label={`删除${clipLabel(child)}`} onClick={() => onDelete(child)}>×</button></div>
              </div>)}
            </div>}
          </div>
        ))}
        {!loading && !visibleTasks.length && (filter !== 'all' || query ? <EmptyState icon="↗" title="没有匹配的任务" text="换一个筛选条件或搜索词。" /> : <EmptyState icon="↗" title="任务队列为空" text="从创作中心选择商品和 Gem 后启动第一条任务。" />)}
      </div>
      <p aria-live="polite">已加载 {visibleTasks.length} 条任务{loading ? '，正在加载…' : ''}</p>
      {hasMore && <button className="secondary" disabled={loading} onClick={loadMore}>{loading ? '加载中…' : '加载更多'}</button>}
    </div>
  );
}

export function TaskProductThumbnail({ task }: { task: Task }) {
  const imageKey = task.product_image_key || "";
  const [failedKey, setFailedKey] = useState<string | null>(null);
  return <span className="task-product-thumbnail">
    {imageKey && failedKey !== imageKey ? <img
      src={`/api/media?key=${encodeURIComponent(imageKey)}`}
      alt={`${task.product_name || task.title} 商品图片`}
      width={56} height={56} loading="lazy" decoding="async"
      onError={() => setFailedKey(imageKey)}
    /> : <span className="task-product-placeholder">{imageKey ? "图片失效" : "暂无图片"}</span>}
  </span>;
}
