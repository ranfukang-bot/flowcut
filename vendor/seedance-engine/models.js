// IDs taken from the user's verified Symphony queue v0.9.5.
const FAST_MODEL = '2000012';
const STANDARD_MODEL = '2000004';
const MODEL_OPTIONS = [
  { id: FAST_MODEL, label: 'Seedance 2.0 Fast' },
  { id: STANDARD_MODEL, label: 'Seedance 2.0' },
];
function requireModel(value) {
  const id = String(value || FAST_MODEL);
  if (!MODEL_OPTIONS.some(option => option.id === id)) throw new Error('模型已禁用：仅允许 Seedance 2.0 Fast 和 2.0，禁止 Mini');
  return id;
}
function modelLabel(id) { return MODEL_OPTIONS.find(option => option.id === id)?.label || '未选择模型'; }
function isQuotaError(value) {
  const message = value instanceof Error ? value.message : typeof value === 'object' ? `${value?.code || ''} ${value?.message || ''}` : String(value || '');
  // Rate/concurrency limits must wait; they are not evidence that daily credits ran out.
  if (/concurren|simultaneous|rate.?limit|频繁|并发|同时/i.test(message)) return false;
  return /quota|daily.{0,35}(?:limit|exceed|maximum|used|exhaust)|(?:limit|exceed|maximum).{0,25}(?:daily|today)|insufficient.{0,15}credit|credits?.{0,25}(?:insufficient|exhaust|not enough|limit)|(?:今日|当天|每日).{0,20}(?:上限|额度|次数|用完)|额度.{0,15}(?:不足|用完|耗尽|上限)|积分不足/i.test(message);
}
module.exports = { FAST_MODEL, STANDARD_MODEL, MODEL_OPTIONS, requireModel, modelLabel, isQuotaError };
