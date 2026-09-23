export const TASK_DURATIONS = [5, 10, 15] as const;

export const TASK_REGIONS = [
  "印尼",
  "马来西亚",
  "泰国",
  "越南",
  "菲律宾",
  "新加坡",
] as const;

export const SHOOTING_STYLES = [
  "iPhone实拍质感",
  "安卓手机实拍质感",
  "第一人称POV实拍",
  "居家自然光实拍",
  "TikTok达人手持实拍",
] as const;

export const DEFAULT_TASK_DURATION = 15;
export const DEFAULT_TASK_REGION = "印尼";
export const DEFAULT_SHOOTING_STYLE = "iPhone实拍质感";

export function normalizeTaskDuration(value: unknown) {
  const duration = Number(value);
  return TASK_DURATIONS.includes(
    duration as (typeof TASK_DURATIONS)[number]
  )
    ? duration
    : DEFAULT_TASK_DURATION;
}

export function normalizeTaskRegion(value: unknown) {
  const region = String(value || "").trim();
  if (!region) return DEFAULT_TASK_REGION;
  if (region.length > 40) throw new Error("地区名称不能超过 40 个字符");
  return region;
}

export function normalizeShootingStyle(value: unknown) {
  const style = String(value || "").trim();
  if (!style) return DEFAULT_SHOOTING_STYLE;
  if (style.length > 80) throw new Error("拍摄风格不能超过 80 个字符");
  return style;
}
