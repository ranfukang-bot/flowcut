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
  constructor({ userData, request, defaultDirectory, shell }) {
    Object.assign(this, { userData, request, defaultDirectory, shell });
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
  async openFolder() {
    const folder = path.join(this.userData, 'review-videos');
    fs.mkdirSync(folder, {recursive:true});
    const error = await this.shell.openPath(folder);
    if (error) throw Error(error);
    return true;
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
        if (within(fs.realpathSync(folder), source)) {
          record = { status: 'released', file: source, legacy: true };
          saveRecord(recordFile, record);
        } else {
          const expectedRoot = reviewDirectory(this.userData, id);
          if (!within(fs.realpathSync(expectedRoot), source)) throw Error('成片不在该任务的待检查目录中');
          if (!/^\d{10,30}$/.test(task.product_external_id || '')) throw Error('商品 ID 不完整，不能送入自动发布目录');
          const file = path.join(folder, '已通过', id, task.product_external_id + '.mp4');
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
