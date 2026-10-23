import { recordSegmentAnalysis, applySegmentResult } from '../../../lib/gemini-bridge/remix-segments';
import { isRemixKind } from '../../../lib/remix-tasks';
import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";
import { claimGeminiJobs } from "../../../lib/gemini-bridge/claim";
import { authorize } from "../../../lib/gemini-bridge/shared";
import { recordHeartbeat, recordModel, recordRemixAnalysis, recordScriptStage } from "../../../lib/gemini-bridge/progress";
import { applyPromptResult, applyRemixResult, applyScriptResult } from "../../../lib/gemini-bridge/results";
import { deferJob, failJob, markRetrying, releaseJob } from "../../../lib/gemini-bridge/failures";
import type { BridgeBody, TaskBody } from "../../../lib/gemini-bridge/types";

// The desktop Gemini executor's only door into FlowCut. Each job kind's
// logic lives in lib/gemini-bridge/; this file only checks access and routes.
export async function GET(request: Request) {
  return claimGeminiJobs(request);
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    if (!(await authorize(request))) {
      return Response.json({ error: "Gemini 网页执行器鉴权失败" }, { status: 401 });
    }
    const body = (await request.json()) as BridgeBody;
    const db = getDb();
    const now = new Date().toISOString();

    if (body.action === "heartbeat") return recordHeartbeat(db, body, now);

    if (!body.taskId) {
      return Response.json({ error: "缺少 FlowCut 任务 ID" }, { status: 400 });
    }
    const job = body as TaskBody;

    if(job.action==='stage' && isRemixKind(job.kind)) return await recordSegmentAnalysis(db,job,now);
    if (job.action === 'model') return recordModel(db, job, now);
    if (job.action === "stage" && job.kind === "reference-remix") return recordRemixAnalysis(db, job, now);
    if (job.action === "stage" && job.kind === "script-pipeline") return recordScriptStage(db, job, now);

    if (job.action === "result") {
      if(isRemixKind(job.kind)) return await applySegmentResult(db,job,now);
      const prompt = String(job.prompt || "").trim();
      if (prompt.length < 300) {
        return Response.json(
          {
            error: `Gemini 返回内容只有 ${prompt.length} 字，不是完整 Seedance 提示词，已阻止进入下一步`,
          },
          { status: 400 }
        );
      }
      if (job.kind === "script-pipeline") return applyScriptResult(db, job, now);
      if (job.kind === "reference-remix") return applyRemixResult(db, job, now, prompt);
      return applyPromptResult(db, job, now, prompt, request.url);
    }

    if (job.action === "release") return releaseJob(db, job, now);
    if (job.action === "defer") return deferJob(db, job, now);
    if (job.action === "retrying") return markRetrying(db, job, now);
    if (job.action === "error") return failJob(db, job, now);
    return Response.json({ error: "不支持的 Gemini Bridge 操作" }, { status: 400 });
  } catch (error) {
    return jsonError(error,(error as {code?:string})?.code==='REMIX_SEGMENTS_INVALID'?400:500);
  }
}
