"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { DEFAULT_FISSION_REQUEST } from '../lib/fission';
import { DEFAULT_GEM_REQUEST, buildSingleGemRequest, validateGemRequest } from '../lib/gem-request';
import { SpokenLanguageSelect } from './spoken-language-select';
import { SPOKEN_LANGUAGE_OPTIONS } from '../lib/spoken-language';
import { DEFAULT_TASK_DURATION, DEFAULT_TASK_REGION, DEFAULT_SHOOTING_STYLE, TASK_DURATIONS, TASK_REGIONS, SHOOTING_STYLES } from '../lib/task-config';
import { validateVariantRequest } from '../lib/prompt-blocks';
import { confirmAction } from './confirm-action';
import { productIdFromImageName } from './use-image-product-id';
import type { Task, Product, Gem, TikTokAccount } from './studio-app';

// A product card: either images dropped in (grouped by the product ID in the
// file or folder name) or a product picked from the library.
type Card = {
  key: string;
  source: 'upload' | 'library';
  externalId: string;
  productId: string;
  files: File[];
  hint: string;
  saved?: { id: string; imageKeys: string[] };
};
type Settings = {
  motherGem: string; variantGem: string; account: string;
  duration: number; region: string; style: string; autoQueue: boolean;
  motherSource: 'generate' | 'paste'; template: string;
  motherRequestTemplate?: string;
  spokenLanguage: string;
};
type Dropped = { file: File; folder: string };

const MAX_CARDS = 10, MAX_IMAGES = 12, MAX_BYTES = 48 * 1024 ** 2;
const SETTINGS_KEY = 'flowcut-fission-settings-v1';
const DEFAULT_SETTINGS: Settings = {
  motherGem: '', variantGem: '', account: '', duration: DEFAULT_TASK_DURATION, region: DEFAULT_TASK_REGION,
  style: DEFAULT_SHOOTING_STYLE, autoQueue: true, motherSource: 'generate', template: DEFAULT_FISSION_REQUEST,
  spokenLanguage: 'auto',
};
const IMAGE = /\.(?:jpe?g|png|webp)$/i;

// File names such as "1735360337668113923.png", "1735360337668113923 (2).png"
// or "1735360337668113923-2.jpg" carry the product ID. Short numbers like
// "1.png" are picture numbers inside a product folder, not product IDs.
export function productIdFromFileName(name: string) {
  const direct = productIdFromImageName(name);
  if (direct.length >= 8) return direct;
  return name.trim().match(/^(\d{8,30})[\s_\-]+\(?\d{1,3}\)?\.(?:jpe?g|png|webp)$/i)?.[1] || '';
}
function productIdFromFolder(name: string) {
  return name.trim().match(/^(\d{8,30})(?!\d)/)?.[1] || '';
}

// Folders are read through the entry API; plain files through the file list.
// Entries must be taken synchronously while the drop event is still active.
function droppedImages(transfer: DataTransfer): Promise<Dropped[]> {
  const items = [...transfer.items].filter(item => item.kind === 'file');
  const entries = items.map(item => (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() || null);
  const plain = [...transfer.files];
  if (!entries.some(entry => entry?.isDirectory)) return Promise.resolve(plain.filter(file => IMAGE.test(file.name)).map(file => ({ file, folder: '' })));
  const out: Dropped[] = [];
  const walk = async (entry: FileSystemEntry, folder: string): Promise<void> => {
    if (out.length >= 300) return;
    if (entry.isFile) {
      if (!IMAGE.test(entry.name)) return;
      out.push({ file: await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)), folder });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, entry.name);
    }
  };
  return (async () => {
    for (const [index, entry] of entries.entries()) {
      if (entry) await walk(entry, '');
      else if (plain[index] && IMAGE.test(plain[index].name)) out.push({ file: plain[index], folder: '' });
    }
    return out;
  })();
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

// Adds dropped images to the cards: onto one card when dropped there,
// otherwise grouped by product ID (file name first, then folder name).
export function addImagesToCards(cards: Card[], images: Dropped[], target?: string): { cards: Card[]; notes: string[] } {
  const next = cards.map(card => ({ ...card }));
  const notes = new Set<string>();
  const append = (card: Card, file: File) => {
    if (card.files.some(existing => sameFile(existing, file))) return;
    if (card.files.length >= MAX_IMAGES) { notes.add(`每个商品最多 ${MAX_IMAGES} 张图片，多出的没有加入`); return; }
    card.files = [...card.files, file]; card.source = 'upload'; card.saved = undefined;
  };
  const fresh = (externalId: string, hint: string): Card | null => {
    if (next.length >= MAX_CARDS) { notes.add(`一批最多 ${MAX_CARDS} 个商品，多出的没有加入`); return null; }
    const card: Card = { key: crypto.randomUUID(), source: 'upload', externalId, productId: '', files: [], hint };
    next.push(card); return card;
  };
  const targetCard = target ? next.find(card => card.key === target) : undefined;
  const loose = new Map<string, Card | null>();
  for (const { file, folder } of images) {
    if (targetCard) { append(targetCard, file); continue; }
    const id = productIdFromFileName(file.name) || productIdFromFolder(folder);
    let card: Card | null | undefined;
    if (id) card = next.find(item => item.externalId.trim().toLowerCase() === id.toLowerCase()) || fresh(id, '');
    else {
      const group = folder ? `folder:${folder}` : 'loose';
      if (!loose.has(group)) loose.set(group, fresh('', folder ? `文件夹「${folder}」` : '这些图片的文件名里没有商品 ID'));
      card = loose.get(group);
    }
    if (card) append(card, file);
  }
  return { cards: next.filter(card => card.source === 'library' || card.files.length), notes: [...notes] };
}

function Thumbs({ card, product }: { card: Card; product?: Product }) {
  const urls = useMemo(() => card.files.slice(0, 4).map(file => URL.createObjectURL(file)), [card.files]);
  useEffect(() => () => urls.forEach(url => URL.revokeObjectURL(url)), [urls]);
  const library = card.source === 'library' ? (product?.images || []).slice(0, 4).map(image => `/api/media?key=${encodeURIComponent(image.object_key)}`) : [];
  const shown = card.source === 'library' ? library : urls;
  const total = card.source === 'library' ? product?.images?.length || 0 : card.files.length;
  /* eslint-disable @next/next/no-img-element */
  return <div className="fission-card-thumbs">
    {shown.map((url, index) => <img key={index} src={url} alt="" />)}
    {total > shown.length && <span>+{total - shown.length}</span>}
    {!shown.length && <span>无图</span>}
  </div>;
  /* eslint-enable @next/next/no-img-element */
}

export function FissionPage({ products, gems, accounts, request, onUpload, onCreated, onOpenTask, statusLabel, gemRequestTemplate = DEFAULT_GEM_REQUEST }: {
  products: Product[]; gems: Gem[]; accounts: TikTokAccount[];
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  onUpload: (files: File[], name: string, externalId: string) => Promise<{ id: string; imageKeys: string[] }>;
  onCreated: (autoQueue: boolean) => Promise<void>; onOpenTask: (task: Task) => void; statusLabel: (task: Task) => string;
  gemRequestTemplate?: string;
}) {
  const [cards, setCards] = useState<Card[]>([]);
  const [motherKey, setMotherKey] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [motherPrompt, setMotherPrompt] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [picker, setPicker] = useState(false), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [batches, setBatches] = useState<Task[]>([]), [listError, setListError] = useState('');
  const lock = useRef(false), requestId = useRef<string | null>(null);
  const cardsRef = useRef(cards);
  useEffect(() => { cardsRef.current = cards; }, [cards]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
        if (saved && typeof saved === 'object') setSettings(current => ({ ...current, ...saved, spokenLanguage:SPOKEN_LANGUAGE_OPTIONS.includes(saved.spokenLanguage)?saved.spokenLanguage:'auto' }));
      } catch { /* Defaults still work without local storage. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  function change(value: Partial<Settings>) {
    requestId.current = null;
    setSettings(current => {
      const next = { ...current, ...value };
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* Not remembered this time. */ }
      return next;
    });
  }
  function editCards(update: (current: Card[]) => Card[]) { requestId.current = null; setCards(current => update(current)); }

  const load = useCallback(async () => { const result = await request('/api/fission') as { batches: Task[] }; setBatches(result.batches); setListError(''); }, [request]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) void load().catch(e => { if (alive) setListError(e instanceof Error ? e.message : '批次列表暂时无法加载'); }); };
    refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [load]);

  const gemIds = new Set(gems.map(gem => gem.id)), accountNames = new Set(accounts.map(item => item.name));
  const motherGem = gemIds.has(settings.motherGem) ? settings.motherGem : '';
  const variantGem = gemIds.has(settings.variantGem) ? settings.variantGem : '';
  const account = accountNames.has(settings.account) ? settings.account : '';
  const paste = settings.motherSource === 'paste';
  const motherRequestTemplate = settings.motherRequestTemplate ?? gemRequestTemplate;
  const mother = cards.find(card => card.key === motherKey) || cards[0];
  const libraryProduct = (card: Card) => card.source === 'library' ? products.find(p => p.id === card.productId) : undefined;
  const idOf = (card: Card) => (card.source === 'library' ? libraryProduct(card)?.external_id || '' : card.externalId).trim();
  const ids = cards.map(idOf);
  const duplicate = (id: string) => Boolean(id) && ids.filter(other => other.toLowerCase() === id.toLowerCase()).length > 1;
  const missing = [
    cards.length < 2 ? `至少 2 个商品（现在 ${cards.length} 个）` : '',
    ids.some(id => !id) ? `${ids.filter(id => !id).length} 个商品缺商品 ID` : '',
    ids.some(duplicate) ? '有重复的商品 ID' : '',
    !paste && !motherGem ? '母版 Gem' : '',
    !variantGem ? '变体 Gem' : '',
    !account ? 'TK 账号' : '',
    paste && motherPrompt.trim().length < 300 ? '粘贴的母版（至少 300 字）' : '',
  ].filter(Boolean);
  const output = settings.autoQueue ? '视频' : '提示词';

  async function receive(transfer: DataTransfer | File[], target?: string) {
    setError(''); setNotice('');
    const images = Array.isArray(transfer) ? transfer.filter(file => IMAGE.test(file.name)).map(file => ({ file, folder: '' })) : await droppedImages(transfer);
    if (!images.length) { setError('没有找到图片（支持 JPG、PNG、WEBP）'); return; }
    const result = addImagesToCards(cardsRef.current, images, target);
    requestId.current = null; cardsRef.current = result.cards; setCards(result.cards);
    if (result.notes.length) setNotice(result.notes.join('；'));
  }
  function dropProps(target?: string) {
    const key = target || 'zone';
    return {
      onDragOver: (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); setDragging(key); },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(null); },
      onDrop: (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); setDragging(null); void receive(event.dataTransfer, target); },
    };
  }
  function addFromLibrary(product: Product) {
    editCards(current => current.length >= MAX_CARDS || current.some(card => card.productId === product.id || (product.external_id && idOf(card) === product.external_id.trim()))
      ? current : [...current, { key: crypto.randomUUID(), source: 'library', externalId: product.external_id, productId: product.id, files: [], hint: '' }]);
  }
  const matches = products.filter(product => {
    const q = search.trim().toLowerCase();
    return !q || `${product.external_id} ${product.name}`.toLowerCase().includes(q);
  }).slice(0, 40);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || missing.length) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      validateVariantRequest(settings.template);
      if (!paste) validateGemRequest(motherRequestTemplate);
      for (const card of cards) {
        if (card.source === 'upload' && card.files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) throw Error(`商品 ${idOf(card)} 的图片超过 48MB，请删掉几张`);
      }
      const motherIndex = Math.max(0, cards.indexOf(mother));
      const text = `将为 ${cards.length} 个商品各生成 1 条${output}${settings.autoQueue ? `，消耗 ${cards.length} 次视频额度` : '（不自动生成视频）'}。母版：${paste ? '使用粘贴的母版' : `由商品 ${idOf(mother)} 生成`}。确认开始？`;
      if (!await confirmAction(text)) return;
      const selected: Array<{ productId: string; imageKeys?: string[] }> = [];
      for (const card of cards) {
        let saved = card.saved;
        if (card.source === 'upload' && !saved) {
          saved = await onUpload(card.files, '', card.externalId.trim());
          const stored = saved;
          setCards(current => current.map(item => item.key === card.key ? { ...item, saved: stored } : item));
        }
        selected.push(card.source === 'upload' ? { productId: saved!.id, imageKeys: saved!.imageKeys } : { productId: card.productId });
      }
      requestId.current ||= crypto.randomUUID();
      await request('/api/fission', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        requestId: requestId.current, products: selected, motherSource: settings.motherSource, motherProductId: selected[motherIndex].productId,
        motherGemId: motherGem, motherPrompt, variantGemId: variantGem, variantRequestText: settings.template,
        motherRequestTemplate,
        spokenLanguage: settings.spokenLanguage,
        duration: settings.duration, region: settings.region, shootingStyle: settings.style, tiktokAccountName: account, autoQueue: settings.autoQueue,
      }) });
      requestId.current = null; setCards([]); setMotherKey('');
      setNotice(`已开始：${selected.length} 个商品各生成 1 条${output}，进度见下方。`);
      await onCreated(settings.autoQueue); await load();
    } catch (e) { setError(e instanceof Error ? e.message : '创建失败，请重试'); }
    finally { lock.current = false; setBusy(false); }
  }

  return <div className="page-body fission-page">
    <section className="page-intro"><div><h2>多品裂变</h2><p>一份母版，换成不同商品，每个商品出 1 条视频，按各自的商品 ID 归档。</p></div></section>
    <form className="fission-form" onSubmit={submit}>
      <fieldset disabled={busy} className="fission-step">
        <legend><span>1</span>放入商品</legend>
        <label className={`fission-drop ${dragging === 'zone' ? 'dragging' : ''} ${cards.length ? 'compact' : ''}`} {...dropProps()}>
          <input type="file" aria-label="选择商品图片" accept="image/jpeg,image/png,image/webp" multiple
            onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; void receive(files); }} />
          <b>把商品图片拖到这里</b>
          <span>可以一次拖入多个商品的图片或文件夹，按文件名里的商品 ID 自动分组；也可以点击选择</span>
        </label>
        {cards.length > 0 && <div className="fission-cards">
          {cards.map((card, index) => {
            const product = libraryProduct(card);
            const id = idOf(card);
            const known = card.source === 'upload' ? products.find(p => p.external_id?.trim() && p.external_id.trim() === id) : product;
            const isMother = !paste && card === mother;
            const problem = !id ? (card.source === 'library' ? '这个商品在商品库里没有 ID，请先去商品库补上' : '请填写商品 ID') : duplicate(id) ? '商品 ID 重复' : '';
            return <article key={card.key} className={`fission-card ${problem ? 'invalid' : ''} ${isMother ? 'mother' : ''} ${dragging === card.key ? 'dragging' : ''}`}
              aria-label={`商品 ${index + 1}`} {...(card.source === 'upload' ? dropProps(card.key) : {})}>
              <Thumbs card={card} product={product} />
              {card.source === 'upload'
                ? <input aria-label={`商品 ${index + 1} 的商品 ID`} placeholder="填写商品 ID" value={card.externalId} inputMode="numeric"
                    onChange={event => { const value = event.target.value; editCards(current => current.map(item => item.key === card.key ? { ...item, externalId: value, saved: undefined } : item)); }} />
                : <b className="fission-card-id">{id || '无商品 ID'}</b>}
              <small className={problem ? 'problem' : ''}>{problem ? `${problem}${card.hint && !id ? `（${card.hint}）` : ''}` : known ? known.name || '商品库已有' : `${card.files.length} 张图片`}</small>
              <div className="fission-card-actions">
                {!paste && <button type="button" className={isMother ? 'mother-on' : ''} aria-pressed={isMother} onClick={() => { requestId.current = null; setMotherKey(card.key); }}>{isMother ? '★ 母版' : '设为母版'}</button>}
                <button type="button" aria-label={`移除商品 ${index + 1}`} onClick={() => editCards(current => current.filter(item => item.key !== card.key))}>移除</button>
              </div>
            </article>;
          })}
        </div>}
        <div className="fission-step-foot">
          <span>{cards.length ? `已放入 ${cards.length} 个商品（2–10 个）${paste ? '' : '，★ 的商品用来生成母版'}` : '还没有商品'}</span>
          <button type="button" className="secondary" onClick={() => setPicker(open => !open)} aria-expanded={picker}>{picker ? '收起商品库' : '从商品库添加'}</button>
        </div>
        {picker && <div className="fission-picker">
          <input aria-label="搜索商品库" placeholder="搜索商品 ID 或名称" value={search} onChange={event => setSearch(event.target.value)} />
          <div role="list">{matches.map(product => {
            const added = cards.some(card => card.productId === product.id);
            return <button type="button" role="listitem" key={product.id} disabled={added || cards.length >= MAX_CARDS} onClick={() => addFromLibrary(product)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {product.images?.[0] ? <img alt="" src={`/api/media?key=${encodeURIComponent(product.images[0].object_key)}`} /> : <i />}
              <span><b>{product.external_id || '未填写 ID'}</b><small>{product.name || '未命名商品'}</small></span>
              <em>{added ? '已添加' : '添加'}</em>
            </button>;
          })}{!matches.length && <p>没有匹配的商品</p>}</div>
        </div>}
      </fieldset>

      <fieldset disabled={busy} className="fission-step">
        <legend><span>2</span>选择 Gem 和账号</legend>
        <div className="fission-essentials">
          {!paste && <label>母版 Gem<select aria-label="母版 Gem" value={motherGem} onChange={event => change({ motherGem: event.target.value })}><option value="">请选择</option>{gems.map(gem => <option key={gem.id} value={gem.id}>{gem.name}</option>)}</select></label>}
          <label>变体 Gem<select aria-label="变体 Gem" value={variantGem} onChange={event => change({ variantGem: event.target.value })}><option value="">请选择</option>{gems.map(gem => <option key={gem.id} value={gem.id}>{gem.name}</option>)}</select></label>
          <label>TK 账号<select aria-label="TK 归档账号" value={account} onChange={event => change({ account: event.target.value })}><option value="">请选择</option>{accounts.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
          <SpokenLanguageSelect region={settings.region} value={settings.spokenLanguage} onChange={spokenLanguage=>change({spokenLanguage})} />
        </div>
        <details className="fission-more">
          <summary>更多设置 <span>{settings.duration} 秒 · {settings.region} · {settings.style} · {settings.autoQueue ? '自动出视频' : '只出提示词'} · {paste ? '粘贴母版' : '商品生成母版'}</span></summary>
          <div className="fission-more-grid">
            <label>时长<select aria-label="时长" value={settings.duration} onChange={event => change({ duration: Number(event.target.value) })}>{TASK_DURATIONS.filter(n => n !== 30).map(n => <option key={n} value={n}>{n} 秒</option>)}</select></label>
            <label>地区<select aria-label="地区" value={settings.region} onChange={event => change({ region: event.target.value })}>{TASK_REGIONS.map(value => <option key={value}>{value}</option>)}</select></label>
            <label>拍摄风格<select aria-label="拍摄风格" value={settings.style} onChange={event => change({ style: event.target.value })}>{SHOOTING_STYLES.map(value => <option key={value}>{value}</option>)}</select></label>
            <label>生成方式<select aria-label="生成方式" value={settings.autoQueue ? 'video' : 'prompt'} onChange={event => change({ autoQueue: event.target.value === 'video' })}><option value="video">提示词 + 自动出视频</option><option value="prompt">只出提示词</option></select></label>
            <label>母版来源<select aria-label="母版来源" value={settings.motherSource} onChange={event => change({ motherSource: event.target.value as Settings['motherSource'] })}><option value="generate">用 ★ 商品生成</option><option value="paste">粘贴现成母版</option></select></label>
          </div>
          {paste && <label>现成母版（至少 300 字）<textarea aria-label="现成母版" rows={6} value={motherPrompt} maxLength={60000} onChange={event => { requestId.current = null; setMotherPrompt(event.target.value); }} /></label>}
          {!paste && <>
            <label>第一轮发给母版 Gem 的文字<textarea aria-label="第一轮发给母版 Gem 的文字" rows={5} maxLength={12000} value={motherRequestTemplate} onChange={event => change({ motherRequestTemplate: event.target.value })} /></label>
            <p className="fission-hint">{settings.motherRequestTemplate === undefined ? '沿用创作中心保存的「发送给 Gem 的文字」' : '本模块单独设置'}；可用 {'{时长}{地区}{拍摄风格}'}。{settings.motherRequestTemplate !== undefined && <button type="button" className="text-button" onClick={() => change({ motherRequestTemplate: undefined })}>沿用创作中心</button>}</p>
            <pre data-testid="fission-mother-request-preview" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{buildSingleGemRequest(motherRequestTemplate,{duration:settings.duration,region:settings.region,shooting_style:settings.style,spoken_language:settings.spokenLanguage})}</pre>
          </>}
          <label>第二轮发给变体 Gem 的文字<textarea aria-label="第二轮发给变体 Gem 的文字" rows={4} maxLength={12000} value={settings.template} onChange={event => change({ template: event.target.value })} /></label>
          <p className="fission-hint">必须保留 {'{母版提示词}'}；可用 {'{时长}{地区}{拍摄风格}'}。{settings.template !== DEFAULT_FISSION_REQUEST && <button type="button" className="text-button" onClick={() => change({ template: DEFAULT_FISSION_REQUEST })}>恢复默认</button>}</p>
        </details>
      </fieldset>

      {error && <p role="alert" className="warning-box">{error}</p>}
      {notice && <p role="status" className="fission-notice">{notice}</p>}
      <div className="fission-submit">
        {!paste && motherGem && motherGem === variantGem && <span role="status">母版 Gem 和变体 Gem 是同一个，确认没选错？</span>}
        {missing.length > 0 && <span>还差：{missing.join('、')}</span>}
        <button className="primary" disabled={busy || missing.length > 0}>{busy ? '正在提交…' : `生成 ${cards.length || ''} 条${output}`}</button>
      </div>
    </form>

    <section className="fission-batches"><h2>最近的裂变</h2>{listError && <p role="alert">{listError}</p>}
      {batches.map(batch => {
        const children = batch.children || [];
        const ready = children.filter(child => ['video_ready', 'scheduled'].includes(child.status)).length;
        return <article className="fission-batch-card" key={batch.id}>
          <div className="fission-row-head"><h3>{children.length} 个商品 · {batch.region} · {batch.tiktok_account_name}</h3><span className="status">{statusLabel(batch)}</span><span>{ready}/{children.length} 条已出片</span><button className="secondary" onClick={() => onOpenTask(batch)}>查看</button></div>
          <div className="fission-batch-children">{children.map(child => <button type="button" key={child.id} onClick={() => onOpenTask(child)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {child.product_image_key ? <img alt="" src={`/api/media?key=${encodeURIComponent(child.product_image_key)}`} /> : <i />}
            <span><b>{child.product_external_id}</b><small>{statusLabel(child)}</small></span>
          </button>)}</div>
        </article>;
      })}
      {!batches.length && !listError && <p className="fission-hint">还没有裂变批次。</p>}
    </section>
  </div>;
}
