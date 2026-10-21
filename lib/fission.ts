import { DEFAULT_GEM_REQUEST, buildSingleGemRequest, validateGemRequest } from './gem-request';
import { resolveSpokenLanguage } from './spoken-language';
import { MIN_PROMPT_LENGTH, validateVariantRequest } from './prompt-blocks';
import { normalizeTaskDuration, normalizeTaskRegion, normalizeShootingStyle } from './task-config';

export const DEFAULT_FISSION_REQUEST = [
  '目标国家：{地区}',
  '以下是母版提示词。请保持母版的结构、节奏和风格，把产品换成本次上传图片中的产品，输出 1 条完整的视频提示词，放在一个代码块中：',
  '{母版提示词}',
].join('\n');

export type FissionInput = {
  requestId?: string;
  products: Array<{ productId: string; imageKeys?: string[] }>;
  motherSource: 'generate' | 'paste';
  motherProductId?: string;
  motherGemId?: string;
  motherPrompt?: string;
  motherRequestTemplate?: string;
  spokenLanguage?: string;
  variantGemId: string;
  variantRequestText?: string;
  duration?: number;
  region?: string;
  shootingStyle?: string;
  tiktokAccountName: string;
  autoQueue?: boolean;
};

export function validateFissionInput(body: FissionInput) {
  if (!Array.isArray(body.products) || body.products.length < 2 || body.products.length > 10) throw Error('请选择 2–10 个商品');
  if (body.products.some(p=>!p || typeof p.productId !== 'string' || !p.productId.trim())) throw Error('每行都必须选择商品');
  if (new Set(body.products.map(p=>p.productId)).size !== body.products.length) throw Error('同一批商品不能重复');
  if (!['generate','paste'].includes(body.motherSource)) throw Error('请选择母版来源');
  if (!body.variantGemId) throw Error('请选择变体 Gem');
  const motherProductId = body.motherProductId || body.products[0].productId;
  if (!body.products.some(p=>p.productId===motherProductId)) throw Error('母版商品必须在本批商品中');
  if (body.motherSource==='generate' && !body.motherGemId) throw Error('请选择母版 Gem');
  const motherPrompt=String(body.motherPrompt||'').trim();
  if (body.motherSource==='paste' && (motherPrompt.length < MIN_PROMPT_LENGTH || motherPrompt.length > 60000)) throw Error('粘贴的母版提示词须为 300–60000 字');
  const duration=normalizeTaskDuration(body.duration);
  if(duration===30) throw Error('多品裂变不支持双段 30 秒');
  const region=normalizeTaskRegion(body.region),shooting_style=normalizeShootingStyle(body.shootingStyle);
  resolveSpokenLanguage(region,body.spokenLanguage);
  const params={duration,region,shooting_style,spoken_language:body.spokenLanguage};
  const variantRequest=buildSingleGemRequest(validateVariantRequest(body.variantRequestText ?? DEFAULT_FISSION_REQUEST),params);
  const motherRequest=buildSingleGemRequest(body.motherSource==='generate' ? validateGemRequest(body.motherRequestTemplate ?? DEFAULT_GEM_REQUEST) : DEFAULT_GEM_REQUEST,params);
  if(body.requestId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.requestId)) throw Error('批次请求标识无效');
  return {duration,region,shooting_style,motherProductId,motherPrompt,variantRequest,motherRequest};
}
