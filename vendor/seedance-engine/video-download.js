const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const WINDOWS_RESERVED_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function accountVideoDirectory(rootDirectory, accountName) {
  const name = String(accountName || '').trim();
  if (!name) throw new Error('任务没有选择 TK 归档账号');
  if (
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    WINDOWS_RESERVED_NAMES.test(name)
  ) {
    throw new Error(`TK 账号名“${name}”不能作为 Windows 文件夹名称`);
  }
  return path.join(path.resolve(rootDirectory), name);
}

function buildVideoFilename(task) {
  const prompt = String(task?.prompt || 'Seedance视频')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  const id = String(task?.taskId || task?.id || '').slice(-12);
  return `${prompt || 'Seedance视频'}${id ? `-${id}` : ''}.mp4`;
}

function buildArchivedVideoFilename(task) {
  const rawProductId = String(task?.productExternalId || '').trim();
  if (!rawProductId) return buildVideoFilename(task);

  let safeProductId = rawProductId
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 160);
  if (!safeProductId) return buildVideoFilename(task);
  if (WINDOWS_RESERVED_NAMES.test(safeProductId)) {
    safeProductId = `_${safeProductId}`;
  }
  return `${safeProductId}.mp4`;
}

async function availableVideoPath(directory, filename) {
  const extension = path.extname(filename) || '.mp4';
  const base = path.basename(filename, extension);
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = path.join(
      directory,
      index === 1 ? `${base}${extension}` : `${base} (${index})${extension}`,
    );
    try {
      await fsp.access(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error('下载目录中同名视频过多');
}

function notReady() {
  return Object.assign(new Error('视频仍在渲染或下载文件尚未就绪，完成后将自动重试下载'), { code: 'VIDEO_NOT_READY' });
}

async function verifyMp4(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let offset = 0;
    const seen = new Set();
    while (offset < size) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) throw notReady();
      let length = header.readUInt32BE(0), minimum = 8;
      const type = header.toString('ascii', 4, 8);
      if (length === 1) { if (bytesRead < 16) throw notReady(); length = Number(header.readBigUInt64BE(8)); minimum = 16; }
      else if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < minimum || offset + length > size) throw notReady();
      seen.add(type); offset += length;
    }
    if (!seen.has('ftyp') || !seen.has('moov') || !seen.has('mdat')) throw notReady();
  } finally { await handle.close(); }
}

function originalVideoFilename(response, url) {
  const disposition = String(response?.headers?.get?.('content-disposition') || '');
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const ordinary = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  let name = encoded || ordinary?.[1] || ordinary?.[2] || '';
  if (!name) { try { name = new URL(url).pathname.split('/').pop() || ''; } catch {} }
  try { name = decodeURIComponent(name.trim()); } catch {}
  name = path.win32.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!/\.mp4$/i.test(name) || name.length > 180 || WINDOWS_RESERVED_NAMES.test(name)) return '';
  return name;
}

async function downloadVideo(url, destination, fetchVideo, onProgress = () => {}, options = {}) {
  if (!url) throw new Error('任务没有可下载的视频地址');
  if (!destination) throw new Error('没有选择保存位置');
  if (typeof fetchVideo !== 'function') throw new Error('下载组件未初始化');

  const directory = path.dirname(destination);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destination)}.${crypto.randomUUID()}.part`,
  );
  await fsp.mkdir(directory, { recursive: true });

  try {
    const response = await fetchVideo(url);
    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
    if ([202, 204, 425].includes(response?.status) || /json|text\/|html/.test(contentType)) {
      await response?.body?.cancel().catch(() => {});
      throw notReady();
    }
    if (!response?.ok) {
      throw new Error(`视频服务器返回 HTTP ${response?.status || '未知状态'}`);
    }
    if (!response.body) throw new Error('视频服务器没有返回文件内容');
    if (options.preserveOriginalName) {
      const originalName = originalVideoFilename(response, url);
      if (originalName) destination = path.join(directory, originalName);
    }

    const totalBytes = Number(response.headers?.get?.('content-length') || 0);
    let receivedBytes = 0;
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        onProgress({ receivedBytes, totalBytes });
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      fs.createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    if (!receivedBytes || (totalBytes && receivedBytes !== totalBytes)) throw notReady();
    await verifyMp4(temporaryPath);
    // Atomic creation prevents simultaneous videos for one product overwriting each other.
    const requested = destination;
    for (;;) {
      try {
        try { await fsp.link(temporaryPath, destination); }
        catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
          await fsp.copyFile(temporaryPath, destination, fs.constants.COPYFILE_EXCL);
        }
        break;
      }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        destination = await availableVideoPath(directory, path.basename(requested));
      }
    }
    await fsp.unlink(temporaryPath);
    return { destination, receivedBytes, totalBytes };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  accountVideoDirectory,
  availableVideoPath,
  buildArchivedVideoFilename,
  buildVideoFilename,
  downloadVideo,
  verifyMp4,
  originalVideoFilename,
};
