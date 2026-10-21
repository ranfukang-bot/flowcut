"use client";

import { useState } from 'react';
import { confirmAction } from './confirm-action';
import { desktopBridge } from './studio-client';
import type { SeedanceDesktopState } from './studio-types';

export function SeedanceQuotaSummary({ state, onUpdated, onError }: {
  state: SeedanceDesktopState;
  onUpdated: (state: SeedanceDesktopState) => void;
  onError: (message: string) => void;
}) {
  const accounts = state.accountState.items.filter(account => account.enabled && account.preferredModel !== "2000004");
  if (!accounts.length) return null;
  const usingStandard = accounts.some(account => account.authenticated && account.effectiveModel === "2000004");
  const pendingChoice = accounts.some(account => account.needsModelDecision);
  const allExhausted = Boolean(state.accountState.allFastExhausted);
  // 平时只有一行；Fast 全部用完、或已改用 2.0 时才多一句说明。
  const message = usingStandard ? "已按你的确认改用 2.0，跨天后重新优先 Fast。" : allExhausted
    ? pendingChoice ? "所有已启用 Fast 账号今日均已上限。请在下方选择改用 2.0，或等待 Fast 恢复。" : "已选择等待 Fast 恢复；如需改用 2.0，可在账号与设置中重新选择。"
    : "";
  const tone = allExhausted && !usingStandard ? "bad" : usingStandard || accounts.some(account => account.fastExhaustedToday) ? "warn" : "";
  return <div aria-label="Seedance Fast 账号额度">
    <section className={`quota-strip ${tone}`} role="status"
      title="优先使用 Fast；某个账号达到上限后自动换号。Fast 都用不了时，任务会改用你设为 Seedance 2.0 的账号。尚未检测到上限不代表已查询到剩余额度。">
      <i aria-hidden="true" /><b>Seedance Fast 额度</b>
      {/* 都没到上限时只说一句；有账号到上限后逐个列出，方便看是哪个。 */}
      <span className="quota-accounts">{accounts.some(account => account.fastExhaustedToday)
        ? accounts.map(account => <span key={account.id}>{`${account.name}：${account.fastExhaustedToday ? "今日已上限" : "今日尚未检测到上限"}${!account.authenticated ? "（需登录）" : ""}`}</span>)
        : <>
          <span>{accounts.length} 个账号今日都尚未检测到上限</span>
          {accounts.some(account => !account.authenticated) && <span className="quota-login">需登录：{accounts.filter(account => !account.authenticated).map(account => account.name).join("、")}</span>}
        </>}</span>
      {message && <em>{message}</em>}
    </section>
    {!usingStandard && accounts.filter(account => account.needsModelDecision).map(account => (
      <SeedanceQuotaChoice key={account.id} account={account} onUpdated={onUpdated} onError={onError} />
    ))}
  </div>;
}

export function SeedanceQuotaChoice({ account, onUpdated, onError }: {
  account: SeedanceDesktopState["accountState"]["items"][number];
  onUpdated: (state: SeedanceDesktopState) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function choose(choice: "standard" | "wait") {
    if (choice === "standard" && !await confirmAction(`所有已启用 Fast 账号今日均已上限。今天是否使用“${account.name}”的 Seedance 2.0 继续排队任务？消耗更高，首选模型不变，跨天会重新尝试 Fast。`)) return;
    setBusy(true);
    try {
      const desktop = desktopBridge();
      if (!desktop?.seedanceDecideFastFallback) throw new Error("请更新 FlowCut 桌面程序");
      onUpdated(await desktop.seedanceDecideFastFallback(account.id, choice, account.quotaDate || ""));
    } catch (error) { onError(error instanceof Error ? error.message : "保存模型选择失败"); }
    finally { setBusy(false); }
  }
  return <section className="seedance-quota-notice" role="status" aria-label={`${account.name} Fast 额度提醒`}>
    <div><b>{account.name}：Fast 额度不足</b><p>{account.fallbackDecision === "wait" ? "已选择等待 Fast 恢复，可随时重新选择。" : "所有 Fast 账号均已上限，等待你的选择。"}{account.standardExhaustedToday ? "该账号的 2.0 今日也已上限。" : "尚未切换成 2.0。"}</p></div>
    <button type="button" disabled={busy || account.standardExhaustedToday || !account.authenticated} onClick={() => choose("standard")}>今天改用 2.0（消耗更高）</button>
    <button type="button" disabled={busy} onClick={() => choose("wait")}>等待 Fast 恢复</button>
  </section>;
}
