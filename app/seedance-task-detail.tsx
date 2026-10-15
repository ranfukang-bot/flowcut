"use client";
import { useState } from 'react';

type Detail = { activity?: string; logs?: Array<{ time: number; level: string; message: string }> };
export function SeedanceTaskDetail({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [message, setMessage] = useState('');
  async function read() {
    const bridge = (window as unknown as { flowcutDesktop?: { seedanceTaskDetail?: (id: string) => Promise<Detail> } }).flowcutDesktop;
    if (!bridge?.seedanceTaskDetail) { setMessage('请在桌面程序中查看执行日志'); return; }
    setMessage('读取中…');
    try { setDetail(await bridge.seedanceTaskDetail(taskId)); setMessage(''); }
    catch (error) { setMessage(error instanceof Error ? error.message : '读取失败'); }
  }
  return <div>
    <button type="button" className="secondary" onClick={() => void read()}>读取 Seedance 执行日志</button>
    {message && <p role="status">{message}</p>}
    {detail && <div><p>{detail.activity}</p><ol>{detail.logs?.map((entry, index) => <li key={index}>{new Date(entry.time).toLocaleString()} · {entry.message}</li>)}</ol></div>}
  </div>;
}
