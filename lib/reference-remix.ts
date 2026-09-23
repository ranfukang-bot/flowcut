import internalGem from "./reference-remix-gem.txt?raw";

export const REFERENCE_REMIX_GEM_NAME = "爆款视频结构复刻智能体";
export const REFERENCE_REMIX_DURATIONS = [5, 10, 15] as const;
export const DEFAULT_REFERENCE_REMIX_DURATION = 15;
export const DEFAULT_REFERENCE_REMIX_REGION = "马来西亚";

export function normalizeReferenceRemixDuration(value: unknown) {
  const duration = Number(value ?? DEFAULT_REFERENCE_REMIX_DURATION);
  if (!REFERENCE_REMIX_DURATIONS.includes(duration as 5 | 10 | 15)) {
    throw new Error("Seedance 当前只支持 5、10 或 15 秒，请重新选择");
  }
  return duration;
}

export function normalizeReferenceRemixRegion(value: unknown) {
  const region = String(value || DEFAULT_REFERENCE_REMIX_REGION).trim();
  if (!region) throw new Error("请填写投放地区");
  if (region.length > 40) throw new Error("投放地区不能超过 40 个字符");
  return region;
}

function applyDuration(text: string, duration: number) {
  return text
    .replace(/15\s*秒/g, `${duration}秒`)
    .replace(/15\s*s\b/gi, `${duration}s`);
}

export function buildReferenceAnalysisPrompt(durationValue: unknown, regionValue: unknown) {
  const duration = normalizeReferenceRemixDuration(durationValue);
  const region = normalizeReferenceRemixRegion(regionValue);
  const configuredGem = applyDuration(internalGem.trim(), duration);
  return `${configuredGem}

---

本次是爆款复刻流程的第一步。请严格分析本条上传的对标视频，并输出一份可供下一轮继续改编的“爆款结构蓝图”。

投放地区：${region}
最终目标时长：${duration}秒

这一轮只拆解对标视频的脚本结构、场景、动作细节、画面内容、镜头运镜方式、口播文案结构与节奏，不要提前改写成其他产品，不要结束本次对话。直接输出结构分析结果。`;
}

export function buildReferenceAdaptationPrompt(durationValue: unknown, regionValue: unknown) {
  const duration = normalizeReferenceRemixDuration(durationValue);
  const region = normalizeReferenceRemixRegion(regionValue);
  return `严格分析上传的视频的脚本结构、场景、动作细节、画面内容、镜头运镜方式、口播文案并分析${region}的TIKTOK平台喜好，根据我上传的产品图去分析产品的卖点和爆点并参考以上的元素生成一份结构、画面内容、口播文案结构一致的脚本，口播要标准的${region}本地语言，场景尽量都要在真实的日常场景内，请完全参照对标视频的口播文案结构与画面内容结构，画面内容和口播文案根据产品的卖点完善！脚本调整至${duration}秒，卖点部分根据目标时长合理安排，卖点展示部分要根据产品的核心卖点进行口播文案的修改，不要生搬硬套。直接输出最终可用于 Seedance 2.0 的提示词。`;
}

export function referenceRemixGemPreview() {
  return {
    name: REFERENCE_REMIX_GEM_NAME,
    content: internalGem,
    locked: true,
  };
}
