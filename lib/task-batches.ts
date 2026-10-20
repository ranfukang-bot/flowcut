// A group task owns the clips cut from one Gemini reply (one clip per code
// block). Clips are ordinary tasks for Seedance, review and publishing.
export const TASK_ROLE_GROUP = "group";
export const TASK_ROLE_CLIP = "clip";
export const TASK_ROLE_CONCAT = "concat";

// A split group is a container, not a video; it is removed once empty.
export const ORPHAN_GROUP_DELETE = `DELETE FROM tasks WHERE ((task_role = 'group' AND status = 'split_done') OR task_role = 'fission')
  AND NOT EXISTS (SELECT 1 FROM tasks child WHERE child.batch_parent_id = tasks.id)`;

type Statement<S> = { bind(...values: unknown[]): S };

export function clipTaskId(groupId: string, round: number, index: number) {
  return `${groupId}-r${round}-${index}`;
}

// Clips start directly in the Seedance bridge queue when the local executor is
// configured, so a crash after this write cannot strand them as "prompt ready".
export type ClipStart = { status: "video_queued" | "prompt_ready"; provider: string; progress: number };

export function clipStart(autoQueue: boolean, seedance: { mode: string; secretConfigured: boolean }): ClipStart {
  return autoQueue && seedance.mode === "local-api" && seedance.secretConfigured
    ? { status: "video_queued", provider: "seedance-bridge", progress: 48 }
    : { status: "prompt_ready", provider: "gemini-web", progress: 32 };
}

// Inserts run before the group update in one batch and are conditioned on the
// group still being claimed by this worker, so a late or repeated result can
// never add clips. Deterministic ids make a replay idempotent.
export function clipInsertStatements<S extends Statement<S>>(db: { prepare(sql: string): S }, input: {
  groupId: string; round: number; prompts: string[]; start: ClipStart;
  expectedStatus: string; workerId: string; now: string;
}) {
  return input.prompts.map((prompt, offset) => db.prepare(`INSERT OR IGNORE INTO tasks
    (id, product_id, gem_id, title, status, prompt, provider, progress, duration, region, shooting_style,
     callback_token, auto_queue, gemini_account_id, tiktok_account_name, archive_directory, gem_content_snapshot,
     product_external_id_snapshot, gemini_request_text, image_keys_snapshot, task_role, batch_parent_id,
     batch_index, batch_round, batch_size, created_at, updated_at)
    SELECT ?, product_id, gem_id, title || ' · ' || ?, ?, ?, ?, ?, duration, region, shooting_style,
      ?, auto_queue, NULL, tiktok_account_name, archive_directory, gem_content_snapshot,
      product_external_id_snapshot, gemini_request_text, image_keys_snapshot, 'clip', id,
      ?, ?, ?, ?, ?
    FROM tasks WHERE id = ? AND provider = 'gemini-web' AND status = ?
      AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`).bind(
    clipTaskId(input.groupId, input.round, offset + 1), `第 ${offset + 1}/${input.prompts.length} 条`,
    input.start.status, prompt, input.start.provider, input.start.progress,
    crypto.randomUUID(), offset + 1, input.round, input.prompts.length, input.now, input.now,
    input.groupId, input.expectedStatus, input.workerId,
  ));
}
