const assert=require('node:assert/strict');
module.exports=async function({api,base,headers,productId,gemId}) {
  const stats=day=>api('/api/tasks/stats?day='+day+'&timeZone=Asia%2FShanghai');
  const review=(id,extra)=>api('/api/tasks/review',{method:'POST',body:JSON.stringify({id,confirmed:true,...extra})});
  const ids=[];
  await api('/api/tasks?all=1',{method:'DELETE'});
  for(const account of ['archive-test','archive-test','clear-test']) {
    const task=await api('/api/tasks',{method:'POST',body:JSON.stringify({productId,gemId,tiktokAccountName:account})});ids.push(task.id);
    const claimed=await api('/api/gemini-bridge?workerId=stats-smoke&capacity=1&accountIds=test-account',{headers:{authorization:'Bearer smoke-bridge-only'}});
    assert.equal(claimed.jobs[0].id,task.id);
    await api('/api/gemini-bridge',{method:'POST',headers:{authorization:'Bearer smoke-bridge-only'},body:JSON.stringify({action:'result',taskId:task.id,workerId:'stats-smoke',prompt:'A real test prompt '.repeat(40)})});
    await api('/api/seedance-bridge',{method:'POST',headers:{authorization:'Bearer smoke-bridge-only'},body:JSON.stringify({action:'status',taskId:task.id,providerStatus:'success',downloadPath:'C:\\isolated\\'+task.id+'.mp4'})});
  }
  assert.equal((await stats('2026-01-16')).total,0,'generation alone never counts');
  const response=await fetch(base+'/api/tasks/review',{method:'POST',headers,body:JSON.stringify({id:ids[0],confirmed:true,path:'C:\\published.mp4'})});
  assert.equal(response.status,409,'approval must have reserved first');
  await review(ids[0],{action:'reserve'});await review(ids[0],{action:'cancel'});
  assert.equal((await stats('2026-01-16')).total,0,'cancelled approval never counts');
  for(const id of ids)await review(id,{action:'reserve'});
  const first={path:'C:\\published.mp4',approvedAt:'2026-01-15T16:01:00Z',timeZone:'Asia/Shanghai'};
  await Promise.all(Array.from({length:4},()=>review(ids[0],first)));
  await review(ids[1],{...first,approvedAt:'2026-01-15T15:59:00Z'});
  await review(ids[2],first);
  const result=await stats('2026-01-16');
  assert.equal(result.total,2);
  assert.equal(result.accounts.find(a=>a.account_name==='archive-test').count,1);
  assert.equal(result.accounts.find(a=>a.account_name==='clear-test').count,1);
  assert.equal((await stats('2026-01-15')).total,1);
  await review(ids[0],{...first,approvedAt:'2026-01-16T16:01:00Z'});
  assert.equal((await stats('2026-01-17')).total,0,'next-day retry does not move count');
  await api('/api/tasks?completed=1',{method:'DELETE'});
  await api('/api/tasks?all=1',{method:'DELETE'});
  assert.equal((await stats('2026-01-16')).total,2,'task clearing does not clear production history');
  assert.equal((await stats('2026-01-16')).total,2,'repeated reads do not duplicate counts');
  console.log('Daily approval statistics HTTP: account counts, timezone, deduplication, cancellations, midnight retry and task clearing PASS');
};
