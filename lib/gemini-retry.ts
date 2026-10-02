// Task delay is independent of account availability. Only a real quota/rate
// limit warrants the longer account-wide backoff handled by the desktop.
export function geminiRetryPlan(failures: number, accountLimited = false) {
  const delays = accountLimited ? [120_000, 300_000, 900_000] : [30_000, 60_000, 120_000];
  const delayMs = delays[failures - 1];
  return {
    maxFailures: delays.length,
    delayMs: delayMs ?? null,
    label: delayMs ? (delayMs < 60_000 ? `${delayMs / 1000} 秒` : `${delayMs / 60_000} 分钟`) : "",
  };
}

// Upgrade only old, unclaimed Gemini retries. Never touch active work or the
// Seedance queue. Rewriting the old message makes this safe to run again.
export const LEGACY_GEMINI_RETRY_UPDATES = [
  ["tasks", "'prompt_queued'"],
  ["reference_remix_tasks", "'reference_queued'"],
  ["script_pipeline_tasks", "'rewrite_queued','extracting','storyboarding','grouping','optimization_queued'"],
].map(([table, statuses]) => `UPDATE ${table}
  SET gemini_retry_at = NULL,
      error = '旧版长等待已取消，已重新排队；' || error
  WHERE provider = 'gemini-web' AND status IN (${statuses})
    AND bridge_claimed_at IS NULL AND bridge_worker_id IS NULL
    AND gemini_retry_at IS NOT NULL
    AND error LIKE 'Gemini 网页临时波动，系统将在 %'`);
