"use client";
import { useEffect, useState } from 'react';

function today() {
  const now=new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
type Counts={day:string;total:number;accounts:{account_name:string;count:number}[]};
export function ApprovalStats({refreshKey}:{refreshKey:string}) {
  const [selectedDay,setSelectedDay]=useState('');
  const [counts,setCounts]=useState<Counts|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let stopped=false;
    const controller=new AbortController();
    async function refresh() {
      try {
        const query=new URLSearchParams({day:selectedDay||today(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
        const response=await fetch('/api/tasks/stats?'+query,{signal:controller.signal});
        const result=await response.json() as Counts & {error?:string};
        if(!response.ok) throw Error(result.error||'统计加载失败');
        if(!stopped){setCounts(result);setError('');}
      }catch(e){if(!stopped)setError(e instanceof Error?e.message:'统计加载失败');}
    }
    setCounts(null);void refresh();
    const timer=window.setInterval(()=>void refresh(),15000);
    return ()=>{stopped=true;controller.abort();window.clearInterval(timer);};
  },[selectedDay,refreshKey]);
  return <section aria-label="每日通过统计" style={{background:'white',border:'1px solid #dfe3dc',borderRadius:14,padding:18,marginBottom:20}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
      <div><h3 style={{margin:0}}>每日通过统计 <span style={{color:'#73852b'}}>共 {counts?.total??'—'} 条</span></h3>
        <p style={{margin:'6px 0',fontSize:12,color:'#77828a'}}>按 TK 归档账号统计，审核通过才计数；清除任务不清零。日期按本机时间。</p></div>
      <div style={{display:'flex',gap:8}}><input aria-label="统计日期" type="date" value={selectedDay||counts?.day||today()} onChange={e=>setSelectedDay(e.target.value)}/><button className="secondary" onClick={()=>setSelectedDay('')}>今天</button></div>
    </div>
    {error?<p role="alert">{error}</p>:<div style={{display:'flex',flexWrap:'wrap',gap:10,marginTop:10}}>
      {counts?.accounts.map(account=><div key={account.account_name} style={{border:'1px solid #e5e8de',borderRadius:10,padding:'10px 16px',minWidth:130}}><span>{account.account_name}</span><strong style={{display:'block',fontSize:22,marginTop:4}}>{account.count} <small style={{fontSize:12,fontWeight:400}}>条</small></strong></div>)}
      {counts&&!counts.accounts.length&&<span>暂无账号，请先添加 TK 归档账号。</span>}
    </div>}
  </section>;
}
