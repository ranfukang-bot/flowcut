const { createHash } = require('node:crypto');

// Gemini's rendered response can omit Markdown fences, so section headings
// delimit the prompts. Never fall back to sending the entire answer.
function splitDualPrompts(value) {
  const text = String(value || '').replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(/^[ \t#*]*(?:视频|Video)\s*([12１２])\s*[｜|:：·—-][^\n]*$/gim)];
  if (headings.length !== 2 || !/[1１]/.test(headings[0][1]) || !/[2２]/.test(headings[1][1])) {
    throw Error('双段模式需要且只能有一组「视频1｜上半段」和「视频2｜下半段」，请检查 Gem 输出后重新生成提示词');
  }
  return headings.map((heading, index) => {
    let section = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length);
    section = section.split(/\n[ \t#*]*拼接说明[^\n]*\n/)[0].trim();
    const fenced = section.match(/```[^\n]*\n([\s\S]*?)```/);
    const prompt = (fenced ? fenced[1] : section).replace(/^(?:复制代码|Copy code|plaintext|text)\s*\n/i, '').trim();
    if (prompt.length < 300 || !/15\s*(?:秒|s\b)/i.test(prompt)) throw Error(`第 ${index + 1} 段缺少完整的 15 秒提示词，已阻止提交`);
    return prompt;
  });
}

function dualSignature(prompt) { return createHash('sha256').update(prompt).digest('hex'); }
function dualChildren(store, id) { return store.tasks.filter(t => t.flowcutTaskId === id && t.segmentIndex).sort((a,b) => a.segmentIndex-b.segmentIndex); }

async function acceptDualJob(bridge, job) {
  const prompts = splitDualPrompts(job.prompt);
  const signature = dualSignature(job.prompt);
  let children = dualChildren(bridge.store, job.id);
  if (children.some(t => t.dualSignature !== signature)) throw Error('这条双段任务已生成过视频，提示词已变化；请新建任务以保留原视频');
  if (!children.length && bridge.store.tasks.some(t => t.flowcutTaskId === job.id)) throw Error('原任务不是双段任务，请新建双段任务');
  const imagePaths = children.length ? children[0].imageItems.map(i => i.localPath) : await bridge.downloadImages(job);
  for (let index = 1; index <= 2; index++) {
    if (bridge.store.isFlowcutTaskCleared?.(job.id)) return;
    let task = children.find(t => t.segmentIndex === index);
    if (!task) {
      task = bridge.engine.createTask(prompts[index-1], imagePaths, {
        source:'flowcut', flowcutTaskId:job.id, flowcutTaskKind:'standard',
        segmentIndex:index, dualSignature:signature, duration:15,
        tiktokAccountName:job.tiktokAccountName, archiveDirectory:job.archiveDirectory,
        productExternalId:job.productExternalId, managedLocalFiles:imagePaths,
      });
    } else { task.nextComposeAt=0; task.compositionError=''; await bridge.resumeRequeuedTask(task); }
    bridge.sentStatus.delete(`dual:${job.id}`);
  }
  children = dualChildren(bridge.store, job.id);
  await bridge.acknowledge(job.id, children[0]);
}

function dualStatus(children) {
  const first = children[0];
  const labels = {success:'已生成',failed:'失败',submit_unconfirmed:'提交待核对',model_wait:'等待模型额度',upload_wait:'等待上传',uploading:'上传中',queued:'排队中',submitting:'提交中',generating:'生成中',retry_wait:'等待重试'};
  const progress = [1,2].map(i => {
    const task = children.find(t => t.segmentIndex === i);
    return `第 ${i} 段：${task ? (task.lastDownloadedPath ? '已下载' : labels[task.status] || task.status) : '等待创建'}`;
  }).join('；');
  const failed = children.find(t => ['failed','submit_unconfirmed'].includes(t.status));
  const complete = Boolean(first?.combinedPath);
  return {
    action:'status',taskId:first.flowcutTaskId,kind:'standard',providerJobId:first.id,
    providerStatus:complete ? 'success' : failed || first.compositionError ? 'failed' : 'generating',
    outputUrl:'', downloadPath:first.combinedPath || '',
    error: failed ? `第 ${failed.segmentIndex} 段：${failed.errorMessage || failed.activity || '生成失败'}` : first.compositionError || '',
    downloadError:children.map(t=>t.autoDownloadError ? `第 ${t.segmentIndex} 段：${t.autoDownloadError}` : '').filter(Boolean).join('；'),
    segmentProgress:`${progress}；拼接：${complete ? '已完成' : first.compositionError ? '失败，可重试' : children.length === 2 && children.every(t=>t.lastDownloadedPath) ? '处理中' : '等待两段视频'}`,
  };
}
module.exports = {splitDualPrompts,dualSignature,dualChildren,acceptDualJob,dualStatus};
