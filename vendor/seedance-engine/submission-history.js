const CHECK_DELAYS = [60_000, 180_000, 600_000];
const UNCONFIRMED_SUBMIT_HINT = '程序会自动到 TikTok 生成历史核对（约 10 分钟内）：找到就继续生成和下载；找不到就可以点“恢复任务”重新提交，不需要删除任务。';
const MISSING_MESSAGE = 'TikTok 生成历史里没有找到这次提交，可以点“恢复任务”重新提交';

function createdAtMs(value) {
  const numeric = Number(value);
  if (/^\d+(?:\.\d+)?$/.test(String(value)) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

// Verified against real fetchHistory(parseSettings:true) on 2026-10-19.
// Values stay in memory; diagnostics never include prompts or image URLs.
function matchSubmissionHistory(task, response) {
  const rows = response?.data?.draft_infos;
  if (!Array.isArray(rows) || response.historyComplete === false) throw new Error('生成历史查询不完整，稍后继续核对');
  const start = Number(task.historyRecovery?.submitStartedAt || task.submitStartedAt);
  if (!Number.isFinite(start) || start <= 0) throw new Error('缺少原始提交开始时间，不能判断是否未生成');
  const expectedImages = [...(task.historyRecovery?.imageUrls || (task.imageItems || []).map(i => i.uploadedUrl).filter(Boolean))].sort();
  const matches = new Map();
  for (const row of rows) {
    const time = createdAtMs(row.createdAt);
    if (!Number.isFinite(time)) throw new Error('生成历史缺少可识别的 createdAt，不能判断是否未生成');
    if (time < start - 120_000 || time > start + 900_000) continue;
    let settings = row.settings;
    try { if (typeof settings === 'string') settings = JSON.parse(settings); } catch { throw new Error('生成历史 settings 无法解析，稍后继续核对'); }
    if (typeof settings?.prompt !== 'string') throw new Error('生成历史缺少 settings.prompt，不能判断是否未生成');
    if (settings.prompt.trim() !== String(task.historyRecovery?.prompt ?? task.prompt ?? '').trim()) continue;
    const images = settings.images;
    if (Array.isArray(images) && images.length) {
      const urls = images.map(i => i.previewUrl || i.imageSrcSet?.origin);
      if (urls.some(url => typeof url !== 'string' || !url) || !expectedImages.length) throw new Error('缺少可核对的原始图片地址，不能判断是否未生成');
      if (JSON.stringify(urls.sort()) !== JSON.stringify(expectedImages)) continue;
    }
    if (!row.taskId) throw new Error('匹配的历史缺少 Task ID，稍后继续核对');
    matches.set(String(row.taskId), row);
  }
  return [...matches.values()];
}

module.exports = { CHECK_DELAYS, UNCONFIRMED_SUBMIT_HINT, MISSING_MESSAGE, matchSubmissionHistory };
