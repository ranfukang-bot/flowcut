"use client";
import { useEffect, useState } from 'react';

export type GeminiModelSettings = { mode: 'auto' | 'exact' | 'preserve'; name: string; thinking: string };
export type ModelState = {
  settings?: { geminiModel?: GeminiModelSettings };
  accounts?: Array<{ id: string; name: string; authenticated?: boolean; modelCatalog?: { models?: string[]; thinking?: string[]; readAt?: string; error?: string }; modelSelectionHold?: { message: string } }>;
};
type ModelBridge = {
  getState?: () => Promise<ModelState>;
  readGeminiModels?: () => Promise<ModelState>;
  saveGeminiModel?: (settings: GeminiModelSettings) => Promise<ModelState>;
};
const defaults: GeminiModelSettings = { mode: 'preserve', name: '', thinking: '' };
// Same rule as the desktop picker: Gemini renamed 低点/中等/高点 to 低/中/高,
// and a saved level keeps working under the new wording.
function thinkingLevel(value: string) {
  const text = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^(?:低|low\b|minimal\b)/.test(text)) return 'low';
  if (/^(?:中|medium\b|mid\b|moderate\b)/.test(text)) return 'medium';
  if (/^(?:高|high\b|max(?:imum)?\b)/.test(text)) return 'high';
  return text;
}

export function GeminiModelSettingsPanel({ bridge }: { bridge: () => ModelBridge | undefined }) {
  const [state, setState] = useState<ModelState | null>(null);
  const [draft, setDraft] = useState<GeminiModelSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    void bridge()?.getState?.().then(value => { if (alive) setState(value); }).catch(error => { if (alive) setMessage(String(error.message)); });
    return () => { alive = false; };
  }, [bridge]);
  const value = draft || state?.settings?.geminiModel || defaults;
  const accounts = state?.accounts || [];
  const models = [...new Set(accounts.flatMap(account => account.modelCatalog?.models || []))];
  const thinking = [...new Set(accounts.flatMap(account => account.modelCatalog?.thinking || []))];
  const sameLevel = value.thinking ? thinking.find(name => thinkingLevel(name) === thinkingLevel(value.thinking)) : undefined;
  const savedThinkingNote = sameLevel ? `${value.thinking}（网页现在叫「${sameLevel}」，可以正常使用）` : `${value.thinking}（读取结果中不存在）`;
  async function act(action: 'read' | 'save') {
    setBusy(true); setMessage('');
    try {
      const api = bridge();
      if (!api?.readGeminiModels || !api.saveGeminiModel) throw new Error('请在支持模型设置的新版 FlowCut 桌面程序中操作');
      const next = action === 'read' ? await api.readGeminiModels() : await api.saveGeminiModel(value);
      setState(next);
      if (action === 'save') setDraft(null);
      setMessage(action === 'read' ? '模型列表读取完成，请核对各账号的结果。' : '已保存，后续所有 Gemini 网页任务和重试使用此设置。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Gemini 生成模型" className="local-api-note">
    <h3>Gemini 生成模型</h3>
    <p>默认不指定模型、不改动思考等级；手动选择并保存后生效。统一用于商品提示词、爆款复刻和剧本流水线。无法确认目标时停止上传与发送，并暂停该账号领取任务。</p>
    <label>模型<select aria-label="Gemini 生成模型模式" disabled={busy} value={value.mode} onChange={event => setDraft({ ...value, mode: event.target.value as GeminiModelSettings['mode'] })}>
      <option value="auto">自动：最新 Flash（不含 Lite）</option><option value="exact">指定某个模型</option><option value="preserve">不指定：沿用网页当前选择</option>
    </select></label>
    {value.mode === 'exact' && <label>指定模型<select aria-label="指定 Gemini 模型" disabled={busy} value={value.name} onChange={event => setDraft({ ...value, name: event.target.value })}>
      <option value="">请先读取模型列表，再选择</option>{value.name && !models.includes(value.name) && <option value={value.name}>{value.name}（读取结果中不存在）</option>}{models.map(name => <option key={name}>{name}</option>)}
    </select></label>}
    <label>思考等级<select aria-label="Gemini 思考等级" disabled={busy} value={value.thinking} onChange={event => setDraft({ ...value, thinking: event.target.value })}>
      <option value="">不改动</option>{value.thinking && !thinking.includes(value.thinking) && <option value={value.thinking}>{savedThinkingNote}</option>}{thinking.map(name => <option key={name}>{name}</option>)}
    </select></label>
    <p><button type="button" className="secondary" disabled={busy || !state} onClick={() => void act('read')}>{busy ? '处理中…' : '读取模型列表'}</button> <button type="button" className="secondary" disabled={busy || !state || (value.mode === 'exact' && !value.name)} onClick={() => void act('save')}>保存生成模型</button></p>
    <small>读取前请暂停 Gemini 队列并等待当前任务结束。列表按账号保存；某一账号不支持所选模型时不会改选其他模型。</small>
    {accounts.map(account => <div key={account.id}><strong>{account.name}</strong> · {account.modelCatalog?.readAt ? `读取于 ${new Date(account.modelCatalog.readAt).toLocaleString()}` : '尚未读取'}
      <div>模型：{account.modelCatalog?.models?.join('、') || '—'}；思考等级：{account.modelCatalog?.thinking?.join('、') || '—'}</div>
      {account.modelCatalog?.error && <pre role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{account.modelCatalog.error}</pre>}{account.modelSelectionHold && <p role="alert">{account.modelSelectionHold.message}</p>}
    </div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}

export function GeminiModelInfo({ value }: { value?: string | null }) {
  if (!value) return null;
  let info: { model: string; thinking?: string; elapsedMs?: number };
  try { info = JSON.parse(value); } catch { return null; }
  if (!info || typeof info.model !== 'string') return null;
  return <p>实际 Gemini 模型：{info.model} · 思考等级：{info.thinking || '未读取（沿用网页）'} · 模型检查 {info.elapsedMs ?? '—'}ms</p>;
}
