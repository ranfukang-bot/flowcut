"use client";
import { useEffect, useState } from 'react';

function today() {
  const now=new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
type Counts={day:string;total:number;accounts:{account_name:string;count:number}[]};
export function ApprovalStats({refreshKey}:{refreshKey:string}) {
  const [selectedDay,setSelectedDay]=useState('');
  const requestKey=JSON.stringify([selectedDay,refreshKey]);
  const [loaded,setLoaded]=useState<{key:string;counts:Counts}|null>(null);
  const counts=loaded?.key===requestKey?loaded.counts:null;
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
        if(!stopped){setLoaded({key:requestKey,counts:result});setError('');}
      }catch(e){if(!stopped)setError(e instanceof Error?e.message:'统计加载失败');}
    }
    void refresh();
    const timer=window.setInterval(()=>void refresh(),15000);
    return ()=>{stopped=true;controller.abort();window.clearInterval(timer);};
  },[selectedDay,requestKey]);
  return <section className="approval-stats" aria-label="每日通过统计">
    <div>
      <h3>每日通过统计 <span>共 {counts?.total??'—'} 条</span></h3>
      <p>按 TK 归档账号统计，审核通过才计数；清除任务不清零。日期按本机时间。</p>
    </div>
    <div className="approval-date"><input aria-label="统计日期" type="date" value={selectedDay||counts?.day||today()} onChange={e=>setSelectedDay(e.target.value)}/><button className="secondary" onClick={()=>setSelectedDay('')}>今天</button></div>
    {error?<p role="alert" className="form-error">{error}</p>:<div className="approval-accounts">
      {counts?.accounts.map(account=><div key={account.account_name}><span>{account.account_name}</span><strong>{account.count}</strong><small>条</small></div>)}
      {counts&&!counts.accounts.length&&<span>暂无账号，请先添加 TK 归档账号。</span>}
    </div>}
  </section>;
}
