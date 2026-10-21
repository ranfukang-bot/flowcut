"use client";

import { FormEvent, useState } from 'react';
import { api } from './studio-client';
import type { Task, Schedule } from './studio-types';
import { formatTime, PageIntro, ModalHead, EmptyState } from './studio-ui';

export function CalendarPage({
  schedules,
  tasks,
  onSaved,
  onDelete,
}: {
  schedules: Schedule[];
  tasks: Task[];
  onSaved: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      setOpen(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-body">
      <PageIntro title="发布日历" text="把已经生成的成片安排到账号与时间。正式发布执行器接入后会自动消费队列。" action="添加排期" onAction={() => setOpen(true)} />
      <div className="calendar-layout">
        <div className="calendar-panel">
          <div className="calendar-title"><button>‹</button><h3>发布计划</h3><button>›</button></div>
          {schedules.length ? schedules.map((item) => (
            <article className="schedule-row" key={item.id}>
              <div className="date-tile"><b>{new Date(item.scheduled_at).getDate()}</b><span>{new Intl.DateTimeFormat("zh-CN", { month: "short" }).format(new Date(item.scheduled_at))}</span></div>
              <div><h4>{item.task_title || "视频发布任务"}</h4><p>{item.account_name} · {formatTime(item.scheduled_at)}</p><small>{item.caption || "无发布文案"}</small></div>
              <span className="status scheduled">已排期</span>
              <button className="delete-round" onClick={() => onDelete(item.id)}>×</button>
            </article>
          )) : <EmptyState icon="◫" title="还没有发布计划" text="生成提示词或成片后，可先在这里安排账号和时间。" action="添加排期" onAction={() => setOpen(true)} />}
        </div>
        <aside className="calendar-note">
          <span>发布策略</span>
          <h3>先审核，再自动发</h3>
          <p>自然账号发布需要遵守 TikTok 的用户确认要求。工作台保留预览与排期确认，接入广告 API 后可扩展到广告素材自动投放。</p>
          <ul><li>发布前预览成片</li><li>账号与隐私设置确认</li><li>失败状态自动回传</li></ul>
        </aside>
      </div>
      {open && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <form className="modal small-modal" onSubmit={submit}>
            <ModalHead title="添加发布排期" text="先保存计划，连接 TikTok 执行器后即可自动消费。" onClose={() => setOpen(false)} />
            <div className="form-body">
              <label>视频任务<select name="taskId" required>{tasks.map((task) => <option value={task.id} key={task.id}>{task.product_name || task.title}</option>)}</select></label>
              <label>TikTok 账号<input name="accountName" placeholder="@brand_indonesia" required /></label>
              <label>发布时间<input name="scheduledAt" type="datetime-local" required /></label>
              <label>发布文案<textarea name="caption" rows={4} placeholder="自然口语文案与标签，可在发布前修改" /></label>
            </div>
            <div className="modal-foot"><button type="button" className="secondary" onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存排期"}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
