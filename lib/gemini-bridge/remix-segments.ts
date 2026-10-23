import { availableGemAccounts } from '../gemini-account-routing';
import { REMIX_GEM } from '../remix-gem';
import { finishRemixRound, getRemix, savedRemixSegments, type RemixTask } from '../remix-tasks';
import { remixAnalysisRequest, remixAdaptationRequest, validateRemixAnalysis } from '../remix-segments';
import { mediaUrl } from './shared';
import type { Db, TaskBody } from './types';

export async function claimRemixSegments(db: Db, input: {requestUrl:string;workerId:string;staleBefore:string;now:string;capacity:number;accounts:Set<string>;blocked:Record<string,string[]>;blockedTasks:Set<unknown>}) {
  const rows=await db.prepare(`SELECT * FROM tasks WHERE task_role='remix' AND provider='gemini-web'
    AND status IN ('remix_queued','remix_analyzing','remix_adapting','remix_rewrite_queued','remix_rewriting')
    AND (bridge_claimed_at IS NULL OR bridge_claimed_at<?) AND (gemini_retry_at IS NULL OR gemini_retry_at<=?)
    ORDER BY COALESCE(gemini_retry_at,created_at) ASC LIMIT 32`).bind(input.staleBefore,input.now).all<RemixTask>();
  const jobs=[];
  for(const task of rows.results) {
    if(jobs.length>=input.capacity) break;
    if(input.blockedTasks.has(task.id)) continue;
    const eligible=await availableGemAccounts(input.accounts,input.blocked,REMIX_GEM.id,REMIX_GEM.content);
    const preferred=String(task.gemini_account_id || '');
    const accountId=eligible.has(preferred)?preferred:eligible.values().next().value;
    if(!accountId) continue;
    const plan=JSON.parse(task.remix_plan_json || '[]');
    const saved=task.remix_analysis_blocks?savedRemixSegments(task):[];
    const rewrite=Boolean(task.remix_rewrite_index);
    const status=rewrite?'remix_rewriting':saved.length?'remix_adapting':'remix_analyzing';
    const claimed=await db.prepare(`UPDATE tasks SET status=?,progress=18,gemini_account_id=?,bridge_worker_id=?,bridge_claimed_at=?,
      gemini_retry_at=NULL,error=NULL,updated_at=? WHERE id=? AND status=? AND batch_round=?
      AND (bridge_claimed_at IS NULL OR bridge_claimed_at<?)`)
      .bind(status,accountId,input.workerId,input.now,input.now,task.id,task.status,task.batch_round,input.staleBefore).run();
    if(!claimed.meta.changes) continue;
    jobs.push({id:task.id,kind:rewrite?'remix-rewrite' as const:'remix-segments' as const,accountId,gem:REMIX_GEM,
      analysisPrompt:remixAnalysisRequest(task.remix_video_seconds,plan),
      adaptationPrompt:saved.length?remixAdaptationRequest(saved.map(s=>s.text).join('\n\n'),{productName:String(task.remix_product_name || ''),region:String(task.region),spokenLanguage:String(task.remix_spoken_language || 'auto'),segment:rewrite?saved.find(s=>s.index===task.remix_rewrite_index):undefined,note:String(task.remix_rewrite_note || '')}):'',
      imageUrls:(JSON.parse(String(task.image_keys_snapshot || '[]')) as string[]).map(key=>mediaUrl(input.requestUrl,key)),
      referenceVideoUrl:saved.length?undefined:mediaUrl(input.requestUrl,String(task.remix_video_key)),
      remix:{round:Number(task.batch_round),seconds:task.remix_video_seconds,plan,analysisBlocks:saved.map(s=>s.text),
        productName:String(task.remix_product_name || ''),region:String(task.region),spokenLanguage:String(task.remix_spoken_language || 'auto'),
        rewriteIndex:task.remix_rewrite_index,note:String(task.remix_rewrite_note || '')}});
    input.accounts.delete(accountId);
  }
  return jobs;
}

function conflict() { return Response.json({error:'分段复刻任务领取或轮次已失效',ignorable:true},{status:409}); }
export async function recordSegmentAnalysis(db:Db,body:TaskBody,now:string) {
  const task=await getRemix(db,body.taskId);
  if(!task || task.status!=='remix_analyzing' || task.bridge_worker_id!==body.workerId || Number(task.batch_round)!==body.remixRound) return conflict();
  const segments=validateRemixAnalysis(body.analysisBlocks,task.remix_video_seconds,JSON.parse(task.remix_plan_json || '[]'));
  const script=segments.map(s=>s.text).join('\n\n');
  const result=await db.prepare(`UPDATE tasks SET remix_script=?,remix_analysis_blocks=?,remix_analysis_raw=?,
    remix_raw_replies=json_insert(COALESCE(remix_raw_replies,'[]'),'$[#]',json(?)),batch_size=?,status='remix_adapting',progress=42,updated_at=?
    WHERE id=? AND status='remix_analyzing' AND bridge_worker_id=? AND batch_round=?`)
    .bind(script,JSON.stringify(segments.map(s=>s.text)),body.rawReply || script,JSON.stringify(body.rawReplies || []),segments.length,now,task.id,body.workerId,body.remixRound).run();
  return result.meta.changes?Response.json({ok:true}):conflict();
}
export async function applySegmentResult(db:Db,body:TaskBody,now:string) {
  const task=await getRemix(db,body.taskId);
  if(!task || task.bridge_worker_id!==body.workerId || Number(task.batch_round)!==body.remixRound || !['remix_adapting','remix_rewriting'].includes(task.status)) return conflict();
  const done=await finishRemixRound(db,task,body.codeBlocks || [],body.workerId || '',body.remixRound!,body.rawReplies,now);
  return done?Response.json({ok:true,status:'remix_segmented'}):conflict();
}
