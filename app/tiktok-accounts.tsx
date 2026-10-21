"use client";

import { FormEvent, useRef, useState } from 'react';
import { confirmAction } from './confirm-action';
import { desktopBridge } from './studio-client';
import type { TikTokAccount } from './studio-types';
import { ModalHead } from './studio-ui';

export function TikTokAccountModal({
  account,
  onClose,
  onSave,
}: {
  account?: TikTokAccount;
  onClose: () => void;
  onSave: (name: string, archiveDirectory: string) => Promise<void>;
}) {
  const [directory, setDirectory] = useState(account?.archive_directory || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) {
      setError("请输入 TK 账号名");
      return;
    }
    if (!directory && !account) { setError("请选择视频保存文件夹"); return; }
    setBusy(true);
    setError("");
    try {
      await onSave(name, directory);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存 TK 账号失败"
      );
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        !busy && event.target === event.currentTarget && onClose()
      }
    >
      <form className="modal small-modal" role="dialog" aria-modal="true" aria-label={account ? "修改 TK 归档账号" : "添加 TK 归档账号"} onSubmit={submit}>
        <ModalHead
          title={account ? "修改 TK 归档账号" : "添加 TK 归档账号"}
          text={account ? "仅影响之后新建的任务；已有任务保留原账号名及保存位置，不移动文件。" : "为这个归档名称选择实际保存文件夹，成片会直接下载到所选位置。"}
          onClose={() => { if (!busy) onClose(); }}
        />
        <div className="form-body">
          <label>
            归档名称（例如对应的 TK 账号）
            <input
              name="name"
              defaultValue={account?.name || ""}
              autoFocus
              maxLength={80}
              placeholder="例如：印尼店铺01"
              disabled={busy}
            />
          </label>
          <label>视频保存文件夹<input value={directory} readOnly placeholder="点击下方按钮选择文件夹" /></label>
          <button type="button" className="secondary" disabled={busy} onClick={async () => {
            try {
              const desktop = desktopBridge();
              if (!desktop?.chooseArchiveDirectory) throw new Error("请在 FlowCut 桌面应用中选择文件夹");
              const folder = await desktop.chooseArchiveDirectory();
              if (folder) { setDirectory(folder); setError(""); }
            } catch (reason) { setError(reason instanceof Error ? reason.message : "选择文件夹失败"); }
          }}>选择保存文件夹</button>
          <p className="account-folder-preview">直接保存到这个文件夹，不再额外添加账号子文件夹。</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : account ? "保存修改" : "添加并选择"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function TikTokAccountManager({ accounts, selected, onClose, onSelect, onAdd, onUpdate, onDelete }: {
  accounts: TikTokAccount[];
  selected: string;
  onClose: () => void;
  onSelect: (name: string) => void;
  onAdd: (name: string, directory: string) => Promise<void>;
  onUpdate: (account: TikTokAccount, name: string, directory: string) => Promise<void>;
  onDelete: (account: TikTokAccount) => Promise<void>;
}) {
  const [editor, setEditor] = useState<TikTokAccount | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deleting = useRef(false);
  async function remove(account: TikTokAccount) {
    if (deleting.current) return;
    deleting.current = true;
    setBusy(true); setError("");
    try {
      if (!await confirmAction(`删除 TK 归档账号“${account.name}”？只移除这条账号配置，不删除保存文件夹、图片、视频或历史任务。正在进行的任务仍按原来的保存位置继续。`)) return;
      await onDelete(account);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除账号失败"); }
    finally { deleting.current = false; setBusy(false); }
  }
  if (editor) return <TikTokAccountModal
    key={editor === "new" ? "new" : editor.id}
    account={editor === "new" ? undefined : editor}
    onClose={() => setEditor(null)}
    onSave={async (name, directory) => {
      if (editor === "new") await onAdd(name, directory);
      else await onUpdate(editor, name, directory);
      setEditor(null);
    }}
  />;
  return <div className="modal-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section className="modal tk-account-manager" role="dialog" aria-modal="true" aria-label="TK 账号管理">
      <ModalHead title="TK 账号管理" text="管理创作中心的归档账号与保存文件夹，不是删除 TikTok 平台账号。" onClose={() => { if (!busy) onClose(); }} />
      <div className="form-body">
        <div className="tk-account-manager-toolbar"><span>共 {accounts.length} 个账号</span><button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); setEditor("new"); }}>＋ 添加账号</button></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {accounts.length === 0 ? <p className="tk-account-empty">还没有 TK 归档账号，点击上方“添加账号”创建。</p> : <div className="tk-account-list">
          {accounts.map(account => <article key={account.id} aria-label={account.name}>
            <div className="tk-account-info"><strong>{account.name}</strong>{account.name === selected && <span className="tk-account-current">当前选用</span>}<p>{account.archive_directory || "未指定文件夹：使用默认下载目录 / 账号名"}</p></div>
            <div className="tk-account-actions">
              <button type="button" className="secondary" disabled={busy || account.name === selected} onClick={() => onSelect(account.name)}>选用</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); setEditor(account); }}>修改</button>
              <button type="button" className="secondary danger-text" disabled={busy} onClick={() => void remove(account)}>删除</button>
            </div>
          </article>)}
        </div>}
        <p className="account-folder-preview">修改和删除仅影响后续新任务。已有任务保留原账号名及保存位置，磁盘文件不会被删除或移动。</p>
      </div>
      <div className="modal-foot"><button type="button" className="secondary" disabled={busy} onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}
