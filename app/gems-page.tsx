"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { exportAllGems } from './export-gems';
import { api, desktopBridge } from './studio-client';
import type { Gem } from './studio-types';
import { formatTime, PageIntro, ModalHead } from './studio-ui';

export function GemsPage({
  gems,
  onAdd,
  onEdit,
  onDelete,
}: {
  gems: Gem[];
  onAdd: () => void;
  onEdit: (gem: Gem) => void;
  onDelete: (id: string) => void;
}) {
  const [instructions,setInstructions]=useState<Gem|null>(null);
  const [webGem, setWebGem] = useState<Gem | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  return (
    <div className="page-body">
      <PageIntro title="Gem 模板中心" text="商品图任务首次使用时，会在执行账号内自动创建并保存真正的 Gem；之后只发送图片和本次要求。也可手动绑定已有 Gem 链接。" action="新建 Gem" onAction={onAdd} />
      <button type="button" className="secondary" onClick={() => void exportAllGems(gems).then(result => setExportMessage(result && typeof result === 'object' && 'directory' in result ? `Gem 已导出：${result.directory}` : '导出已处理')).catch(error => setExportMessage(error instanceof Error ? error.message : '导出失败'))}>导出全部 Gem</button>
      {exportMessage && <p role="status">{exportMessage}</p>}
      {instructions&&<div className="modal-backdrop"><div className="modal wide-modal" role="dialog" aria-label="锁定 Gem 指令"><ModalHead title={instructions.name} text="内置 Gem · 指令已锁定" onClose={()=>setInstructions(null)} /><pre className="locked-gem-instructions">{instructions.content}</pre></div></div>}
      {webGem && <WebGemModal gem={webGem} onClose={() => setWebGem(null)} />}
      <div className="gem-grid">
        {gems.map((gem, index) => (
          <article className="gem-card" key={gem.id}>
            <div className={`gem-orb orb-${index % 4}`}>◇</div>
            <div className="gem-tags">
              {gem.locked?<span>内置 · 已锁定</span>:gem.is_default ? <span>内置模板</span> : <span>自定义</span>}
            </div>
            <h3>{gem.name}</h3>
            <p>{gem.description || "未填写模板简介"}</p>
            <div className="gem-meta">
              <span>{gem.content.length.toLocaleString()} 字指令</span>
              <span>{gem.locked?"每个账号首次使用时自动创建":`更新于 ${formatTime(gem.updated_at)}`}</span>
            </div>
            <div className="gem-actions">
              {gem.locked?<button className="secondary" onClick={()=>setInstructions(gem)}>查看指令</button>:<button className="secondary" onClick={() => onEdit(gem)}>编辑指令</button>}
              <button className="secondary" onClick={() => setWebGem(gem)}>网页 Gem</button>
              {!gem.locked&&<button className="danger-text" onClick={() => onDelete(gem.id)}>删除</button>}
            </div>
          </article>
        ))}
        <button className="gem-add-card" onClick={onAdd}><span>＋</span><b>创建新的 Gem</b><small>从身份、规则和输出框架开始</small></button>
      </div>
    </div>
  );
}

export function WebGemModal({ gem, onClose }: { gem: Gem; onClose: () => void }) {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string; authenticated: boolean; binding: { url?: string; status: string; name?: string } | null }>>([]);
  const [accountId, setAccountId] = useState("");
  const [urlDraft, setUrlDraft] = useState<{ accountId: string; source: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = accounts.find(a => a.id === accountId);
  const bindingUrl = current?.binding?.url || "";
  const url = urlDraft?.accountId === accountId && urlDraft.source === bindingUrl ? urlDraft.value : bindingUrl;
  function setUrl(value: string) { setUrlDraft({ accountId, source: bindingUrl, value }); }
  const readAccounts = useCallback(async () => {
    const desktop = desktopBridge();
    if (!desktop?.listGemBindings) throw new Error("请使用支持网页 Gem 的新版 FlowCut 桌面端");
    return desktop.listGemBindings(gem);
  }, [gem]);
  const applyAccounts = useCallback((rows: typeof accounts) => {
    setAccounts(rows);
    setAccountId(id => id || rows[0]?.id || "");
  }, []);
  useEffect(() => {
    let alive = true;
    void readAccounts().then(rows => { if (alive) applyAccounts(rows); }).catch(e => { if (alive) setMessage(String(e.message || e)); });
    return () => { alive = false; };
  }, [readAccounts, applyAccounts]);
  async function act(action: "create" | "bind" | "open") {
    if (busy || !accountId) return;
    setBusy(true); setMessage("");
    try {
      const desktop = desktopBridge();
      if (!desktop?.configureGem) throw new Error("请更新 FlowCut 桌面端");
      await desktop.configureGem({ accountId, gem, action, url });
      applyAccounts(await readAccounts());
      setMessage(action === "open" ? "已打开这个账号的 Gem 管理页。手动保存后，将 /gem/ 开头的对话链接复制回来。" : action === "bind" ? "链接已保存。请确保此账号能访问该 Gem，且指令与当前模板一致。" : "Gem 已创建并保存，后续任务会直接进入此链接。");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><div className="modal wide-modal" role="dialog" aria-modal="true" aria-label="网页 Gem">
    <ModalHead title={`网页 Gem · ${gem.name}`} text="按 Gemini 账号分别绑定。修改本地指令后会建立新版本，不会覆盖原 Gem。" onClose={() => { if (!busy) onClose(); }} />
    <div className="form-body">
      <p>正常任务会自动完成首次创建，无需预先操作。手动设置前，请暂停 Gemini 队列并等待当前任务收尾。</p>
      <label>Gemini 账号<select value={accountId} disabled={busy} onChange={e => { setAccountId(e.target.value); setUrlDraft(null); }}><option value="">请选择账号</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.authenticated ? "" : "（未登录）"}</option>)}</select></label>
      <p>{current?.binding?.status === "ready" ? "此版本已绑定" : current?.binding?.status === "saving" ? `上次保存结果待核对：${current.binding.name}。请到该账号的 Gem 管理页找回链接，不会重复创建。` : "此版本尚未创建"}</p>
      <button className="primary" disabled={busy || !accountId} onClick={() => void act("create")}>{busy ? "处理中…" : "自动创建并保存 / 检查已有绑定"}</button>
      <button className="secondary" disabled={busy || !accountId} onClick={() => void act("open")}>打开该账号的 Gem 管理页</button>
      <label>备用：已有 Gem 对话链接<input value={url} disabled={busy} onChange={e => setUrl(e.target.value)} placeholder="https://gemini.google.com/gem/…" /></label>
      <button className="secondary" disabled={busy || !accountId || !url.trim()} onClick={() => void act("bind")}>保存此账号的链接</button>
      <p>只保存链接，不修改远端指令、不调整模型或扩展思考，也不更改分享权限。</p>
      {message && <div role="status" className="form-error">{message}</div>}
    </div>
    <div className="modal-foot"><button className="secondary" disabled={busy} onClick={onClose}>关闭</button></div>
  </div></div>;
}

export function GemModal({ gem, onClose, onSaved }: { gem: Gem | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(gem?.name || "");
  const [description, setDescription] = useState(gem?.description || "");
  const [content, setContent] = useState(gem?.content || "");
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { nameInput.current?.focus(); }, []);
  const close = () => { if (!busy) onClose(); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api("/api/gems", {
        method: gem ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: gem?.id, name, description, content }),
      });
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请重试；输入内容已保留");
    } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
      <form className="modal wide-modal" role="dialog" aria-modal="true" aria-label={gem ? "编辑 Gem 指令" : "创建新的 Gem"} onSubmit={submit}>
        <ModalHead title={gem ? "编辑 Gem 指令" : "创建新的 Gem"} text="把身份、成交结构、生成规格和固定输出格式写在同一个模板里。" onClose={close} />
        <div className="form-body">
          <div className="gem-form-head">
            <label>Gem 名称<input ref={nameInput} name="name" value={name} onChange={event => setName(event.target.value)} placeholder="例如：促销带货视频脚本智能体" required /></label>
          </div>
          <label>模板简介<input name="description" value={description} onChange={event => setDescription(event.target.value)} placeholder="说明这个 Gem 适合什么视频" /></label>
          <label className="instruction-field">完整 Gem 指令<textarea name="content" value={content} onChange={event => setContent(event.target.value)} placeholder="一、身份&#10;二、输出结构&#10;三、禁止事项…" required /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="modal-foot"><span>保存后，下一次任务即可选择这个 Gem。</span><button type="button" className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存 Gem"}</button></div>
      </form>
    </div>
  );
}
