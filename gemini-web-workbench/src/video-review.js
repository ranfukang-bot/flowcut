const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { accountVideoDirectory } = require('../../vendor/seedance-engine/video-download');
const { concatClips: defaultConcatClips } = require('./clip-concat');
const { VIDEO_DONE_STATUSES } = require('../../lib/task-statuses.ts');
const MAX_CONCAT_CLIPS = 10;

function reviewDirectory(userData, taskId) {
  return path.join(userData, 'review-videos', createHash('sha256').update(String(taskId)).digest('hex'));
}
function within(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function saveRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
// Remove only app-owned segment files; never follow links or recurse outside a task.
function cleanupSegments(userData,id) {
  const root=path.resolve(reviewDirectory(userData,id));
  const segments=path.join(root,'segments');
  if (!fs.existsSync(segments)) return;
  if (fs.realpathSync(root)!==root || fs.realpathSync(segments)!==segments) throw Error('分段临时目录含链接，未清理');
  for(const index of [1,2]) {
    const dir=path.join(segments,String(index));
    if(!fs.existsSync(dir)) continue;
    if(fs.realpathSync(dir)!==dir) throw Error('分段目录含链接，未清理');
    // Only the known retry folder belongs to this workflow; never recurse into
    // arbitrary directories or follow a junction to another task's files.
    const retry=path.join(dir,'retry-1');
    const folders=fs.existsSync(retry) ? [retry,dir] : [dir];
    for(const folder of folders) {
      if(fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder)!==folder) throw Error('分段目录含链接，未清理');
    }
    for(const folder of folders) {
      for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
        const file=path.join(folder,entry.name);
        if(entry.isFile() && /\.mp4(?:\.partial)?$/i.test(entry.name) && fs.realpathSync(file)===file) fs.unlinkSync(file);
      }
      try {fs.rmdirSync(folder);} catch(e) {if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code)) throw e;}
    }
  }
  try {fs.rmdirSync(segments);} catch(e) {if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code)) throw e;}
}
function availableReleasePath(folder, productId) {
  if (!/^\d{10,30}$/.test(productId || '')) throw Error('商品 ID 不完整，不能送入自动发布目录');
  for (let n = 1; n <= 9999; n++) {
    const file = path.join(folder, `${productId}${n === 1 ? '' : ` (${n})`}.mp4`);
    if (!fs.existsSync(file) && !fs.existsSync(file + '.partial')) return file;
  }
  throw Error('发布目录同名成片过多');
}
// Keep the destination invisible to the publisher until the move is complete.
// Windows cannot rename across volumes: there copy+flush+delete implements a move.
function moveToStaging(source, temp, io = fs) {
  if (!io.existsSync(source)) {
    if (io.existsSync(temp)) return;
    throw Error('待检查视频不存在，无法移动');
  }
  try { io.renameSync(source, temp); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    io.copyFileSync(source, temp);
    const fd = io.openSync(temp, 'r+');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    if (io.statSync(source).size !== io.statSync(temp).size) throw Error('跨磁盘移动未完成，未放行视频');
    io.unlinkSync(source);
  }
}
class VideoReview {
  constructor({ userData, request, defaultDirectory, shell, beforeDelete = async () => {}, concatClips = defaultConcatClips }) {
    Object.assign(this, { userData, request, defaultDirectory, shell, beforeDelete, concatClips });
    this.locks = new Set();
  }
  concatOutput(concatId) { return path.join(reviewDirectory(this.userData, concatId), 'concat.mp4'); }
  // A clip may only be read from inside its own review folder.
  clipFile(source) {
    if (!/^[\w-]+$/.test(String(source.id || '')) || !source.download_path) throw Error('片段视频尚未下载完成');
    if (path.extname(source.download_path).toLowerCase() !== '.mp4') throw Error('片段不是 MP4 视频');
    const file = fs.realpathSync(source.download_path);
    if (!fs.statSync(file).isFile() || !within(fs.realpathSync(reviewDirectory(this.userData, source.id)), file)) throw Error('片段视频不在该任务的待检查目录中');
    return file;
  }
  // Joins selected clips of one group into a new video waiting for review.
  // The clips are reserved first, so they cannot be approved or deleted while
  // FFmpeg runs; a failure releases them unchanged.
  async concat(groupId, ids, confirmed, concatId = randomUUID()) {
    if (confirmed !== true) throw Error('请确认拼接所选视频');
    if (!/^[\w-]+$/.test(groupId)) throw Error('任务组 ID 无效');
    const sourceIds = Array.isArray(ids) ? ids.map(String) : [];
    if (sourceIds.length < 2 || sourceIds.length > MAX_CONCAT_CLIPS || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => !/^[\w-]+$/.test(id))) {
      throw Error(`请选择 2–${MAX_CONCAT_CLIPS} 条不同的视频进行拼接`);
    }
    const lock = 'concat:' + groupId;
    if (this.locks.has(lock)) throw Error('这一组正在拼接，请勿重复点击');
    this.locks.add(lock);
    const output = this.concatOutput(concatId);
    try {
      const reserved = await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id: groupId, action: 'concat-reserve', concatId, sourceIds, confirmed: true }) });
      try {
        const files = (reserved.sources || []).map(source => this.clipFile(source));
        if (files.length !== sourceIds.length) throw Error('所选视频已变化，请刷新后重试');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        await this.concatClips(files, output);
      } catch (error) {
        try { fs.unlinkSync(output); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; }
        await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id: concatId, action: 'concat-cancel', confirmed: true }) }).catch(() => {});
        throw Error(`拼接未完成，所选视频保持原状：${error.message}`);
      }
      await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id: concatId, action: 'concat-finish', path: output, confirmed: true }) });
      if(reserved.remix) { const approved=await this.approve(concatId,true); await this.cleanupRemix(groupId);return {id:concatId,...approved}; }
      return { id: concatId, file: output };
    } finally { this.locks.delete(lock); }
  }
  // After a concatenated video is approved its clips are used up: remove their
  // files and records. Safe to repeat; anything left is retried on start-up.
  async consumeMerged(concatId) {
    const sources = await this.request('/api/tasks/review?merged=' + encodeURIComponent(concatId));
    for (const source of sources || []) {
      if (source.review_status !== 'merged') continue;
      await this.beforeDelete(source.id);
      const folder = reviewDirectory(this.userData, source.id);
      if (source.download_path && fs.existsSync(source.download_path)) {
        const file = this.clipFile(source);
        fs.unlinkSync(file);
      }
      await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id: source.id, action: 'delete-merged', confirmed: true }) });
      try { fs.rmdirSync(folder); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
  // Start-up recovery: finish or release concatenations interrupted by a
  // restart, and remove clips of concatenated videos approved earlier.
  async recoverConcats() {
    const result = { finished: 0, released: 0, consumed: 0, errors: [] };
    for (const row of await this.request('/api/tasks/review?concat=running') || []) {
      try {
        const output = this.concatOutput(row.id);
        if (fs.existsSync(output) && fs.statSync(output).size > 0) {
          await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id: row.id, action: 'concat-finish', path: output, confirmed: true }) });
          result.finished++;
        } else {
          await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id: row.id, action: 'concat-cancel', confirmed: true }) });
          try { fs.unlinkSync(output + '.partial'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          result.released++;
        }
      } catch (error) { result.errors.push(`${row.id}: ${error.message}`); }
    }
    for (const row of await this.request('/api/tasks/review?concat=consume') || []) {
      try { await this.consumeMerged(row.id); result.consumed++; }
      catch (error) { result.errors.push(`${row.id}: ${error.message}`); }
    }
    for(const row of await this.request('/api/tasks/review?remix=recover') || []) {
      try {await this.finishRemix(row.id,true);} catch(error){result.errors.push(`${row.id}: ${error.message}`);}
    }
    return result;
  }
  async task(id) {
    if (!/^[\w-]+$/.test(id)) throw Error('任务 ID 无效');
    return this.request('/api/tasks/review?id=' + encodeURIComponent(id));
  }
  checkedSource(task) {
    if (!VIDEO_DONE_STATUSES.includes(task.status) || !task.download_path) throw Error('视频尚未下载完成');
    if (path.extname(task.download_path).toLowerCase() !== '.mp4') throw Error('只能打开已归档的 MP4 成片');
    const source = fs.realpathSync(task.download_path);
    if (!fs.statSync(source).isFile()) throw Error('成片文件不存在');
    return source;
  }
  async open(id) {
    const task = await this.task(id);
    const source = this.checkedSource({...task, download_path: task.approved_path || task.download_path});
    const error = await this.shell.openPath(source);
    if (error) throw Error(error);
    return true;
  }
  async openFolder(id = '') {
    const folder = id ? reviewDirectory(this.userData, (await this.task(id)).id) : path.join(this.userData, 'review-videos');
    fs.mkdirSync(folder, {recursive:true});
    const error = await this.shell.openPath(folder);
    if (error) throw Error(error);
    return true;
  }
  async deletePending(id, confirmed) {
    if (confirmed !== true) throw Error('请确认删除该任务及视频');
    if (!/^[\w-]+$/.test(id)) throw Error('任务 ID 无效');
    if (this.locks.has(id)) throw Error('正在处理，请勿重复点击');
    this.locks.add(id);
    try {
      const task = await this.request('/api/tasks/review?id=' + encodeURIComponent(id) + '&optional=1');
      if (!task) { await this.beforeDelete(id); return true; }
      if (!['pending','deleting'].includes(task.review_status) || !VIDEO_DONE_STATUSES.includes(task.status)) throw Error('只能删除待检查的任务及视频，已放行或重做的任务不能这样删除');
      const folder = path.resolve(reviewDirectory(this.userData, id));
      const file = path.resolve(task.download_path || '');
      if (!task.download_path || !within(folder, file) || path.extname(file).toLowerCase() !== '.mp4') throw Error('视频不在该任务的临时存放目录中，未删除');
      if (fs.existsSync(folder) && fs.realpathSync(folder) !== folder) throw Error('临时目录含链接，未删除');
      if (fs.existsSync(file) && (!within(folder, fs.realpathSync(file)) || !fs.statSync(file).isFile())) throw Error('视频路径异常，未删除');
      // Reserve before touching the file so approval/remake cannot race deletion.
      await this.request('/api/tasks/review', {method:'POST',body:JSON.stringify({id,action:'reserve-delete',confirmed:true})});
      // Persist a worker tombstone first: a late callback must not re-download it.
      await this.beforeDelete(id);
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      cleanupSegments(this.userData,id);
      await this.request('/api/tasks/review', {method:'POST',body:JSON.stringify({id,action:'delete-pending',confirmed:true})});
      // Only the now-empty directory belonging to this task is removed.
      try { fs.rmdirSync(folder); } catch (error) { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; }
      return true;
    } finally { this.locks.delete(id); }
  }
  // Only flatten this application's known legacy approval layout, never arbitrary
  // subdirectories. Persist the move target before touching files for restart safety.
  async flattenApproved() {
    const tasks = await this.request('/api/tasks/review?approved=1');
    const result = { moved: 0, errors: [] };
    // Clearing completed tasks must not strand already approved files. Their
    // durable release receipts remain authoritative even when the UI row is gone.
    const reviewRoot = path.join(this.userData, 'review-videos');
    for (const entry of fs.existsSync(reviewRoot) ? fs.readdirSync(reviewRoot,{withFileTypes:true}) : []) {
      if (!entry.isDirectory()) continue;
      const receiptFile = path.join(reviewRoot, entry.name, 'approval.json');
      if (!fs.existsSync(receiptFile)) continue;
      try {
        const receipt = JSON.parse(fs.readFileSync(receiptFile,'utf8'));
        if (receipt.status !== 'released' || !receipt.file) continue;
        const taskDir = path.dirname(receipt.file), parent = path.dirname(taskDir);
        const id = path.basename(taskDir), productId = path.basename(receipt.file,'.mp4');
        if (path.basename(parent) !== '已通过' || !/^[\w-]+$/.test(id) || !/^\d{10,30}$/.test(productId)) continue;
        if (path.resolve(reviewDirectory(this.userData,id)) !== path.resolve(reviewRoot,entry.name) || tasks.some(t=>t.id===id)) continue;
        const existing = await this.request('/api/tasks/review?id='+encodeURIComponent(id)+'&optional=1');
        if (existing) continue;
        tasks.push({id,product_external_id:productId,archive_directory:path.dirname(parent),approved_path:receipt.file,recordOnly:true});
      } catch (error) { result.errors.push(`审核记录 ${entry.name}: ${error.message}`); }
    }
    for (const task of tasks) {
      try {
        const folder = task.archive_directory ? path.resolve(task.archive_directory)
          : accountVideoDirectory(this.defaultDirectory(), task.tiktok_account_name);
        const oldFile = path.join(folder, '已通过', task.id, task.product_external_id + '.mp4');
        if (!task.approved_path || path.resolve(task.approved_path) !== oldFile) continue;
        const recordFile = path.join(reviewDirectory(this.userData, task.id), 'flatten.json');
        let record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : null;
        if (!record) {
          if (!fs.existsSync(oldFile)) continue; // Already published/deleted: never recreate.
          if (fs.realpathSync(oldFile) !== oldFile) throw Error('旧成片路径含链接，未自动移动');
          const file = availableReleasePath(folder, task.product_external_id);
          record = { source: oldFile, file, temp: file + '.partial', status: 'moving' };
          saveRecord(recordFile, record);
        }
        if (record.status === 'moving') {
          moveToStaging(record.source, record.temp);
          record.status = 'committing'; saveRecord(recordFile, record);
        }
        if (record.status === 'committing') {
          if (fs.existsSync(record.temp)) {
            if (fs.existsSync(record.file)) throw Error('目标视频已存在，未覆盖');
            fs.renameSync(record.temp, record.file);
          }
          record.status = 'released'; saveRecord(recordFile, record);
        }
        if (!task.recordOnly) await this.request('/api/tasks/review', {method:'POST', body:JSON.stringify({id:task.id,action:'relocate',oldPath:oldFile,path:record.file,confirmed:true})});
        const approvalFile = path.join(reviewDirectory(this.userData, task.id), 'approval.json');
        if (fs.existsSync(approvalFile)) {
          const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
          saveRecord(approvalFile, {...approval, file:record.file});
        }
        // Nonrecursive: remove only the now-empty directories we created.
        for (const dir of [path.dirname(oldFile), path.join(folder, '已通过')]) {
          try { fs.rmdirSync(dir); } catch (error) { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; }
        }
        result.moved++;
      } catch (error) { result.errors.push(`${task.id}: ${error.message}`); }
    }
    return result;
  }
  async discard(id, replacementId) {
    const replacement = await this.task(replacementId);
    if (!/^[\w-]+$/.test(id) || replacement.regenerated_from_task_id !== id) throw Error('重做任务不匹配');
    const task = await this.request('/api/tasks/review?id=' + encodeURIComponent(id) + '&optional=1');
    if (!task) return true;
    if (replacement.regenerated_from_task_id !== id || task.review_status !== 'replaced') throw Error('新任务尚未成功创建，旧成片未删除');
    if (task.download_path && fs.existsSync(task.download_path)) {
      const source = this.checkedSource(task);
      fs.unlinkSync(source);
    }
    cleanupSegments(this.userData,id);
    await this.request('/api/tasks/review', { method:'POST', body:JSON.stringify({id,replacementId,action:'discard',confirmed:true}) });
    return true;
  }
  async deleteRemixClip(id,confirmed) {
    if(confirmed!==true) throw Error('请确认删除分段及视频');
    const row=await this.request('/api/tasks/review',{method:'POST',body:JSON.stringify({id,action:'remix-reserve-delete-clip',confirmed:true})});
    await this.removeRemixFile(row);
    await this.request('/api/tasks/review',{method:'POST',body:JSON.stringify({id,action:'remix-delete-clip',confirmed:true})});
  }
  async removeRemixFile(row) {
    await this.beforeDelete(row.id);
    if(row.review_status!=='approved' && row.download_path && fs.existsSync(row.download_path)) fs.unlinkSync(this.clipFile(row));
    cleanupSegments(this.userData,row.id);
    const folder=path.resolve(reviewDirectory(this.userData,row.id));
    if(fs.existsSync(folder)) {
      if(fs.realpathSync(folder)!==folder)throw Error('临时目录含链接，未清理');
      for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
        if(!entry.isFile() || !/\.mp4(?:\.partial)?$/i.test(entry.name))continue;
        const file=path.join(folder,entry.name);
        if(fs.realpathSync(file)!==file)throw Error('临时视频含链接，未清理');
        fs.unlinkSync(file);
      }
    }
  }
  async deleteRemix(groupId,confirmed) {
    if(confirmed!==true) throw Error('请确认删除整组和临时视频');
    const group=await this.request('/api/tasks/review',{method:'POST',body:JSON.stringify({id:groupId,action:'remix-delete-reserve',confirmed:true})});
    await this.beforeDelete(groupId);
    for(const row of group.children || []) await this.removeRemixFile(row);
    await this.request('/api/tasks',{method:'DELETE',body:JSON.stringify({id:groupId,remixCleaned:true})});
  }
  async finishRemix(groupId,confirmed) {
    if(confirmed!==true) throw Error('请确认全部分段已检查');
    const prepared=await this.request('/api/tasks/review',{method:'POST',body:JSON.stringify({id:groupId,action:'remix-prepare',confirmed:true})});
    if(prepared.releaseId) {
      const task=await this.task(prepared.releaseId);
      if(task.status==='concat_running') throw Error('正在拼接，请等待完成或重启后恢复');
      const approved=await this.approve(task.id,true,task.task_role==='clip'?groupId:undefined);
      await this.cleanupRemix(groupId);return approved;
    }
    if(prepared.sourceIds.length===1) {
      const reserved=await this.request('/api/tasks/review',{method:'POST',body:JSON.stringify({id:groupId,action:'remix-single-reserve',confirmed:true})});
      const approved=await this.approve(reserved.releaseId,true,groupId);
      await this.cleanupRemix(groupId);return approved;
    }
    return this.concat(groupId,prepared.sourceIds,true);
  }
  async cleanupRemix(groupId) {
    const rows=await this.request('/api/tasks/review?remix=cleanup&group='+encodeURIComponent(groupId));
    for(const row of rows || []) {
      await this.removeRemixFile(row);
      await this.request('/api/tasks/review',{method:'POST',body:JSON.stringify({id:row.id,groupId,action:'remix-delete-unused',confirmed:true})});
      const folder=reviewDirectory(this.userData,row.id);
      try {fs.rmdirSync(folder);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
    }
    await this.request('/api/tasks/review',{method:'POST',body:JSON.stringify({id:groupId,action:'remix-complete',confirmed:true})});
  }
  async approve(id, confirmed, remixGroupId) {
    if (confirmed !== true) throw Error('请二次确认审核通过');
    if (this.locks.has(id)) throw Error('正在处理，请勿重复点击');
    this.locks.add(id);
    try {
      const task = await this.task(id);
      if(task.task_role==='clip' && task.batch_parent_id) {
        const parent=await this.task(task.batch_parent_id);
        if(parent.task_role==='remix' && (remixGroupId!==parent.id || Number(parent.batch_size)!==1 || parent.remix_release_task_id!==id)) throw Error('复刻分段不能单独放行，请检查整组');
      }
      if (task.review_status === 'approved') {
        return { file: task.approved_path, alreadyApproved: true, ...(task.task_role === 'concat' ? await this.consumeAfterApproval(id) : {}) };
      }
      if (!VIDEO_DONE_STATUSES.includes(task.status)) throw Error('视频尚未完成');
      const folder = task.archive_directory ? path.resolve(task.archive_directory)
        : accountVideoDirectory(this.defaultDirectory(), task.tiktok_account_name);
      const recordFile = path.join(reviewDirectory(this.userData, id), 'approval.json');
      await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id, action: 'reserve', confirmed: true, remixGroupId }) });
      let record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : null;
      if (!record) {
        const source = this.checkedSource(task);
        const reviewRoot = path.join(this.userData, 'review-videos');
        if (within(reviewRoot, folder) || path.resolve(folder) === path.resolve(reviewRoot)) throw Error('发布目录不能设置为待检查区');
        fs.mkdirSync(folder, { recursive: true });
        // Legacy files already in the publishing folder are not copied twice.
        if (path.dirname(source) === fs.realpathSync(folder)) {
          record = { status: 'released', file: source, legacy: true };
          saveRecord(recordFile, record);
        } else {
          const expectedRoot = reviewDirectory(this.userData, id);
          if (!within(fs.realpathSync(expectedRoot), source)) throw Error('成片不在该任务的待检查目录中');
          if (!/^\d{10,30}$/.test(task.product_external_id || '')) throw Error('商品 ID 不完整，不能送入自动发布目录');
          const file = availableReleasePath(folder, task.product_external_id);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (fs.existsSync(file)) throw Error('目标文件已存在但没有审核记录，已阻止覆盖');
          const temp = file + '.partial';
          record = { status: 'moving', source, file, temp };
          saveRecord(recordFile, record);
        }
      }
      if (record.status === 'moving') {
        moveToStaging(record.source, record.temp);
        record.status = 'committing'; saveRecord(recordFile, record);
      }
      if (record.status === 'committing') {
        if (!fs.existsSync(record.file)) {
          if (!fs.existsSync(record.temp)) throw Error('上次放行结果待核对，文件可能已被发布程序移走；不会重复投放');
          fs.renameSync(record.temp, record.file);
        }
        record.status = 'released'; saveRecord(recordFile, record);
      }
      // Resume an approval begun by 1.4.19 without leaving its old review copy.
      if (!record.legacy && task.download_path && fs.existsSync(task.download_path)) {
        const source = fs.realpathSync(task.download_path);
        if (within(fs.realpathSync(reviewDirectory(this.userData, id)), source)) fs.unlinkSync(source);
      }
      if (!record.approvedAt) {
        record.approvedAt = new Date().toISOString();
        record.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        saveRecord(recordFile,record);
      }
      await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id, path: record.file, confirmed: true, remixGroupId, approvedAt:record.approvedAt, timeZone:record.timeZone }) });
      cleanupSegments(this.userData,id);
      return { file: record.file, legacy: record.legacy || false, ...(task.task_role === 'concat' ? await this.consumeAfterApproval(id) : {}) };
    } catch (error) {
      if (!fs.existsSync(path.join(reviewDirectory(this.userData, id), 'approval.json'))) {
        await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id, action:'cancel', confirmed:true }) }).catch(() => {});
      }
      throw error;
    } finally { this.locks.delete(id); }
  }
}
// The approval itself already succeeded; leftover clips are retried later.
VideoReview.prototype.consumeAfterApproval = async function consumeAfterApproval(id) {
  try { await this.consumeMerged(id); return {}; }
  catch (error) { return { cleanupWarning: `拼接成片已放行，原片段清理稍后重试：${error.message}` }; }
};
module.exports = { VideoReview, reviewDirectory, moveToStaging, cleanupSegments };
