const fs = require('node:fs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {probe, mediaTool} = require('./dual-video-composer');
const run = promisify(execFile);

// A clip keeps its own length. Picture and sound are padded to the longer of
// the two; a large mismatch means a damaged clip and is reported, not hidden.
function clipTiming(media, index) {
  const seconds = stream => {
    const direct = Number(stream?.duration);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const [n, d] = String(stream?.time_base || '').split('/').map(Number);
    const ticks = Number(stream?.duration_ts) * n / d;
    if (Number.isFinite(ticks) && ticks > 0) return ticks;
    return Number(media.format?.duration);
  };
  const video = media.streams.find(s => s.codec_type === 'video');
  const audio = media.streams.find(s => s.codec_type === 'audio');
  const videoDuration = seconds(video), audioDuration = audio ? seconds(audio) : 0;
  const duration = Math.max(videoDuration, audioDuration);
  if (!video || !Number.isFinite(videoDuration) || videoDuration <= 0 || !Number.isFinite(duration) || (audio && (!Number.isFinite(audioDuration) || audioDuration <= 0))) {
    throw Error(`第 ${index} 条视频无法读取有效时长，请检查视频`);
  }
  if (duration < 1 || duration > 120) throw Error(`第 ${index} 条视频时长 ${duration.toFixed(2)} 秒，超出可拼接范围`);
  if (audio && Math.abs(videoDuration - audioDuration) > 0.8) {
    throw Error(`第 ${index} 条视频画面与声音时长差异过大（画面 ${videoDuration.toFixed(2)} 秒，声音 ${audioDuration.toFixed(2)} 秒），请检查视频`);
  }
  return {duration: Math.round(duration * 1000) / 1000, hasAudio: Boolean(audio)};
}

// Joins clips in the given order with natural hard cuts, normalised to one
// 1080x1920 / 30 fps / 48 kHz stereo stream. The result is written to a
// temporary file, checked, and only then renamed to the output path.
async function concatClips(files, output, {signal, timeoutMs = 20 * 60_000} = {}) {
  if (!Array.isArray(files) || files.length < 2) throw Error('至少需要 2 条视频才能拼接');
  const media = await Promise.all(files.map(file => probe(file, signal)));
  const timing = media.map((item, index) => clipTiming(item, index + 1));
  const inputs = files.flatMap(file => ['-i', file]);
  const filters = [];
  let silent = files.length;
  timing.forEach((clip, i) => {
    const d = clip.duration;
    filters.push(`[${i}:v:0]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS[v${i}]`);
    if (clip.hasAudio) {
      filters.push(`[${i}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      inputs.push('-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=48000:cl=stereo');
      filters.push(`[${silent}:a:0]atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);
      silent += 1;
    }
  });
  filters.push(`${timing.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${files.length}:v=1:a=1[v][a]`);
  const total = timing.reduce((sum, clip) => sum + clip.duration, 0);
  const temp = output + '.partial';
  try {
    await run(mediaTool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
      '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(total), '-f', 'mp4', temp],
    {windowsHide: true, signal, timeout: timeoutMs, maxBuffer: 1024 * 1024});
    const result = await probe(temp, signal);
    const actual = Number(result.format.duration);
    if (!Number.isFinite(actual) || Math.abs(actual - total) > 0.3) {
      throw Error(`拼接成片时长校验失败（应为 ${total.toFixed(2)} 秒，实际 ${Number.isFinite(actual) ? actual.toFixed(2) : '未知'} 秒）`);
    }
    signal?.throwIfAborted?.();
    fs.renameSync(temp, output);
    return {file: output, duration: total};
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') console.error(error); }
  }
}

module.exports = {concatClips, clipTiming};
