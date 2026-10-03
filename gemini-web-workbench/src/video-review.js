const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { accountVideoDirectory } = require('../../vendor/seedance-engine/video-download');

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
  constructor({ userData, request, defaultDirectory, shell, beforeDelete = async () => {} }) {
    Object.assign(this, { userData, request, defaultDirectory, shell, beforeDelete });
    this.locks = new Set();
  }
  async task(id) {
    if (!/^[\w-]+$/.test(id)) throw Error('任务 ID 无效');
    return this.request('/api/tasks/review?id=' + encodeURIComponent(id));
  }
  checkedSource(task) {
    if (!['video_ready', 'scheduled'].includes(task.status) || !task.download_path) throw Error('视频尚未下载完成');
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
      if (!['pending','deleting'].includes(task.review_status) || !['video_ready','scheduled'].includes(task.status)) throw Error('只能删除待检查的任务及视频，已放行或重做的任务不能这样删除');
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
    await this.request('/api/tasks/review', { method:'POST', body:JSON.stringify({id,replacementId,action:'discard',confirmed:true}) });
    return true;
  }
  async approve(id, confirmed) {
    if (confirmed !== true) throw Error('请二次确认审核通过');
    if (this.locks.has(id)) throw Error('正在处理，请勿重复点击');
    this.locks.add(id);
    try {
      const task = await this.task(id);
      if (task.review_status === 'approved') return { file: task.approved_path, alreadyApproved: true };
      if (!['video_ready', 'scheduled'].includes(task.status)) throw Error('视频尚未完成');
      const folder = task.archive_directory ? path.resolve(task.archive_directory)
        : accountVideoDirectory(this.defaultDirectory(), task.tiktok_account_name);
      const recordFile = path.join(reviewDirectory(this.userData, id), 'approval.json');
      await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id, action: 'reserve', confirmed: true }) });
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
      await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id, path: record.file, confirmed: true, approvedAt:record.approvedAt, timeZone:record.timeZone }) });
      return { file: record.file, legacy: record.legacy || false };
    } catch (error) {
      if (!fs.existsSync(path.join(reviewDirectory(this.userData, id), 'approval.json'))) {
        await this.request('/api/tasks/review', { method: 'POST', body: JSON.stringify({ id, action:'cancel', confirmed:true }) }).catch(() => {});
      }
      throw error;
    } finally { this.locks.delete(id); }
  }
}
module.exports = { VideoReview, reviewDirectory, moveToStaging };
