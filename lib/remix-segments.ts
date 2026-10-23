// Shared by the site and the desktop. This module never reads a page or data.
import { resolveSpokenLanguage } from './spoken-language.ts';

export type RemixRange = { index: number; start: number; end: number; duration: number; header: string };
export type RemixSegment = RemixRange & { text: string };
export const FOLLOW_REFERENCE_LANGUAGE = 'follow-reference';

export function segmentHeader(index: number, start: number, end: number) {
  return `第${index}段｜原视频 ${start}-${end} 秒｜本段时长 ${end - start} 秒`;
}

export function planRemixSegments(value: unknown): { seconds: number | null; segments: RemixRange[] } {
  if (value === null || value === undefined || value === '') return { seconds: null, segments: [] };
  const measured = Number(value);
  if (!Number.isFinite(measured) || measured <= 0) return { seconds: null, segments: [] };
  if (measured > 60) throw new Error('对标视频不能超过 60 秒');
  const seconds = Math.max(4, Math.round(measured));
  const count = Math.ceil(seconds / 15), durations = Array.from({ length: count }, (_, i) => i === count - 1 ? seconds - i * 15 : 15);
  if (count > 1 && durations[count - 1] < 4) {
    const tail = durations[count - 2] + durations[count - 1];
    durations[count - 2] = Math.floor(tail / 2);
    durations[count - 1] = Math.ceil(tail / 2);
  }
  let start = 0;
  return { seconds, segments: durations.map((duration, offset) => {
    const end = start + duration, segment = { index: offset + 1, start, end, duration, header: segmentHeader(offset + 1, start, end) };
    start = end;
    return segment;
  }) };
}

export function remixSegmentsError(message: string) {
  return Object.assign(new Error(message), { code: 'REMIX_SEGMENTS_INVALID' });
}

export function parseSegmentHeader(line: string): RemixRange {
  const match = String(line).trim().match(/^第\s*(\d+)\s*段\s*[｜|]\s*原视频\s*(\d+)\s*[-–—]\s*(\d+)\s*秒\s*[｜|]\s*本段时长\s*(\d+)\s*秒$/);
  if (!match) throw remixSegmentsError('分段代码块第一行格式不正确');
  const [index, start, end, duration] = match.slice(1).map(Number);
  if (!Number.isSafeInteger(index) || index < 1 || ![start, end, duration].every(Number.isSafeInteger) || duration !== end - start || duration < 4 || duration > 15) {
    throw remixSegmentsError(`第 ${index} 段区间或时长不正确，必须为 4–15 整数秒且时长等于终点减起点`);
  }
  return { index, start, end, duration, header: line.trim() };
}

function readSegments(blocks: unknown): RemixSegment[] {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 10) throw remixSegmentsError('必须完整读取 1–10 个分段代码块，未使用正文或部分代码块');
  return blocks.map((block, index) => {
    if (typeof block !== 'string') throw remixSegmentsError(`第 ${index + 1} 个代码块无法读取`);
    const text = block.replace(/\r\n?/g, '\n').trim();
    if (text.length < 300) throw remixSegmentsError(`第 ${index + 1} 个代码块只有 ${text.length} 字，至少需要 300 字`);
    return { ...parseSegmentHeader(text.split('\n')[0]), text };
  });
}

export function validateRemixAnalysis(blocks: unknown, seconds: number | null = null, plan: RemixRange[] = []): RemixSegment[] {
  const segments = readSegments(blocks);
  if (plan.length && segments.length !== plan.length) throw remixSegmentsError(`应输出 ${plan.length} 个完整分段代码块，实际 ${segments.length} 个`);
  segments.forEach((segment, offset) => {
    if (segment.index !== offset + 1 || segment.start !== (offset ? segments[offset - 1].end : 0)) throw remixSegmentsError('分段必须从第 1 段、0 秒开始，序号连续且区间首尾衔接');
    const target = plan[offset];
    if (target && (Math.abs(segment.start - target.start) > 2 || Math.abs(segment.end - target.end) > 2)) throw remixSegmentsError(`第 ${segment.index} 段与计划分段点偏差超过 2 秒`);
  });
  if (seconds !== null && Math.abs(segments.at(-1)!.end - seconds) > 1) throw remixSegmentsError('全部分段没有完整覆盖参考视频总时长（允许 1 秒误差）');
  return segments;
}

export function validateRemixAdaptation(blocks: unknown, expected: RemixRange[], onlyIndex?: number): RemixSegment[] {
  const segments = readSegments(blocks), targets = onlyIndex === undefined ? expected : expected.filter(segment => segment.index === onlyIndex);
  if (!targets.length || segments.length !== targets.length) throw remixSegmentsError(`必须输出 ${targets.length || '指定段的一个'} 个完整代码块`);
  segments.forEach((segment, offset) => {
    const target = targets[offset];
    if (['index', 'start', 'end', 'duration'].some(key => segment[key as keyof RemixRange] !== target[key as keyof RemixRange])) throw remixSegmentsError(`第 ${target.index} 段第一行的序号、区间、时长必须与原脚本一致`);
  });
  return segments;
}

export function remixAnalysisRequest(seconds: number | null, plan: RemixRange[]) {
  return [seconds === null ? '' : `参考视频总时长：${seconds} 秒`, plan.length ? `分段计划：${plan.map(s => `第${s.index}段 原视频 ${s.start}-${s.end} 秒（${s.duration} 秒）`).join('；')}` : '', '不要提问，直接输出。'].filter(Boolean).join('\n');
}

export function remixAdaptationRequest(script: string, input: { productName?: string; region: string; spokenLanguage?: string; segment?: RemixRange; note?: string }) {
  return ['请1：1复刻该视频 包括运镜、动作细节、音效等：', script, '', input.productName?.trim() ? `商品名称：${input.productName.trim()}` : '',
    input.spokenLanguage === FOLLOW_REFERENCE_LANGUAGE ? '' : `口播语言：${resolveSpokenLanguage(input.region, input.spokenLanguage || 'auto')}`,
    '不要提问，直接输出。', input.segment ? `只输出第${input.segment.index}段（原视频 ${input.segment.start}-${input.segment.end} 秒，本段时长 ${input.segment.duration} 秒）。${input.note?.trim() ? `修改说明：${input.note.trim()}` : ''}` : ''].filter((line, index) => line || index === 2).join('\n');
}

export function remixCorrectionRequest(expected: RemixRange[]) {
  return [expected.length ? '应有的每段第一行：\n' + expected.map(segment => segment.header).join('\n') : '每段第一行格式：第N段｜原视频 A-B 秒｜本段时长 D 秒；从 0 秒起首尾相接，按视频实际时长完整分段。',
    '严格按以上分段重新输出全部代码块，代码块之外不写文字。每块至少 300 字。'].join('\n');
}
