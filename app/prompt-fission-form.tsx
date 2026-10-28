"use client";
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_FISSION_REQUEST } from '../lib/fission';
import { buildGemRequest } from '../lib/gem-request';
import { FissionProductCards, droppedImages, addImagesToCards, IMAGE, type Card } from './fission-product-cards';
import { api } from './studio-client';
import type { Gem } from './studio-types';

const KEY = 'flowcut-prompt-fission-settings-v1';
export function PromptFissionForm({ gems, region, firstText, children, onCreated }: {
  gems: Gem[]; region: string; firstText: string;
  children: (paste: boolean) => ReactNode; onCreated: () => Promise<void>;
}) {
  const [cards, setCards] = useState<Card[]>([]), [motherKey, setMotherKey] = useState('');
  const [motherGem, setMotherGem] = useState(''), [variantGem, setVariantGem] = useState('');
  const [source, setSource] = useState<'generate' | 'paste'>('generate'), [motherPrompt, setMotherPrompt] = useState('');
  const [customSecond, setCustomSecond] = useState<string | null>(null), [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const cardsRef = useRef(cards), locked = useRef(false), submission = useRef<{ fingerprint: string; id: string } | null>(null);
  const paste = source === 'paste', mother = cards.find(card => card.key === motherKey) || cards[0];
  const secondText = customSecond ?? buildGemRequest(DEFAULT_FISSION_REQUEST, { region, duration: 30, shooting_style: '', spoken_language: 'auto' });
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
      if (!alive) return;
      try {
        const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
        if (typeof saved.motherGem === 'string') setMotherGem(saved.motherGem);
        if (typeof saved.variantGem === 'string') setVariantGem(saved.variantGem);
        if (saved.source === 'paste') setSource('paste');
        if (typeof saved.secondText === 'string') setCustomSecond(saved.secondText);
      } catch { /* Defaults work without storage. */ }
      setReady(true);
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (ready) try { localStorage.setItem(KEY, JSON.stringify({ motherGem, variantGem, source, secondText: customSecond })); } catch { /* Optional persistence. */ }
  }, [ready, motherGem, variantGem, source, customSecond]);
  function editCards(update: (current: Card[]) => Card[]) {
    const next = update(cardsRef.current); cardsRef.current = next; setCards(next);
  }
  async function receive(transfer: DataTransfer | File[], target?: string) {
    const images = Array.isArray(transfer) ? transfer.filter(file => IMAGE.test(file.name)).map(file => ({ file, folder: '' })) : await droppedImages(transfer);
    if (!images.length) { setNotice('没有找到图片（支持 JPG、PNG、WEBP）'); return; }
    const result = addImagesToCards(cardsRef.current, images, target);
    editCards(() => result.cards); setNotice(result.notes.join('；'));
  }
  function dropProps(target?: string) {
    return {
      onDragOver: (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); if (!busy) setDragging(target || 'zone'); },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(null); },
      onDrop: (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); setDragging(null); if (!busy) void receive(event.dataTransfer, target); },
    };
  }
  const ids = cards.map(card => card.externalId.trim());
  const missing = [cards.length < 2 && '至少 2 个商品', ids.some(id => !id) && '请补齐商品 ID',
    new Set(ids.map(id => id.toLowerCase())).size !== ids.length && '商品 ID 不能重复',
    !paste && !gems.some(g => g.id === motherGem) && '请选择母版 Gem', !gems.some(g => g.id === variantGem) && '请选择变体 Gem',
    paste && (motherPrompt.trim().length < 300 || motherPrompt.length > 60000) && '母版须为 300–60000 字',
    !paste && (!firstText.trim() || firstText.length > 12000) && '第一轮文字须为 1–12000 字',
    !secondText.includes('{母版提示词}') && '第二轮文字必须包含 {母版提示词}', secondText.length > 12000 && '第二轮文字不能超过 12000 字',
  ].filter(Boolean).join('；');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (locked.current || missing) return;
    locked.current = true; setBusy(true); setNotice('');
    try {
      const fingerprint = JSON.stringify({ cards: cards.map(card => [card.key, card.externalId, card.files.map(file => [file.name, file.size, file.lastModified])]), motherKey, motherGem, variantGem, source, motherPrompt, region, firstText, secondText });
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, id: crypto.randomUUID() };
      const selected: Array<{ productId: string; imageKeys: string[] }> = [];
      for (const card of cardsRef.current) {
        if (card.files.some(file => file.size > 12 * 1024 ** 2) || card.files.reduce((sum, file) => sum + file.size, 0) > 48 * 1024 ** 2) throw Error(`商品 ${card.externalId}：单图不能超过 12MB，总大小不能超过 48MB`);
        let saved = card.saved;
        if (!saved) {
          const form = new FormData(); card.files.forEach(file => form.append('images', file));
          form.set('externalId', card.externalId.trim()); form.set('name', ''); form.set('country', region);
          saved = await api('/api/products', { method: 'POST', body: form }) as { id: string; imageKeys: string[] };
          const value = saved; editCards(current => current.map(row => row.key === card.key ? { ...row, saved: value } : row));
        }
        selected.push({ productId: saved.id, imageKeys: saved.imageKeys });
      }
      await api('/api/prompt-batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        mode: 'fission', requestId: submission.current.id, products: selected, motherSource: source,
        motherProductId: selected[Math.max(0, cards.indexOf(mother))].productId, motherGemId: motherGem,
        motherPrompt, variantGemId: variantGem, region, firstText: paste ? undefined : firstText, secondText,
      }) });
      submission.current = null; editCards(() => []); setMotherKey(''); setNotice('已创建，进度见下方提示词批次。');
      await onCreated();
    } catch (error) { setNotice(error instanceof Error ? error.message : '创建失败，请重试'); }
    finally { locked.current = false; setBusy(false); }
  }
  return <form className="panel prompt-batch-form fission-form" onSubmit={submit}>
    <fieldset disabled={busy} className="fission-step">
      <legend>放入商品（2–10 个）</legend>
      <label className={`fission-drop ${dragging === 'zone' ? 'dragging' : ''}`} {...dropProps()}>
        <input type="file" aria-label="选择商品图片" accept="image/jpeg,image/png,image/webp" multiple onChange={event => { void receive(Array.from(event.target.files || [])); event.target.value = ''; }} />
        <b>把商品图片拖到这里</b><span>按文件名或文件夹里的商品 ID 分组，★ 商品用来生成母版</span>
      </label>
      <FissionProductCards cards={cards} products={[]} motherKey={motherKey} paste={paste} dragging={dragging} dropProps={dropProps} editCards={editCards} onMother={setMotherKey} />
      <div className="prompt-batch-fields">
        <label>母版来源<select aria-label="母版来源" value={source} onChange={event => setSource(event.target.value as typeof source)}><option value="generate">用 ★ 商品生成</option><option value="paste">粘贴现成母版</option></select></label>
        {!paste && <label>母版 Gem<select aria-label="母版 Gem" value={motherGem} onChange={event => setMotherGem(event.target.value)}><option value="">请选择母版 Gem</option>{gems.map(gem => <option key={gem.id} value={gem.id}>{gem.name}</option>)}</select></label>}
        <label>变体 Gem<select aria-label="变体 Gem" value={variantGem} onChange={event => setVariantGem(event.target.value)}><option value="">请选择变体 Gem</option>{gems.map(gem => <option key={gem.id} value={gem.id}>{gem.name}</option>)}</select></label>
      </div>
      {paste && <label>母版提示词<textarea aria-label="母版提示词" className="prompt-batch-text" rows={8} maxLength={60000} value={motherPrompt} onChange={event => setMotherPrompt(event.target.value)} /></label>}
      {children(paste)}
      <details><summary>第二轮文字（发给变体 Gem）{customSecond !== null ? ' · 已自定义' : ''}</summary>
        <label>实际发送内容<textarea aria-label="第二轮文字" className="prompt-batch-text" rows={8} maxLength={12000} value={secondText} onChange={event => setCustomSecond(event.target.value)} /></label>
        <button type="button" className="secondary" onClick={() => setCustomSecond(null)}>恢复默认文字</button>
        <p>只替换 {'{母版提示词}'}，其余按你编辑的原文发送；自定义后换地区不会覆盖。</p>
      </details>
      <div className="prompt-batch-actions"><button className="primary" disabled={!ready || Boolean(missing) || busy}>生成 {cards.length} 个商品的提示词</button><span>{missing}</span></div>
    </fieldset>
    {notice && <p role="status">{notice}</p>}
  </form>;
}
