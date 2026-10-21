import type { GeminiKind } from "./shared";
import type { getDb } from "../storage";

// Everything the desktop executor may POST to /api/gemini-bridge.
export type BridgeBody = {
  action?: "heartbeat" | "stage" | "result" | "error" | "release" | "retrying" | "defer" | "model";
  modelInfo?: { model?: string; thinking?: string | null; checkedAt?: string; elapsedMs?: number };
  errorCode?: string;
  taskId?: string;
  kind?: GeminiKind;
  stage?: "extracting" | "storyboarding" | "grouping" | "optimizing";
  prompt?: string;
  codeBlocks?: string[];
  codeBlockHint?: boolean;
  rawReply?: string;
  analysis?: string;
  rewrittenScript?: string;
  extractionJson?: string;
  storyboardJson?: string;
  rawGroupsJson?: string;
  optimizedGroupsJson?: string;
  error?: string;
  accountLimited?: boolean;
  workerId?: string;
  version?: string;
  queueRunning?: boolean;
  activeCount?: number;
  activeTaskIds?: string[];
  activeJobs?: Array<{ taskId: string; accountName?: string; stage?: string; startedAt?: string; updatedAt?: string }>;
  maxConcurrent?: number;
  defaultAccountId?: string;
  accounts?: Array<{
    id: string;
    name: string;
    authenticated: boolean;
    enabled?: boolean;
    busy?: boolean;
    error?: string;
  }>;
};

export type TaskBody = BridgeBody & { taskId: string };
export type Db = ReturnType<typeof getDb>;
