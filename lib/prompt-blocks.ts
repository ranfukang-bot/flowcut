// One Markdown code block in a Gemini reply is one complete video prompt.
// Text and tables outside code blocks are commentary and never sent onward.
export const MAX_PROMPT_BLOCKS = 10;
export const MIN_PROMPT_LENGTH = 300;
export const RAW_REPLY_NOTE = "未识别到代码块，按整段回复处理";

// raw:    legacy dual 30-second tasks; the dual parser reads the whole reply.
// single: the first round of a two-round variant task produces one mother prompt.
// split:  every code block becomes its own video task.
export type PromptBlockMode = "raw" | "single" | "split";

export type PromptBlockResult = { prompts: string[]; note: string };

export function promptBlocksError(message: string) {
  return Object.assign(new Error(message), { code: "PROMPT_BLOCKS_INVALID" });
}

// Rendered Gemini code blocks show a language label ("Plaintext") and copy
// controls. Seeing them while no block was read means extraction failed and
// the whole reply must not be passed off as one prompt.
export function replyMentionsCodeBlocks(text: string) {
  return /```|^[ \t]*(?:Plaintext|Markdown|Code snippet|代码段|复制代码|Copy code)[ \t]*$/im.test(String(text || ""));
}

function normalizeBlock(value: unknown) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

export function splitPromptBlocks(input: {
  text: string;
  blocks?: unknown;
  hint?: boolean;
  mode?: PromptBlockMode;
  singleLabel?: string;
}): PromptBlockResult {
  const text = String(input.text || "").trim();
  const mode = input.mode || "split";
  if (mode === "raw") {
    if (text.length < MIN_PROMPT_LENGTH) throw promptBlocksError(`Gemini 返回内容只有 ${text.length} 字，不是完整 Seedance 提示词，已阻止进入下一步`);
    return { prompts: [text], note: "" };
  }
  const blocks = (Array.isArray(input.blocks) ? input.blocks : []).map(normalizeBlock).filter(Boolean);
  if (!blocks.length) {
    if (input.hint || replyMentionsCodeBlocks(text)) {
      throw promptBlocksError("Gemini 回复里有代码框，但程序没有读到其中的内容；已停止，不会把整段回复当作提示词提交");
    }
    if (text.length < MIN_PROMPT_LENGTH) throw promptBlocksError(`Gemini 返回内容只有 ${text.length} 字，不是完整 Seedance 提示词，已阻止进入下一步`);
    return { prompts: [text], note: RAW_REPLY_NOTE };
  }
  if (blocks.length > MAX_PROMPT_BLOCKS) {
    throw promptBlocksError(`识别到 ${blocks.length} 个代码块，超过上限 ${MAX_PROMPT_BLOCKS} 个；整轮未拆分、未提交`);
  }
  if (mode === "single" && blocks.length > 1) {
    throw promptBlocksError(input.singleLabel
      ? `${input.singleLabel} 输出了 ${blocks.length} 个代码块；本轮只能是 1 条提示词，请只输出一个代码块`
      : `母版 Gem 输出了 ${blocks.length} 个代码块；母版只能是 1 条提示词，请让母版 Gem 只输出一个代码块`);
  }
  const seen = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (block.length < MIN_PROMPT_LENGTH) {
      throw promptBlocksError(`第 ${index + 1} 个代码块只有 ${block.length} 字（至少 ${MIN_PROMPT_LENGTH} 字）；整轮未拆分、未提交`);
    }
    const key = block.replace(/\s+/g, " ");
    const previous = seen.get(key);
    if (previous) throw promptBlocksError(`第 ${previous} 个和第 ${index + 1} 个代码块内容相同；整轮未拆分、未提交`);
    seen.set(key, index + 1);
  });
  return { prompts: blocks, note: "" };
}

// The second round needs the mother prompt; never send it without one.
export const MOTHER_PROMPT_PLACEHOLDER = "{母版提示词}";
export const DEFAULT_VARIANT_REQUEST = [
  "目标国家：{地区}",
  "以下是母版提示词，请根据母版和产品图片输出视频提示词，每条提示词放在一个独立代码块中：",
  MOTHER_PROMPT_PLACEHOLDER,
].join("\n");

export function validateVariantRequest(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("请填写第二轮发送给变体 Gem 的文字");
  if (value.length > 12000) throw new Error("第二轮文字不能超过 12000 字符");
  if (!value.includes(MOTHER_PROMPT_PLACEHOLDER)) throw new Error(`第二轮文字必须包含 ${MOTHER_PROMPT_PLACEHOLDER}，否则变体 Gem 收不到母版`);
  return value;
}

export function renderVariantRequest(template: string, motherPrompt: string) {
  return String(template).split(MOTHER_PROMPT_PLACEHOLDER).join(String(motherPrompt).trim());
}
