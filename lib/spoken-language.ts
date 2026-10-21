// Add a region here to make it available in both the region and language menus.
export const REGION_SPOKEN_LANGUAGES: Record<string, string> = {
  菲律宾: 'Taglish', 印尼: '印尼语', 马来西亚: '马来语', 泰国: '泰语', 越南: '越南语',
  新加坡: '英语', 墨西哥: '西班牙语（墨西哥）', 巴西: '葡萄牙语（巴西）', 美国: '英语',
};
export const UNKNOWN_REGION_LANGUAGE = '该地区最常用的本地日常口语';
export const SPOKEN_LANGUAGE_OPTIONS = [...new Set([...Object.values(REGION_SPOKEN_LANGUAGES), '中文'])];
export function resolveSpokenLanguage(region: string, selection: unknown = 'auto') {
  if (selection === undefined || selection === 'auto') return Object.hasOwn(REGION_SPOKEN_LANGUAGES,region.trim()) ? REGION_SPOKEN_LANGUAGES[region.trim()] : UNKNOWN_REGION_LANGUAGE;
  if (selection === UNKNOWN_REGION_LANGUAGE && !Object.hasOwn(REGION_SPOKEN_LANGUAGES,region.trim())) return UNKNOWN_REGION_LANGUAGE;
  if (typeof selection !== 'string' || !SPOKEN_LANGUAGE_OPTIONS.includes(selection)) throw new Error('请选择自动或列表中的口播语言');
  return selection;
}
export function requestSpokenLanguage(text: string, region: string) {
  return text.match(/^口播语言[：:]\s*([^\r\n]+)/m)?.[1]?.trim() || resolveSpokenLanguage(region);
}
