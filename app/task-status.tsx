"use client";

import type { Task } from './studio-types';
import { APPROVED_REVIEW_STATUSES, PROMPT_ROUND_STATUSES, TASK_STATUS_LABELS, VARIANT_ROUND_STATUSES, VIDEO_DONE_STATUSES, VIDEO_FAILED_STATUSES } from '../lib/task-statuses';

export type TaskStage = {
  number: string;
  label: string;
  detail: string;
  state: "done" | "active" | "waiting" | "blocked";
};

// Clips and concatenated videos are listed inside their group.
export function withChildren(tasks: Task[]) {
  return tasks.flatMap(task => [task, ...(task.children || [])]);
}

export function taskStages(task: Task): TaskStage[] {
  if(task.task_role==='remix') {
    const analyzed=Boolean(task.remix_script)||['remix_adapting','remix_segmented','remix_finishing','remix_done'].includes(task.status),ready=['remix_segmented','remix_finishing','remix_done'].includes(task.status);
    return [
      {number:'1',label:'对标视频',detail:`${task.remix_video_seconds || '未知'} 秒`,state:'done'},
      {number:'2',label:'拆解与换品',detail:taskStatusLabel(task),state:ready?'done':task.status==='failed'?'blocked':'active'},
      {number:'3',label:'分段视频',detail:`${task.batch_size || '待拆解'} 段`,state:ready?'done':analyzed?'active':'waiting'},
      {number:'4',label:'检查并拼接',detail:task.status==='remix_done'?'已放入 TK 目录':'逐段检查后整组放行',state:task.status==='remix_done'?'done':ready?'active':'waiting'},
    ];
  }
  if(task.task_role==='fission'){
    const ready=task.status==='fission_ready',children=task.children||[];
    return [
      {number:'1',label:'商品批次',detail:`${task.batch_size||children.length} 个不同商品`,state:'done'},
      {number:'2',label:'共用母版',detail:ready?'母版已保存':taskStatusLabel(task),state:ready?'done':task.status==='failed'?'blocked':'active'},
      {number:'3',label:'逐品变体',detail:'每个商品使用自己的图片',state:ready?'active':'waiting'},
      {number:'4',label:'逐品视频',detail:`${children.filter(c=>VIDEO_DONE_STATUSES.includes(c.status)).length}/${children.length} 条就绪`,state:'waiting'},
    ];
  }
  if (task.task_role === "concat") {
    const done = VIDEO_DONE_STATUSES.includes(task.status);
    return [
      { number: "1", label: "选择视频", detail: `${task.batch_size || "多"} 条视频`, state: "done" },
      { number: "2", label: "本机拼接", detail: done ? "已拼接" : task.status === "concat_running" ? "正在拼接" : "未完成", state: done ? "done" : task.status === "concat_running" ? "active" : "blocked" },
      { number: "3", label: "检查", detail: done ? taskStatusLabel(task) : "等待拼接", state: done && APPROVED_REVIEW_STATUSES.includes(task.review_status || '') ? "done" : done ? "active" : "waiting" },
    ];
  }
  if (task.task_role === "group" && !PROMPT_ROUND_STATUSES.includes(task.status)) {
    const clips = (task.children || []).filter(child => child.task_role === "clip").length;
    const variantWaiting = VARIANT_ROUND_STATUSES.includes(task.status);
    return [
      { number: "1", label: "商品图片", detail: `${Math.max(Number(task.image_count || 0), 1)} 张参考图已保存`, state: "done" },
      { number: "2", label: task.variant_mode ? "母版提示词" : "Gemini 识别与提示词", detail: "已生成", state: "done" },
      { number: "3", label: task.variant_mode ? "变体 Gem" : "按代码块拆分",
        detail: task.status === "split_done" ? `已拆成 ${task.batch_size || clips} 条视频` : task.status === "failed" ? "未完成，可查看原因" : variantWaiting ? "正在生成变体" : "等待",
        state: task.status === "split_done" ? "done" : task.status === "failed" ? "blocked" : "active" },
      { number: "4", label: "视频", detail: task.status === "split_done" ? "见本组每条视频" : "等待拆分", state: task.status === "split_done" ? "done" : "waiting" },
    ];
  }
  const isDemo = task.provider === "demo-engine";
  const hasRealPrompt = Boolean(task.has_prompt ?? task.prompt?.trim()) && !isDemo;
  const seedanceStarted = [
    "video_queued",
    "video_generating",
    "video_ready",
    "scheduled",
  ].includes(task.status);
  const seedanceFailed =
    task.status === "seedance_blocked" ||
    (task.status === "failed" && Boolean(task.provider_job_id));
  const geminiFailed =
    isDemo ||
    (task.status === "failed" && !task.provider_job_id && !hasRealPrompt);

  return [
    {
      number: "1",
      label: "商品图片",
      detail: `${Math.max(Number(task.image_count || 0), 1)} 张参考图已保存`,
      state: "done",
    },
    {
      number: "2",
      label: "Gemini 识别与提示词",
      detail: isDemo
        ? "旧版演示结果，未识别商品图"
        : hasRealPrompt
          ? "真实 Gemini 结果已生成"
          : geminiFailed
            ? "Gemini 调用失败"
            : "等待 Gemini",
      state: isDemo || geminiFailed ? "blocked" : hasRealPrompt ? "done" : "active",
    },
    {
      number: "3",
      label: "Seedance 2.0",
      detail: seedanceFailed
        ? "提交失败，可在此重试"
        : seedanceStarted
          ? task.status === "video_ready" || task.status === "scheduled"
            ? "Seedance 已完成"
            : task.status === "video_queued"
              ? "已进入本机队列"
              : "正在生成视频"
          : hasRealPrompt
            ? "等待提交"
            : "等待上一步",
      state: seedanceFailed
        ? "blocked"
        : seedanceStarted
          ? task.status === "video_ready" || task.status === "scheduled"
            ? "done"
            : "active"
          : "waiting",
    },
    {
      number: "4",
      label: "成片",
      detail:
        task.status === "video_ready" || task.status === "scheduled"
          ? "视频已生成"
          : task.status === "failed" && Boolean(task.provider_job_id)
            ? "生成失败"
            : "等待 Seedance 完成",
      state:
        task.status === "video_ready" || task.status === "scheduled"
          ? "done"
          : task.status === "failed" && Boolean(task.provider_job_id)
            ? "blocked"
            : "waiting",
    },
  ];
}

export function TaskChain({ task, compact = false }: { task: Task; compact?: boolean }) {
  return (
    <div className={compact ? "task-chain compact" : "task-chain"}>
      {taskStages(task).map((stage) => (
        <div className={`task-stage ${stage.state}`} key={stage.number}>
          <span>{stage.state === "done" ? "✓" : stage.number}</span>
          <div>
            <b>{stage.label}</b>
            {!compact && <small>{stage.detail}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

// 任务队列里的一行进度：四格小条 + 当前这一步的说明。
export function StageBar({ task }: { task: Task }) {
  const stages = taskStages(task);
  const current = stages.find(stage => stage.state === "blocked") || stages.find(stage => stage.state === "active")
    || stages.find(stage => stage.state === "waiting") || stages[stages.length - 1];
  const blocked = current.state === "blocked";
  const summary = stages.map(stage => `${stage.label}：${stage.state === "done" ? "完成" : stage.state === "active" ? "进行中" : stage.state === "blocked" ? "卡住" : "等待"}`).join("，");
  return <div className={blocked ? "stage-bar blocked" : "stage-bar"}>
    <div role="img" aria-label={summary} title={summary}>{stages.map(stage => <span key={stage.number} className={stage.state} />)}</div>
    <small>{current.label} · {current.detail}</small>
  </div>;
}

// Kept apart from taskStatusLabel so a group's label can count its clips.
export function clipAwaitingReview(task: Task): boolean {
  return taskStatusLabel(task) === '待检查';
}

export function taskStatusClass(task: Task) {
  if(task.task_role==='remix') {
    if(task.status==='remix_done')return 'video_ready';
    if(task.status==='remix_segmented')return 'review_pending';
    if(task.status==='remix_finishing')return 'concat_running';
    if(task.status.startsWith('remix_'))return 'prompt_generating';
  }
  if(task.task_role==='fission'&&task.status==='fission_ready'){
    const children=task.children||[];
    if(children.some(clipAwaitingReview))return 'review_pending';
    return children.some(c=>VIDEO_FAILED_STATUSES.includes(c.status))?'failed':children.every(c=>VIDEO_DONE_STATUSES.includes(c.status))?'video_ready':'video_generating';
  }
  if (task.task_role === "group" && task.status === "split_done") {
    const children = task.children || [];
    if (children.some(clipAwaitingReview)) return 'review_pending';
    if (children.some(child => VIDEO_FAILED_STATUSES.includes(child.status))) return 'failed';
    return children.length && children.every(child => VIDEO_DONE_STATUSES.includes(child.status)) ? 'video_ready' : 'video_generating';
  }
  return taskStatusLabel(task) === '待检查' ? 'review_pending' : task.status;
}

export function taskStatusLabel(task: Task) {
  if(task.task_role==='fission'&&task.status==='fission_ready'){
    const children=task.children||[],ready=children.filter(c=>VIDEO_DONE_STATUSES.includes(c.status)).length,failed=children.filter(c=>VIDEO_FAILED_STATUSES.includes(c.status)).length;
    return `${children.length} 个商品 · ${ready} 条视频就绪${failed?` · ${failed} 条需处理`:''}`;
  }
  if (task.provider === "demo-engine") return "需重新用 Gemini 识别";
  if (task.task_role === "group" && task.status === "split_done") {
    const children = task.children || [];
    const videos = children.filter(child => child.task_role !== "concat").length;
    const joined = children.length - videos;
    const review = children.filter(clipAwaitingReview).length;
    const failed = children.filter(child => VIDEO_FAILED_STATUSES.includes(child.status)).length;
    return [videos ? `${videos} 条视频` : "", joined ? `${joined} 条拼接成片` : "", review ? `${review} 条待检查` : "", failed ? `${failed} 条需处理` : ""]
      .filter(Boolean).join(" · ") || "本组已清空";
  }
  if (VIDEO_DONE_STATUSES.includes(task.status)) {
    if (task.review_status === 'merging') return '正在拼接';
    if (task.review_status === 'merged') return '已用于拼接';
    if (task.review_status === 'replaced') return '已重做';
    if (task.review_status === 'approved') return '已通过';
    if (task.review_status === 'approving') return '放行待完成';
    if (task.review_status === 'deleting') return '删除待完成';
    return task.download_path ? '待检查' : '成片下载中';
  }
  return TASK_STATUS_LABELS[task.status] || task.status;
}
