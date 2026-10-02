export const DEFAULT_GEM_REQUEST = [
  "请根据本次上传的商品图片，按这个 Gem 的设定生成完整的视频提示词。只输出文字，不要生成图片或视频。",
  "时长：{时长}秒",
  "地区：{地区}",
  "拍摄风格：{拍摄风格}",
].join("\n");

export type GemRequestInput = { duration: number; region: string; shooting_style: string };

// Resolve only documented placeholders, once. Never append hidden instructions.
export function renderGemRequest(template: string, input: GemRequestInput) {
  const values: Record<string, string> = {
    时长: String(input.duration), 地区: input.region, 拍摄风格: input.shooting_style,
  };
  return template.replace(/\{(时长|地区|拍摄风格)\}/g, (_, key: string) => values[key]);
}

export function validateGemRequest(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("请填写发送给 Gem 的文字");
  if (value.length > 12000) throw new Error("发送给 Gem 的文字不能超过 12000 字符");
  return value;
}
