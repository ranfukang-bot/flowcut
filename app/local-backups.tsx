"use client";
import { useEffect, useState } from 'react';
type Bridge = {
  backupState: () => Promise<{ directory: string }>;
  backupNow: () => Promise<{ path: string }>;
  backupChooseDirectory: () => Promise<{ directory: string }>;
  backupRestore: () => Promise<{ canceled?: boolean }>;
};
function bridge() { return (window as unknown as { flowcutDesktop?: Bridge }).flowcutDesktop; }
export function LocalBackups() {
  const [directory, setDirectory] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void bridge()?.backupState?.().then(state => { if (active) setDirectory(state.directory); }).catch(() => {}); return () => { active = false; }; }, []);
  async function run(action: 'backup' | 'directory' | 'restore') {
    const api = bridge();
    if (!api?.backupNow) { setMessage('请在 FlowCut 桌面程序中管理本机备份'); return; }
    setBusy(true); setMessage('处理中…');
    try {
      if (action === 'backup') setMessage(`备份完成：${(await api.backupNow()).path}`);
      if (action === 'directory') { setDirectory((await api.backupChooseDirectory()).directory); setMessage('备份目录已保存'); }
      if (action === 'restore') { const result = await api.backupRestore(); setMessage(result.canceled ? '已取消恢复' : '恢复完成，正在重启'); }
    } catch (error) { setMessage(error instanceof Error ? error.message : '备份操作失败'); }
    finally { setBusy(false); }
  }
  return <section className="connection-card">
    <h3>本机数据备份</h3>
    <p>启动 5 分钟后备份，之后每 24 小时备份一次，保留最近 7 份。</p>
    <p>目录：{directory || '文档\\FlowCut备份'}</p>
    <p>包含 Gem、商品、任务、媒体和本机配置密钥，请妥善保存。平台登录 Cookie 不包含在备份中。恢复前请暂停两个队列并停止发布管理。</p>
    <button type="button" className="primary" disabled={busy} onClick={() => void run('backup')}>立即备份</button>{' '}
    <button type="button" className="secondary" disabled={busy} onClick={() => void run('directory')}>修改备份位置</button>{' '}
    <button type="button" className="secondary" disabled={busy} onClick={() => void run('restore')}>从备份恢复</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
