const { createHash } = require('node:crypto');

function promptError(code, message) {
  return Object.assign(Error(message), {code});
}

// A shot label or narration budget describes a section; it does not start one.
// Keep unknown video headings as boundaries so extra alternatives are rejected.
function isSectionHeading(match) {
  const suffix = match[2].replace(/^[\s*_【\[]+/, '');
  return !/^(?:(?:镜头|分镜|场景|画面|shot|scene)\s*(?:[0-9０-９一二三四五六七八九十]+|[：:]))/i.test(suffix)
    && !/^(?:(?:保留|接续|承接)?(?:末帧|首帧|最后一帧|第一帧)|末句|首句|衔接)/.test(suffix)
    && !/(?:\d+(?:\.\d+)?\s*(?:词|words?\b)|口播预算|朗读|word count)/i.test(suffix);
}

// Rendered code blocks may lose their surrounding headings. Accept either
// section headings or two explicit generation directives, never the whole reply.
function splitDualPrompts(value) {
  const text = String(value || '').replace(/\r\n/g, '\n');
  let headings = [...text.matchAll(/^[ \t#*_]*(?:【|\[)?(?:视频|Video)[ \t]*([12１２一二])[ \t]*[｜|:：·—–-]([^\n]*)$/gim)]
    .filter(isSectionHeading);
  let bodyBoundaries = false;
  if (!headings.length) {
    bodyBoundaries = true;
    headings = [...text.matchAll(/^[ \t]*(?:(?:\d+[.、][ \t]*)?生成任务[：:][ \t]*)?生成一段[^\n]*?\b15(?:\.0+)?[ \t]*秒[^\n]*?(上半段|下半段)[^\n]*$/gm)]
      .map(match => {
        // Include a separate task label / code-block language line in the
        // boundary so it cannot leak into the end of the preceding prompt.
        const prefix = text.slice(0, match.index).match(/(?:[ \t]*(?:```(?:text|plaintext|markdown)|Plaintext|Markdown|text|复制代码|Copy code|【生成任务】|(?:\d+[.、][ \t]*)?生成任务[：:])[ \t]*\n|[ \t]*\n)+$/i);
        return { index: match.index - (prefix?.[0].length || 0), 0:'', 1:match[1] === '上半段' ? '1' : '2' };
      });
  }
  if (headings.length !== 2) {
    throw promptError('DUAL_PROMPT_STRUCTURE', `双段提示词解析失败：识别到 ${headings.length} 个分段，应为上下两段。请在任务详情检查原始输出，保留一组「视频1｜上半段」和「视频2｜下半段」后继续；无需重做已有视频`);
  }
  if (!/[1１一]/.test(headings[0][1]) || !/[2２二]/.test(headings[1][1])) {
    throw promptError('DUAL_PROMPT_ORDER', '双段提示词顺序错误或编号重复：应先视频1（上半段），再视频2（下半段）；已阻止提交');
  }
  return headings.map((heading, index) => {
    let section = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length);
    section = section.split(/\n[ \t#*_]*(?:【|\[)?拼接说明[^\n]*(?:\n|$)/)[0].trim();
    const fenced = section.match(/```[^\n]*\n([\s\S]*?)```/);
    const prompt = (fenced ? fenced[1] : section).replace(/^(?:(?:复制代码|Copy code|plaintext|markdown|text)[ \t]*\n)+/i, '').trim();
    if (prompt.length < 300 || !/\b15(?:\.0+)?\s*(?:秒|s\b)/i.test(prompt)) throw promptError('DUAL_PROMPT_INCOMPLETE', `第 ${index + 1} 段缺少完整的 15 秒提示词（正文 ${prompt.length} 字符），已阻止提交；请检查该段是否被截断或缺少时长说明`);
    if (!bodyBoundaries && /上半段|下半段/.test(heading[0]) && !heading[0].includes(index === 0 ? '上半段' : '下半段')) throw promptError('DUAL_PROMPT_ORDER', '双段标题与上下半段顺序不一致，已阻止提交');
    return prompt;
  });
}

function dualSignature(prompt) { return createHash('sha256').update(prompt).digest('hex'); }
function dualChildren(store, id) {
  const tasks=store.tasks.filter(t => t.flowcutTaskId === id && t.segmentIndex);
  const replaced=new Set(tasks.map(t=>t.segmentRetryOf).filter(Boolean));
  return tasks.filter(t=>!replaced.has(t.id)).sort((a,b) => a.segmentIndex-b.segmentIndex);
}

function regenerateShortSegment(bridge, children, error) {
  if (error?.code!=='DUAL_SEGMENT_TOO_SHORT') return false;
  const task=children.find(t=>t.segmentIndex===error.segmentIndex);
  if (!task || task.status!=='success' || !task.taskId || !task.lastDownloadedPath || Number(task.segmentRegeneration || 0)>=1 || bridge.store.blocked || bridge.store.persistError) return false;
  // Keep the original task, remote ID and file. A deterministic replacement
  // identity makes recovery after a save/notification failure idempotent.
  const id=task.id+'-segment-retry-1';
  if (!bridge.store.tasks.some(t=>t.id===id)) {
    bridge.engine.createTask(task.prompt,task.imageItems.map(i=>i.localPath),{
      id, source:'flowcut', flowcutTaskId:task.flowcutTaskId, flowcutTaskKind:task.flowcutTaskKind || 'standard',
      segmentIndex:task.segmentIndex, dualSignature:task.dualSignature, duration:15,
      segmentRetryOf:task.id, segmentRegeneration:1,
      tiktokAccountName:task.tiktokAccountName, archiveDirectory:task.archiveDirectory,
      productExternalId:task.productExternalId, managedLocalFiles:task.imageItems.map(i=>i.localPath),
      activity:`第 ${task.segmentIndex} 段时长不足，自动补做一次；原片保留`,
    });
  }
  const first=dualChildren(bridge.store,task.flowcutTaskId)[0];
  first.compositionError=''; first.nextComposeAt=0; first.compositionBlocked=false;
  bridge.store.upsertTask(first);
  bridge.sentStatus.delete(`dual:${task.flowcutTaskId}`);
  return true;
}

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
    } else { task.nextComposeAt=0; task.compositionError=''; task.compositionBlocked=false; await bridge.resumeRequeuedTask(task); }
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
module.exports = {splitDualPrompts,dualSignature,dualChildren,acceptDualJob,dualStatus,regenerateShortSegment};
