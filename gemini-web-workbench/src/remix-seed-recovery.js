// Resume an existing local Seedance identity. Never manufacture a replacement
// task when its historical submission evidence is missing.
async function resumeRemixSeedance({task,parent,store,engine,bridge}) {
  if(task.task_role!=='clip' || task.remix_segment_start==null || parent?.task_role!=='remix' || parent.status!=='remix_segmented') throw Error('请先恢复复刻组的分段检查');
  const local=store.tasks.find(row=>row.flowcutTaskId===task.id && (!task.provider_job_id || row.id===task.provider_job_id));
  if(!local) throw Error('原 Seedance 任务记录缺失，请核对平台历史；未创建或重新提交任务');
  let result={action:'tracking',message:'沿用原任务继续追踪'};
  if(['failed','submit_unconfirmed'].includes(local.status)) result=await engine.retryTask(local.id) || result;
  bridge.sentStatus.delete(local.id);
  await bridge.syncStatuses();
  bridge.scheduleAutoDownloads();
  return result;
}
module.exports={resumeRemixSeedance};
