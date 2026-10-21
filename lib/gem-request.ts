import { resolveSpokenLanguage } from './spoken-language.ts';
export const DIRECT_PROMPT_INSTRUCTION = '不要提问，直接按以上信息输出提示词，每条提示词放在单独的代码块里';
export const DEFAULT_GEM_REQUEST = [
  "请根据本次上传的商品图片，按这个 Gem 的设定生成完整的视频提示词。只输出文字，不要生成图片或视频。",
  "时长：{时长}秒",
  "地区：{地区}",
  "口播语言：{口播语言}",
  "拍摄风格：{拍摄风格}",
  DIRECT_PROMPT_INSTRUCTION,
].join("\n");

export type GemRequestInput = { duration: number; region: string; shooting_style: string; spoken_language?: string };

// Resolve only documented placeholders, once. Never append hidden instructions.
export function renderGemRequest(template: string, input: GemRequestInput) {
  const values: Record<string, string> = {
    时长: String(input.duration), 地区: input.region, 拍摄风格: input.shooting_style,
    口播语言: resolveSpokenLanguage(input.region,input.spoken_language),
  };
  return template.replace(/\{(时长|地区|拍摄风格|口播语言)\}/g, (_, key: string) => values[key]);
}

// Also upgrade saved/legacy custom request text at send time, without editing
// the Gem itself or changing the task's frozen images/instructions.
export function buildGemRequest(template: string, input: GemRequestInput) {
  let text=renderGemRequest(template,input);
  const explicit=text.match(/^口播语言[：:]\s*([^\r\n]+)/m)?.[1]?.trim();
  const language=input.spoken_language === undefined && explicit ? explicit : resolveSpokenLanguage(input.region,input.spoken_language);
  if(explicit) text=text.replace(/^口播语言[：:][^\r\n]*/m,`口播语言：${language}`);
  else text+=`\n口播语言：${language}`;
  if(!text.includes(DIRECT_PROMPT_INSTRUCTION))text+='\n'+DIRECT_PROMPT_INSTRUCTION;
  return text;
}

export function validateGemRequest(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("请填写发送给 Gem 的文字");
  if (value.length > 12000) throw new Error("发送给 Gem 的文字不能超过 12000 字符");
  return value;
}
