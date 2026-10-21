"use client";

import { FormEvent, useState } from 'react';
import { confirmAction } from './confirm-action';
import { GeminiModelInfo } from './gemini-model-settings';
import { SeedanceTaskDetail } from './seedance-task-detail';
import { api } from './studio-client';
import type { ScriptPromptGroup, ScriptPipelineTask, Workspace } from './studio-types';
import { formatTime, PageIntro, EmptyState } from './studio-ui';
import { statusLabels } from './task-status';

export function parsePromptGroups(value: string): ScriptPromptGroup[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function ScriptPipelinePage({
  tasks,
  geminiAccounts,
  defaultGeminiAccountId,
  integrations,
  onReload,
  onNotice,
}: {
  tasks: ScriptPipelineTask[];
  geminiAccounts: Array<{ id: string; name: string; authenticated: boolean; busy?: boolean }>;
  defaultGeminiAccountId: string;
  integrations: Workspace["integrations"];
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [sourceScript, setSourceScript] = useState("");
  const [projectContext, setProjectContext] = useState(() =>
    typeof window === "undefined"
      ? ""
      : window.localStorage.getItem("flowcut-script-project-context") || ""
  );
  const [geminiAccountId, setGeminiAccountId] = useState(
    defaultGeminiAccountId || geminiAccounts.find((account) => account.authenticated)?.id || ""
  );
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string>("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sourceScript.trim().length < 30) return onNotice("请先粘贴完整剧本");
    if (!geminiAccountId) return onNotice("请选择一个已登录的 Gemini 网页账号");
    if (!integrations.gemini || integrations.geminiMode !== "web") {
      return onNotice("剧本提示词流水线需要在线的 Gemini 网页执行器");
    }
    setBusy(true);
    try {
      window.localStorage.setItem("flowcut-script-project-context", projectContext);
      await api("/api/script-pipeline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, sourceScript, projectContext, geminiAccountId }),
      });
      setTitle("");
      setSourceScript("");
      onNotice("剧本已加入流水线，Gemini 将自动完成改写、提取、分镜、合并和优化");
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建剧本任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(message);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      onNotice(message);
    }
  }

  function combinedPromptText(groups: ScriptPromptGroup[]) {
    return groups
      .map((group) => `【视频 ${group.index}｜${group.targetDuration}秒】\n${group.optimizedPrompt || group.rawPrompt}`)
      .join("\n\n====================\n\n");
  }

  function downloadPrompts(task: ScriptPipelineTask, groups: ScriptPromptGroup[]) {
    const blob = new Blob([combinedPromptText(groups)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${task.title.replace(/[\\/:*?"<>|]/g, "-") || "视频提示词"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice("全部提示词已下载为 TXT");
  }

  async function action(id: string, requestedAction: "retry" | "retry_optimization" | "delete") {
    try {
      let actionResult: { alreadyRunning?: boolean; alreadyCompleted?: boolean } | null = null;
      if (requestedAction === "delete") {
        if (!await confirmAction("确认删除这条剧本任务及全部中间结果？")) return;
        await api("/api/script-pipeline", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } else {
        actionResult = await api("/api/script-pipeline", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, action: requestedAction }),
        }) as { alreadyRunning?: boolean; alreadyCompleted?: boolean };
      }
      onNotice(
        actionResult?.alreadyCompleted
          ? "任务已经完成，正在刷新成品提示词"
          : actionResult?.alreadyRunning
            ? "Gem 优化已在后台自动运行，无需重复点击"
            : requestedAction === "retry"
          ? "已保留成功结果，从失败步骤继续"
          : requestedAction === "retry_optimization"
            ? "已保留前四步，只重新执行 Gem 优化"
            : "剧本任务已删除"
      );
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <div className="page-body script-page">
      <PageIntro
        title="全自动剧本提示词"
        text="粘贴一集剧本，自动完成格式化改写、角色场景提取、完整分镜、25秒内组合，再按 Seedance 2.5 官方写法优化为可复制提示词。"
      />
      <form className="script-builder" onSubmit={submit}>
        <div className="script-builder-head">
          <div><span className="step-kicker">SCRIPT TO PROMPT</span><h3>把剧本直接变成视频提示词</h3><p>只生成提示词；生图和生视频仍由你手动完成。</p></div>
          <div className="locked-gem-card"><span>内置 Gem · 已锁定</span><b>Seedance 2.5｜官方写法视频提示词工程师</b><small>单组原始分镜≤25秒，超过20秒自动压到20秒且不拆段</small></div>
        </div>
        <div className="script-input-grid">
          <label className="script-source"><span>本集原始剧本</span><textarea value={sourceScript} onChange={(event) => setSourceScript(event.target.value)} placeholder="在这里粘贴小说原文、短剧剧本或广告脚本……" /></label>
          <div className="script-side-fields">
            <label><span>任务名称 <small>选填</small></span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="默认取剧本第一行" /></label>
            <label><span>Gemini 网页账号</span><select value={geminiAccountId} onChange={(event) => setGeminiAccountId(event.target.value)}><option value="">请选择已登录账号</option>{geminiAccounts.map((account) => <option key={account.id} value={account.id} disabled={!account.authenticated}>{account.name}{account.authenticated ? account.busy ? "（忙碌）" : "" : "（未登录）"}</option>)}</select></label>
            <label className="project-context"><span>项目已有角色 / 场景 <small>选填，会在本机记住</small></span><textarea value={projectContext} onChange={(event) => setProjectContext(event.target.value)} placeholder="例如：已有角色零一、零二；已有场景房间@日间……用于跨集去重。" /></label>
          </div>
        </div>
        <div className="script-pipeline-preview">
          {["剧本改写", "角色场景", "完整分镜", "≤25秒组合", "Gem优化"].map((label, index) => <div key={label}><span>{index + 1}</span><b>{label}</b></div>)}
          <button className="primary" type="submit" disabled={busy}>{busy ? "正在加入队列…" : "开始全自动生成 ↗"}</button>
        </div>
      </form>

      <section className="script-task-section">
        <div className="section-title"><div><span className="eyebrow">SCRIPT RUNS</span><h3>剧本任务</h3></div><span>{tasks.length} 条</span></div>
        {!tasks.length ? (
          <EmptyState icon="文" title="还没有剧本任务" text="粘贴一集剧本，系统会把最终可复制的视频提示词送到这里。" />
        ) : tasks.map((task) => {
          const isExpanded = expanded === task.id;
          const optimizedGroups = parsePromptGroups(task.optimized_groups_json);
          const rawGroups = parsePromptGroups(task.raw_groups_json);
          const hasFinalPrompts = optimizedGroups.length > 0;
          const stages = [
            { label: "剧本改写", statuses: ["rewriting"] },
            { label: "角色场景", statuses: ["extracting"] },
            { label: "完整分镜", statuses: ["storyboarding"] },
            { label: "组合", statuses: ["grouping"] },
            { label: "Gem优化", statuses: ["optimization_queued", "optimizing"] },
          ];
          const activeIndex = task.status === "rewrite_queued" ? -1 : task.status === "completed" ? stages.length : stages.findIndex((stage) => stage.statuses.includes(task.status));
          return (
            <article className="script-task-card" key={task.id}>
              <button type="button" className="script-task-summary" onClick={() => setExpanded(isExpanded ? "" : task.id)}>
                <div><b>{task.title}</b><span>{formatTime(task.created_at)} · {hasFinalPrompts ? `${optimizedGroups.length} 条最终提示词` : statusLabels[task.status] || task.status}</span></div>
                <div className="remix-progress"><i style={{ width: `${task.progress}%` }} /></div>
                <span className={`status ${task.status}`}>{statusLabels[task.status] || task.status}</span><em>{isExpanded ? "收起" : "详情"}</em>
              </button>
              <div className="script-stage-chain">
                {stages.map((stage, index) => <div className={activeIndex > index ? "done" : activeIndex === index ? "active" : "waiting"} key={stage.label}><span>{activeIndex > index ? "✓" : index + 1}</span><b>{stage.label}</b></div>)}
              </div>
              {task.error && <div className="warning-box">{task.error}</div>}
              {!hasFinalPrompts && rawGroups.length > 0 && ["optimization_queued", "optimizing"].includes(task.status) && (
                <div className="optimization-resume">
                  <span>前四步已保存，Gem 正在后台自动优化；完成后本页会自动显示并提供复制按钮。</span>
                  <b>{task.status === "optimization_queued" ? "自动排队中" : `处理中 ${task.progress}%`}</b>
                </div>
              )}
              {hasFinalPrompts && (
                <div className="final-prompt-list featured">
                  <div className="final-prompt-toolbar">
                    <div><span>READY TO COPY</span><h4>最终可复制提示词 · {optimizedGroups.length} 条</h4></div>
                    <div>
                      <button type="button" onClick={() => downloadPrompts(task, optimizedGroups)}>下载 TXT</button>
                      <button className="copy-primary" type="button" onClick={() => copyText(combinedPromptText(optimizedGroups), "全部提示词已复制")}>复制全部</button>
                    </div>
                  </div>
                  {optimizedGroups.map((group) => (
                    <article key={group.index}>
                      <div>
                        <b>视频 {group.index}</b>
                        <span>分镜 {group.shotNumbers?.join("、") || "—"} · 原始 {group.rawDuration}秒 → 输出 {group.targetDuration}秒</span>
                        <button className="copy-primary" type="button" onClick={() => copyText(group.optimizedPrompt || group.rawPrompt, `视频 ${group.index} 提示词已复制`)}>复制本条</button>
                      </div>
                      <textarea readOnly value={group.optimizedPrompt || group.rawPrompt} onFocus={(event) => event.currentTarget.select()} aria-label={`视频 ${group.index} 最终提示词`} />
                    </article>
                  ))}
                </div>
              )}
              {isExpanded && (
                <div className="script-task-detail">
                  <GeminiModelInfo value={task.gemini_model_info} />
                  <SeedanceTaskDetail taskId={task.id} />
                  <details><summary>① 格式化剧本</summary><pre>{task.rewritten_script || "等待 Gemini 改写……"}</pre></details>
                  <details><summary>② 角色与场景 JSON</summary><pre>{task.extraction_json || "等待提取……"}</pre></details>
                  <details><summary>③ 完整分镜 JSON</summary><pre>{task.storyboard_json || "等待拆分镜……"}</pre></details>
                  <details><summary>④ 自动组合的未优化提示词</summary><pre>{task.raw_groups_json || "等待按时长组合……"}</pre></details>
                  <div className="row-actions">{rawGroups.length > 0 && !hasFinalPrompts && task.status === "failed" ? <button type="button" onClick={() => action(task.id, "retry_optimization")}>继续 Gem 优化</button> : task.status === "failed" ? <button type="button" onClick={() => action(task.id, "retry")}>从失败步骤继续</button> : null}<button className="danger-text" type="button" onClick={() => action(task.id, "delete")}>删除</button></div>
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
