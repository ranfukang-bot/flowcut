"use client";
import { useEffect, useState } from 'react';
import { formatBackupBytes, type BackupStorage } from '../lib/backup-storage';
type Bridge = {
  backupState: () => Promise<BackupStorage>;
  backupNow: () => Promise<{ path: string }>;
  backupChooseDirectory: () => Promise<BackupStorage>;
  backupRestore: () => Promise<{ canceled?: boolean }>;
  onState?: (callback: (state: { backup?: BackupStorage }) => void) => () => void;
};
function bridge() { return (window as unknown as { flowcutDesktop?: Bridge }).flowcutDesktop; }
export function LocalBackups() {
  const [directory, setDirectory] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState<BackupStorage | null>(null);
  useEffect(() => {
    let active = true;
    const receive = (state: BackupStorage) => { if (active) { setDirectory(state.directory || ''); setStorage(state); } };
    const api = bridge();
    void api?.backupState?.().then(receive).catch(() => { if (active) setMessage('备份空间读取失败，请检查备份目录是否可访问'); });
    const unsubscribe = api?.onState?.(state => { if (state.backup) receive(state.backup); });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  async function run(action: 'backup' | 'directory' | 'restore') {
    const api = bridge();
    if (!api?.backupNow) { setMessage('请在 FlowCut 桌面程序中管理本机备份'); return; }
    setBusy(true); setMessage('处理中…');
    try {
      if (action === 'backup') { setMessage(`备份完成：${(await api.backupNow()).path}`); setStorage(await api.backupState()); }
      if (action === 'directory') { const state = await api.backupChooseDirectory(); setDirectory(state.directory || ''); setStorage(state); setMessage('备份目录已保存'); }
      if (action === 'restore') { const result = await api.backupRestore(); setMessage(result.canceled ? '已取消恢复' : '恢复完成，正在重启'); }
    } catch (error) { setMessage(error instanceof Error ? error.message : '备份操作失败'); }
    finally { setBusy(false); }
  }
  return <section className="connection-card">
    <h3>本机数据备份</h3>
    <p>启动 5 分钟后备份，之后每 24 小时备份一次，保留最近 7 份。</p>
    <p>目录：{directory || '文档\\FlowCut备份'}</p>
    {storage && <div aria-label="备份空间统计">
      <p>本份 ZIP：{storage.latest ? formatBackupBytes(storage.latest.zipBytes) : '尚无备份'}</p>
      <p>保留 {storage.backupCount} 份合计：{formatBackupBytes(storage.totalBytes)}</p>
      <p>媒体对象：{storage.latest?.mediaCount ?? '未记录'} 个</p>
    </div>}
    {storage?.overLimit && <div role="alert" className="warning-box strong-warning">备份合计已超过 5 GB，请留意磁盘可用空间。可将后续备份保存到其他位置。</div>}
    <p>包含 Gem、商品、任务、媒体和本机配置密钥，请妥善保存。平台登录 Cookie 不包含在备份中。恢复前请暂停两个队列并停止发布管理。</p>
    <button type="button" className="primary" disabled={busy} onClick={() => void run('backup')}>立即备份</button>{' '}
    <button type="button" className="secondary" disabled={busy} onClick={() => void run('directory')}>修改备份位置</button>{' '}
    <button type="button" className="secondary" disabled={busy} onClick={() => void run('restore')}>从备份恢复</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
