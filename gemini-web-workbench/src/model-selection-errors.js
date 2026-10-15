const { modelSettingsKey } = require('./gemini-model-selection');
const MODEL_SELECTION_RETRYABLE = 'MODEL_SELECTION_RETRYABLE';

function temporaryModelError(error) {
  return Object.assign(new Error(error?.message || String(error || '模型页面暂时不可用')), { code: MODEL_SELECTION_RETRYABLE });
}

async function callModelPage(window, runtimeSource, method, args = [], { timeoutMs = 8000 } = {}) {
  let timer, reply;
  try {
    const script = `${runtimeSource}\n(async () => {
      try { return { ok: true, value: await globalThis.__flowcutModelPicker[${JSON.stringify(method)}](...${JSON.stringify(args)}) }; }
      catch (error) { return { ok: false, code: error?.code || '', error: error?.message || String(error) }; }
    })()`;
    reply = await Promise.race([
      window.webContents.executeJavaScript(script, true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('模型页面脚本响应超时')), timeoutMs); }),
    ]);
  } catch (error) {
    // Native navigation/crash/destruction exceptions are never evidence that
    // the account lacks the selected model. Preserve codes via a page envelope.
    throw temporaryModelError(error);
  } finally { clearTimeout(timer); }
  if (!reply || reply.ok !== true) {
    throw Object.assign(new Error(reply?.error || '模型页面返回暂时异常'), {
      code: reply?.code === 'MODEL_SELECTION_FAILED' ? reply.code : MODEL_SELECTION_RETRYABLE,
    });
  }
  return reply.value;
}

function modelFailure(store, account, error) {
  if (!['MODEL_SELECTION_FAILED', MODEL_SELECTION_RETRYABLE].includes(error?.code)) return null;
  const settingsKey = error.modelSettingsKey || modelSettingsKey(store.state.settings.geminiModel);
  const prior = account.modelSelectionFailures;
  const count = error.code === MODEL_SELECTION_RETRYABLE ? (prior?.settingsKey === settingsKey ? Number(prior.count) || 0 : 0) + 1 : 0;
  store.updateAccount(account.id, { modelSelectionFailures: count ? { settingsKey, count, at: new Date().toISOString() } : null });
  return { settingsKey, count, hold: error.code === 'MODEL_SELECTION_FAILED' || count >= 3 };
}

function modelSucceeded(store, account) {
  if (account.modelSelectionFailures) store.updateAccount(account.id, { modelSelectionFailures: null });
}

function modelWatchdogError(error, pending) {
  if (!pending?.modelSelectionActive) return error;
  return Object.assign(temporaryModelError(error), { modelSettingsKey: modelSettingsKey(pending.modelSettings) });
}

module.exports = { MODEL_SELECTION_RETRYABLE, temporaryModelError, callModelPage, modelFailure, modelSucceeded, modelWatchdogError };
