import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

export function isPublicAddress(ip) {
  if(ip.includes(':')) return !/^(::|fc|fd|fe[89ab]|ff)/i.test(ip) && !ip.includes('.');
  const a=ip.split('.').map(Number); if(a.length!==4||a.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
  return !(a[0]===0||a[0]===10||a[0]===127||a[0]>=224||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===100&&a[1]>=64&&a[1]<=127)||(a[0]===198&&(a[1]===18||a[1]===19)));
}
function safeLookup(host, options, cb) {
  dns.lookup(host,{all:true},(err,addresses)=>{
    if(err)return cb(err);
    if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))return cb(new Error('素材地址不能指向本机或内网'));
    if(options?.all)cb(null,addresses);else cb(null,addresses[0].address,addresses[0].family);
  });
}
export async function fetchMedia(url, target, {maxBytes=250*1024*1024, referer='https://ads.tiktok.com/', redirects=0, timeoutMs=30000, budgetMs=300000}={}) {
  if(redirects>5)throw new Error('素材下载重定向过多');
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw new Error('无效的 HTTPS 素材地址');
  // IP literals bypass Node's DNS lookup; reject them explicitly.
  if(/^[\d.]+$/.test(u.hostname)||u.hostname.includes(':')||u.hostname==='localhost')throw new Error('素材必须来自公网域名');
  const res=await new Promise((resolve,reject)=>{
    const req=https.get(u,{lookup:safeLookup,headers:{'User-Agent':'Mozilla/5.0','Referer':referer},timeout:timeoutMs},resolve);
    req.on('timeout',()=>req.destroy(new Error('素材连接超时')));req.on('error',reject);
  });
  if([301,302,303,307,308].includes(res.statusCode)) {const next=new URL(res.headers.location,u);res.resume();return fetchMedia(next.href,target,{maxBytes,referer,redirects:redirects+1,timeoutMs,budgetMs});}
  if(res.statusCode!==200) {res.resume();throw new Error(`素材下载失败 HTTP ${res.statusCode}`);}
  if(Number(res.headers['content-length']||0)>maxBytes) {res.destroy();throw new Error('素材超过文件大小限制');}
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temp=target+'.'+randomUUID()+'.part';let bytes=0;
  const guard=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>maxBytes?new Error('素材超过大小限制'):null,chunk);}});
  const timeout=setTimeout(()=>res.destroy(new Error('素材下载超过 5 分钟')),budgetMs);
  try {await pipeline(res,guard,fs.createWriteStream(temp,{flags:'wx'}));fs.renameSync(temp,target);return {bytes,contentType:res.headers['content-type']||''};}
  catch(e){fs.rmSync(temp,{force:true});throw e;}finally{clearTimeout(timeout);}
}
export function imageType(buf) {
  if(buf.subarray(0,3).equals(Buffer.from([255,216,255])))return {type:'image/jpeg',ext:'jpg'};
  if(buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {type:'image/png',ext:'png'};
  if(buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP')return {type:'image/webp',ext:'webp'};
  throw new Error('图片格式不受支持，请补充 JPG、PNG 或 WebP 图片');
}
export function verifyVideo(file) {
  const size=fs.statSync(file).size;if(size<1024)throw new Error('视频为空或文件不完整');
  const fd=fs.openSync(file,'r');let pos=0,ftyp=false,mdat=false,moov=false,video=false;
  try {
    while(pos+8<=size) {
      const h=Buffer.alloc(16);fs.readSync(fd,h,0,Math.min(16,size-pos),pos);
      let length=h.readUInt32BE(0),type=h.toString('ascii',4,8),header=8;
      if(length===1){const big=h.readBigUInt64BE(8);if(big>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('视频块大小无效');length=Number(big);header=16;}
      if(length===0)length=size-pos;
      if(length<header||pos+length>size)throw new Error('视频文件下载不完整');
      if(type==='ftyp')ftyp=true;
      if(type==='mdat'&&length>header)mdat=true;
      if(type==='moov') {moov=true;if(length>25*1024*1024)throw new Error('视频索引过大');const meta=Buffer.alloc(length-header);fs.readSync(fd,meta,0,meta.length,pos+header);video=meta.includes(Buffer.from('vide'));}
      pos+=length;
    }
    if(pos!==size||!ftyp||!mdat||!moov||!video)throw new Error('未识别到完整 MP4 视频轨道，请重新下载成品');
    return {size,format:'mp4'};
  }finally{fs.closeSync(fd);}
}
