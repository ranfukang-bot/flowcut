const fs = require('node:fs');
const path = require('node:path');

// Windows antivirus, indexing and backup tools briefly lock recently written
// files. Node reports those locks as EPERM/EBUSY/EACCES on open or rename.
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']);
const DEFAULT_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800];
// Once a store is already failing, keep later saves from freezing the UI.
const QUICK_RETRY_DELAYS_MS = [50];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFsRetry(operation, delays = DEFAULT_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT_FS_CODES.has(error?.code) || attempt >= delays.length) throw error;
      sleepSync(delays[attempt]);
    }
  }
}

function backupPath(file) {
  return `${file}.bak`;
}

function temporaryPath(file) {
  return `${file}.tmp`;
}

// The data reaches the disk before it replaces the previous file, so a crash
// at any point leaves at least one complete copy: the primary, the temporary
// file or the backup.
//   backup 'rotate': the previous complete primary becomes the backup (one
//                    save behind, no extra write; for large, busy files).
//   backup 'mirror': the backup is rewritten with the same content after the
//                    primary (for small files whose latest change matters).
function writeTextDurable(file, text, { delays = DEFAULT_RETRY_DELAYS_MS, backup = 'rotate' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = temporaryPath(file);
  withFsRetry(() => {
    const descriptor = fs.openSync(temporary, 'w');
    try {
      fs.writeFileSync(descriptor, text, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }, delays);
  if (backup === 'rotate' && fs.existsSync(file)) {
    try {
      withFsRetry(() => fs.renameSync(file, backupPath(file)), delays);
    } catch {
      // The older backup stays valid; replacing the primary below still works.
    }
  }
  withFsRetry(() => fs.renameSync(temporary, file), delays);
  if (backup === 'mirror') {
    try {
      writeTextDurable(backupPath(file), text, { delays, backup: 'none' });
    } catch {
      // The previous backup is still a complete, valid copy.
    }
  }
}

function readCandidate(file, validate) {
  let text;
  try {
    text = withFsRetry(() => fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, status: 'missing' };
    return { file, status: 'unreadable', error };
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    const problem = validate(value);
    if (problem) return { file, status: 'invalid', error: new Error(problem) };
    return { file, status: 'ok', value };
  } catch (error) {
    return { file, status: 'invalid', error };
  }
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Moves the damaged primary out of the way so later saves (which rotate the
// primary into the backup) can never replace the last valid backup with it.
function preserveDamagedFile(file, date) {
  const extension = path.extname(file);
  const base = file.slice(0, file.length - extension.length);
  for (let index = 0; index < 100; index += 1) {
    const candidate = `${base}.corrupt-${timestamp(date)}${index ? `-${index}` : ''}${extension}`;
    if (fs.existsSync(candidate)) continue;
    withFsRetry(() => fs.renameSync(file, candidate));
    return candidate;
  }
  throw new Error('损坏文件的保留副本过多');
}

// status:
//   loaded     primary file is valid
//   recovered  primary missing/damaged, a validated temporary/backup copy was used
//   fresh      no state file and no other local data: a genuine first start
//   blocked    nothing valid to load; nothing was written or renamed
function loadJsonState({ file, validate, priorDataPaths = [], now = () => new Date() }) {
  const primary = readCandidate(file, validate);
  if (primary.status === 'ok') return { status: 'loaded', value: primary.value, source: file };
  // A locked file may hold newer data than any backup; never replace it.
  if (primary.status === 'unreadable') {
    return { status: 'blocked', reason: 'unreadable', file, error: primary.error };
  }
  const fallbacks = [temporaryPath(file), backupPath(file)].map((candidate) =>
    readCandidate(candidate, validate),
  );
  const recovered = fallbacks.find((candidate) => candidate.status === 'ok');
  if (recovered) {
    let preserved = '';
    if (primary.status === 'invalid') {
      try {
        preserved = preserveDamagedFile(file, now());
      } catch (error) {
        return { status: 'blocked', reason: 'preserve-failed', file, error };
      }
    }
    return {
      status: 'recovered',
      value: recovered.value,
      source: recovered.file,
      damage: primary.status,
      damageError: primary.error,
      preserved,
    };
  }
  if (primary.status === 'missing' && fallbacks.every((candidate) => candidate.status === 'missing')) {
    const prior = priorDataPaths.find((candidate) => candidate && fs.existsSync(candidate));
    if (!prior) return { status: 'fresh' };
    return { status: 'blocked', reason: 'missing', file, prior };
  }
  return {
    status: 'blocked',
    reason: primary.status === 'missing' ? 'backups-invalid' : 'invalid',
    file,
    error: primary.error || fallbacks.find((candidate) => candidate.error)?.error,
  };
}

function describeBlockedState(result, label) {
  const file = result.file;
  const name = path.basename(file);
  const detail = result.error ? `（${result.error.message}）` : '';
  if (result.reason === 'unreadable') {
    return `无法读取${label}：${file}${detail}。可能被杀毒或备份软件占用。为避免覆盖其中的数据，FlowCut 已停止启动，文件没有被修改。请稍后重新打开 FlowCut；如果持续出现，请把 FlowCut 数据文件夹加入杀毒软件白名单。`;
  }
  if (result.reason === 'missing') {
    return `找不到${label}：${file}，但本机已有 FlowCut 数据（${result.prior}）。为避免生成新密钥导致已保存的账号和凭证无法使用，FlowCut 已停止启动，没有写入任何文件。如果刚换电脑，请把旧电脑同一位置的 ${name} 复制过来后重新打开。`;
  }
  if (result.reason === 'preserve-failed') {
    return `${label}已损坏（${file}），并且无法保留损坏文件${detail}。为避免覆盖，FlowCut 已停止启动。请关闭占用该文件的程序后重新打开。`;
  }
  return `${label}已损坏且没有可用备份：${file}${detail}。为避免清空账号或更换密钥，FlowCut 已停止启动，原文件保持不变。请关闭 FlowCut，用其他备份（例如旧电脑同一位置的 ${name}）替换该文件后重新打开；不要删除 FlowCut 数据文件夹。`;
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  QUICK_RETRY_DELAYS_MS,
  TRANSIENT_FS_CODES,
  backupPath,
  describeBlockedState,
  loadJsonState,
  temporaryPath,
  withFsRetry,
  writeTextDurable,
};
