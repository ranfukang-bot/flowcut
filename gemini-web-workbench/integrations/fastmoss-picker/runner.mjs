import {countValue,priceValue,pageUrl,isDash,growthDecision} from './core.mjs';
export class Runner {
  constructor(io) { this.io=io; this.running=false; this.stop=false; this.state=null; }
  async save() { await this.io.save(this.state); this.io.update(this.state); }
  pause() { this.stop=true; }
  async begin(scopes, settings, apiContext=null) {
    if(this.running) return;
    this.state={schema:2,scopes:structuredClone(scopes),settings,phase:'lists',scopeIndex:0,page:1,detailIndex:0,rows:[],fingerprints:{},pagesDone:0,status:'准备开始',complete:false,startedAt:new Date().toISOString()};
    if(apiContext)this.state.apiContext=apiContext;
    await this.save(); await this.run();
  }
  async readChecked(url,kind,validate) {
    for(let attempt=0;attempt<3;attempt++) {
      if(this.stop)throw Object.assign(new Error('用户暂停'),{cancelled:true});
      try {
        const r=await this.io.read(url,kind,this.state.settings.delay,{refresh:attempt>0});
        if(this.stop)throw Object.assign(new Error('用户暂停'),{cancelled:true});
        if(r.error)throw Object.assign(new Error(r.error),{blocked:!!r.blocked});
        validate(r);return r;
      } catch(e) {
        if(this.stop||e.cancelled||e.blocked||attempt===2)throw e;
        this.state.status='读取失败，正在自动刷新重试 '+(attempt+1)+'/2：'+e.message;
        await this.save();
      }
    }
  }
  async run() {
    if(this.running || !this.state || this.state.complete) return;
    this.running=true; this.stop=false;
    const s=this.state;
    const isNew=s.settings.boardType==='new';
    s.failedPages??=[];
    try {
      while(!this.stop && s.phase==='lists' && s.scopeIndex<s.scopes.length) {
        const scope=s.scopes[s.scopeIndex];
        s.status=`读取分类「${scope.name}」第 ${s.page}/${s.settings.pages} 页`; await this.save();
        const url=pageUrl(scope.url,s.page);
        let r;
        try { r=await this.readChecked(url,'list',r=>{
        if(isNew && s.settings.listDates?.length && r.dates?.length && JSON.stringify(r.dates)!==JSON.stringify(s.settings.listDates))throw Object.assign(new Error('新品榜上架日期与所选页面不一致，请在网站重新选择日期，确认地址更新后重新开始'),{blocked:true});
        if(!isNew && r.rows?.some(row=>growthDecision(row.growthRaw,s.settings.growthMin,s.settings.growthMax)===null))throw new Error('销量环比未能读取；未读取不等于“-”，请检查榜单后重试');
        if(r.activePage!==null && r.activePage!==undefined && r.activePage!==s.page) throw new Error(`网站实际显示第 ${r.activePage} 页，期望第 ${s.page} 页；可能超出权限或翻页未生效`);
        if(!r.rows?.length) throw new Error('没有读取到商品，已暂停；请检查是否到达末页或会员范围');
        const fingerprint=r.rows.map(x=>x.url).sort().join('|');
        if((s.fingerprints[s.scopeIndex]||[]).includes(fingerprint))throw new Error('网站返回重复页，无法确认本页数据');
        }); } catch(e) {
          if(this.stop||e.cancelled)break;
          if(e.blocked)throw e;
          s.failedPages.push({url,page:s.page,scope:scope.name,error:e.message,attempts:3});
          s.page++;
          if(s.page>s.settings.pages){s.scopeIndex++;s.page=1;}
          await this.save();continue;
        }
        const fingerprint=r.rows.map(x=>x.url).sort().join('|');
        const previous=s.fingerprints[s.scopeIndex]||[];
        previous.push(fingerprint); s.fingerprints[s.scopeIndex]=previous;
        for(const [rowIndex,row] of r.rows.entries()) {
          if(!isNew && growthDecision(row.growthRaw,s.settings.growthMin,s.settings.growthMax)===false)continue;
          // Keep a separate observation per category, but deduplicate within it.
          const key=scope.url+'|'+row.url;
          if(!s.rows.some(x=>x.key===key)) s.rows.push({...row,key,scope:scope.name,page:s.page,pagePosition:rowIndex+1,status:'pending',creators:null,creatorsRaw:row.listCreatorsRaw||''});
        }
        s.pagesDone++; s.page++;
        if(s.page>s.settings.pages) {s.scopeIndex++;s.page=1;}
        await this.save();
      }
      if(!this.stop && s.phase==='lists' && s.scopeIndex===s.scopes.length) {
        s.phase='details';await this.save();
      }
      while(!this.stop && s.phase==='details' && s.detailIndex<s.rows.length) {
        const row=s.rows[s.detailIndex];
        s.status=`${isNew?'读取库存和佣金':'读取带货达人数'} ${s.detailIndex+1}/${s.rows.length}：${row.name}`;await this.save();
        try {
          const cached=s.rows.slice(0,s.detailIndex).find(x=>x.url===row.url && x.status==='ok');
          let details;
          if(cached) details={creators:cached.creators,creatorsRaw:cached.creatorsRaw,priceRaw:cached.priceRaw,stock:cached.stock,commission:isNew?(cached.commission||row.commission):(row.commission||cached.commission),readAt:cached.readAt};
          else {
            const r=await this.readChecked(row.url,'detail',r=>{
              if(isNew)return;
              if(String(r.creatorsRaw).includes('万'))return;
              const n=countValue(r.creatorsRaw);
              if(n===null&&!isDash(r.creatorsRaw))throw new Error('带货人数无法确认为整数或“-”');
              const p=r.priceRaw||row.priceRaw||'';
              if(n<s.settings.max&&(s.settings.priceMin!=null||s.settings.priceMax!=null)&&!priceValue(p)&&!isDash(p))throw new Error('价格无法识别');
            });
            if(!isNew && String(r.creatorsRaw).includes('万')) {
              Object.assign(row,{creatorsRaw:r.creatorsRaw,creators:null,status:'skipped',error:'',skipReason:'带货人数含“万”，按设置直接跳过',readAt:new Date().toISOString()});
              s.detailIndex++;await this.save();continue;
            }
            const creators=countValue(r.creatorsRaw);
            if(!isNew && creators===null&&!isDash(r.creatorsRaw)) throw new Error(`带货人数「${r.creatorsRaw}」不是可确认的整数，需人工核对`);
            const priceRaw=r.priceRaw||row.priceRaw||'';
            if(!isNew && creators<s.settings.max&&(s.settings.priceMin!=null||s.settings.priceMax!=null)&&!priceValue(priceRaw)&&!isDash(priceRaw))throw new Error('价格无法识别，请打开商品核对；不会当作 0 元');
            details={creators,creatorsRaw:isDash(r.creatorsRaw)?'-':(r.creatorsRaw||row.listCreatorsRaw||''),priceRaw,stock:r.stock,commission:isNew?(r.commission||row.commission||''):(row.commission||r.commission||''),readAt:new Date().toISOString()};
          }
          Object.assign(row,details,{status:'ok',error:''});s.detailIndex++;await this.save();
        } catch(e) {
          if(this.stop||e.cancelled)break;
          row.status='error';row.error=e.message;
          if(e.blocked)throw e;
          row.autoSkipped=true;row.attempts=3;row.readAt=new Date().toISOString();
          s.detailIndex++;await this.save();
        }
      }
      if(!this.stop && s.phase==='details' && s.detailIndex===s.rows.length) {
        s.complete=true;s.status=`扫描结束：成功读取 ${s.pagesDone} 页，跳过失败榜单 ${s.failedPages.length} 页；处理 ${s.rows.length} 件，读取失败跳过 ${s.rows.filter(r=>r.autoSkipped).length} 件（未验证，不算合格）`;s.finishedAt=new Date().toISOString();
      } else s.status='已暂停；点击继续将重试当前页 / 商品';
    } catch(e) { s.status='已暂停：'+e.message; }
    finally {this.running=false;await this.save();}
  }
}
