"use client";

import { useEffect, useState } from 'react';
import { desktopBridge } from './studio-client';
import { PageIntro } from './studio-ui';

export function PublisherPage() {
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(async () => {
      if (!alive) return;
      const desktop = desktopBridge();
      if (!desktop?.publisherStart) throw new Error("请在 FlowCut 桌面应用中打开发布管理");
      setError("");
      const value = await desktop.publisherStart();
      if (alive) setOrigin(value.origin);
    }).catch(value => { if (alive) setError(value instanceof Error ? value.message : "发布管理启动失败"); });
    return () => { alive = false; };
  }, [attempt]);
  return <div className="page-body publisher-page">
    <PageIntro title="检查成片后，统一发布" text="在任务详情确认成片并送入发布目录。发布账号名称需与制作时的 TK 归档账号一致；核对浏览器环境和发布时间后，再启动自动发布。" />
    {error ? <div className="warning-box">{error}<button className="secondary" onClick={() => setAttempt(attempt + 1)}>重试连接</button></div> : origin ? <iframe className="publisher-frame" src={origin} title="FlowCut 发布管理" /> : <p>正在打开本机发布管理…</p>}
  </div>;
}
