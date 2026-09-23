export function productCell(row) {
  const cell=document.createElement('td'),box=document.createElement('div');box.className='product-summary';
  const thumb=document.createElement('div');thumb.className='product-thumb';
  const fallback=document.createElement('span');fallback.textContent='暂无图片';thumb.append(fallback);
  let url;try{url=new URL(row.imageUrl);}catch{}
  if(url&&['https:','http:'].includes(url.protocol)) {
    fallback.hidden=true;
    const img=document.createElement('img');img.alt=row.name||'商品图片';img.width=72;img.height=72;img.loading='eager';img.decoding='async';img.referrerPolicy='no-referrer';
    img.onload=()=>{fallback.hidden=true;};img.onerror=()=>{img.remove();fallback.hidden=false;fallback.textContent='图片未加载';};
    img.src=url.href;thumb.append(img);
  }
  const title=document.createElement('span');title.className='product-name';title.textContent=row.name;title.title=row.name;
  box.append(thumb,title);cell.append(box);return cell;
}
