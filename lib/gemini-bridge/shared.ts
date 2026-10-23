import { getProviderConfig } from "../provider-config";

export type GeminiKind = "standard" | "variant" | "reference-remix" | "script-pipeline" | "remix-segments" | "remix-rewrite";

// A group already split into clips is finished with Gemini: a late release,
// retry or failure report from an old worker must not reopen it.
export const SPLIT_GUARD = " AND status NOT IN ('split_done','fission_ready')";

// Table and queue/active states for each Gemini job kind. A variant job is the
// second round of a product task and lives in the tasks table.
export function kindState(kind: GeminiKind | undefined, workerId = '') {
  const fissionGuard = ` AND (COALESCE(task_role,'') NOT IN ('fission','fission_child') OR
    (provider='gemini-web' AND status IN (${kind==='variant'?"'variant_queued','variant_generating'":"'prompt_queued','prompt_generating'"}) AND bridge_worker_id=?))`;
  if (kind === 'remix-segments' || kind === 'remix-rewrite') {
    const rewrite=kind==='remix-rewrite';
    return {table:'tasks',queued:rewrite?"'remix_rewrite_queued'":"'remix_queued'",queuedProgress:'5',
      active:rewrite?"'remix_rewriting'":"CASE WHEN remix_analysis_blocks IS NOT NULL THEN 'remix_adapting' ELSE 'remix_analyzing' END",activeProgress:'18',rawReply:true,
      guard:` AND task_role='remix' AND provider='gemini-web' AND status IN (${rewrite?"'remix_rewrite_queued','remix_rewriting'":"'remix_queued','remix_analyzing','remix_adapting'"}) AND bridge_worker_id=?`,guardArgs:[workerId]};
  }
  if (kind === "reference-remix") {
    return { table: "reference_remix_tasks", queued: "'reference_queued'", queuedProgress: "5", active: "'reference_analyzing'", activeProgress: "14", rawReply: false, guard: "", guardArgs: [] as string[] };
  }
  if (kind === "script-pipeline") {
    return {
      table: "script_pipeline_tasks",
      queued: `CASE
             WHEN raw_groups_json <> '[]' THEN 'optimization_queued'
             WHEN storyboard_json <> '' THEN 'grouping'
             WHEN extraction_json <> '' THEN 'storyboarding'
             WHEN rewritten_script <> '' THEN 'extracting'
             ELSE 'rewrite_queued'
           END`,
      queuedProgress: `CASE
             WHEN raw_groups_json <> '[]' THEN 72
             WHEN storyboard_json <> '' THEN 66
             WHEN extraction_json <> '' THEN 48
             WHEN rewritten_script <> '' THEN 30
             ELSE 5
           END`,
      active: `CASE
             WHEN raw_groups_json <> '[]' THEN 'optimizing'
             WHEN storyboard_json <> '' THEN 'grouping'
             WHEN extraction_json <> '' THEN 'storyboarding'
             WHEN rewritten_script <> '' THEN 'extracting'
             ELSE 'rewriting'
           END`,
      activeProgress: `CASE
             WHEN raw_groups_json <> '[]' THEN 76
             WHEN storyboard_json <> '' THEN 66
             WHEN extraction_json <> '' THEN 48
             WHEN rewritten_script <> '' THEN 30
             ELSE 14
           END`,
      rawReply: false,
      guard: "",
      guardArgs: [] as string[],
    };
  }
  if (kind === "variant") {
    return { table: "tasks", queued: "'variant_queued'", queuedProgress: "36", active: "'variant_generating'", activeProgress: "40", rawReply: true, guard: SPLIT_GUARD+fissionGuard, guardArgs: [workerId] };
  }
  return { table: "tasks", queued: "'prompt_queued'", queuedProgress: "5", active: "'prompt_generating'", activeProgress: "14", rawReply: true, guard: SPLIT_GUARD+fissionGuard, guardArgs: [workerId] };
}

// Gemini replies kept for the task detail when a split was refused.
export function rawReplyValue(value: unknown) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 60_000) : null;
}

export async function authorize(request: Request) {
  const configured = await getProviderConfig("seedance");
  const expected = configured.secrets.apiKey;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(expected && supplied && supplied === expected);
}

export function mediaUrl(requestUrl: string, objectKey: string) {
  const url = new URL("/api/media", requestUrl);
  url.searchParams.set("key", objectKey);
  return url.toString();
}

export function callbackUrl(requestUrl: string, token: string) {
  const url = new URL("/api/tasks/callback", requestUrl);
  url.searchParams.set("token", token);
  return url.toString();
}
