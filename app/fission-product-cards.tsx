"use client";
import { useMemo, useEffect, type DragEvent } from 'react';
import { productIdFromImageName } from './use-image-product-id';
import type { Product } from './studio-types';
export type Card = {
  key: string;
  source: 'upload' | 'library';
  externalId: string;
  productId: string;
  files: File[];
  hint: string;
  saved?: { id: string; imageKeys: string[] };
};

type Dropped = { file: File; folder: string };
const MAX_CARDS=10, MAX_IMAGES=12;
export const IMAGE = /\.(?:jpe?g|png|webp)$/i;

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
export function droppedImages(transfer: DataTransfer): Promise<Dropped[]> {
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


export function FissionProductCards({ cards, products, motherKey, paste, dragging, dropProps, editCards, onMother }: {
  cards: Card[]; products: Product[]; motherKey: string; paste: boolean; dragging: string | null;
  dropProps: (key?: string) => { onDragOver: (event: DragEvent) => void; onDragLeave: (event: DragEvent) => void; onDrop: (event: DragEvent) => void };
  editCards: (update: (current: Card[]) => Card[]) => void; onMother: (key: string) => void;
}) {
  const mother=cards.find(card=>card.key===motherKey)||cards[0];
  const libraryProduct=(card:Card)=>card.source==='library'?products.find(p=>p.id===card.productId):undefined;
  const idOf=(card:Card)=>(card.source==='library'?libraryProduct(card)?.external_id||'':card.externalId).trim();
  const ids=cards.map(idOf),duplicate=(id:string)=>Boolean(id)&&ids.filter(other=>other.toLowerCase()===id.toLowerCase()).length>1;
  return <>{cards.length > 0 && <div className="fission-cards">
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
                {!paste && <button type="button" className={isMother ? 'mother-on' : ''} aria-pressed={isMother} onClick={() => { onMother(card.key); }}>{isMother ? '★ 母版' : '设为母版'}</button>}
                <button type="button" aria-label={`移除商品 ${index + 1}`} onClick={() => editCards(current => current.filter(item => item.key !== card.key))}>移除</button>
              </div>
            </article>;
          })}
        </div>}</>;
}
