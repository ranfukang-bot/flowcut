const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {loadJsonState, writeTextDurable} = require('../../vendor/seedance-engine/durable-json');
const {verifyMp4} = require('../../vendor/seedance-engine/video-download');
const {reviewDirectory} = require('./video-review');

function receiptPath(userData, task) {
  const key = createHash('sha256').update(JSON.stringify([task.id, task.taskId || ''])).digest('hex');
  return path.join(userData, 'seedance', 'deliveries', key + '.json');
}
function readRecord(file) {
  const result = loadJsonState({file, validate: value => value && typeof value.file === 'string' && path.isAbsolute(value.file) ? '' : '无效的成片交付记录'});
  if (result.status === 'blocked') throw Error('成片交付记录无法读取，已阻止重复下载：' + file);
  return result.value;
}
function rememberDelivery(userData, task, file) {
  const record = {file, deliveredAt:task.lastDownloadedAt || Date.now()};
  writeTextDurable(receiptPath(userData,task),JSON.stringify(record),{backup:'mirror'});
  return record;
}
async function completedDelivery(userData, task) {
  // Delivery remains complete after review, publishing, moving or deleting the
  // file. A missing old path or a changed archive folder is not a new download.
  const receipt = readRecord(receiptPath(userData,task));
  if (receipt) return receipt;
  const standard = task.flowcutTaskId && (!task.flowcutTaskKind || task.flowcutTaskKind === 'standard');
  if (standard) {
    const approval = readRecord(path.join(reviewDirectory(userData,task.flowcutTaskId),'approval.json'));
    if (approval?.status === 'released') return {file:approval.file, deliveredAt:Date.parse(approval.approvedAt) || Date.now()};
    if (approval) throw Error('成片正在审核归档，已阻止重复下载');
  }
  if (task.lastDownloadedPath && (task.lastDownloadedAt || task.reviewDownload)) return {file:task.lastDownloadedPath,deliveredAt:task.lastDownloadedAt || Date.now()};
  if (standard) {
    const folder = reviewDirectory(userData,task.flowcutTaskId);
    if (!fs.existsSync(folder)) return null;
    // Recover the small crash window between a complete download and its receipt.
    const files = fs.readdirSync(folder,{withFileTypes:true}).filter(entry=>entry.isFile() && /\.mp4$/i.test(entry.name));
    if (files.length > 1) throw Error('待检查目录存在多份成片，请核对后继续；不会继续重复下载');
    if (files.length) {
      const file = path.join(folder,files[0].name);
      await verifyMp4(file);
      return {file,deliveredAt:fs.statSync(file).mtimeMs};
    }
  }
  return null;
}
module.exports = {completedDelivery, rememberDelivery, receiptPath};
