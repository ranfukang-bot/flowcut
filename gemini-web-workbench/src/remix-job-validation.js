const {validateRemixAnalysis,validateRemixAdaptation,remixAdaptationRequest,remixCorrectionRequest}=require('../../lib/remix-segments.ts');

// Called only after the IPC handler has matched request id AND webContents.
// The page cannot supply its own plan, expected ranges, or rewrite index.
async function validateRemixJob(pending,payload,persist) {
  const meta=pending.remix;
  if(!meta || !['remix-segments','remix-rewrite'].includes(pending.kind)) throw new Error('不是分段复刻任务');
  const first=payload.phase==='analysis';
  if(first && (meta.analysisBlocks?.length || pending.kind==='remix-rewrite')) throw new Error('原脚本已存在，禁止重复拆解');
  const expected=meta.analysisBlocks?.length?validateRemixAnalysis(meta.analysisBlocks,meta.seconds,meta.plan):meta.plan;
  let segments;
  try {
    segments=first?validateRemixAnalysis(payload.codeBlocks,meta.seconds,meta.plan):validateRemixAdaptation(payload.codeBlocks,expected,meta.rewriteIndex || undefined);
  } catch(error) {
    return {valid:false,error:error.message,correctionPrompt:remixCorrectionRequest(meta.rewriteIndex?expected.filter(s=>s.index===meta.rewriteIndex):expected,Boolean(meta.rewriteIndex))};
  }
  if(first) {
    await persist({analysisBlocks:segments.map(s=>s.text),rawReply:payload.rawReply,rawReplies:payload.rawReplies,remixRound:meta.round});
    meta.analysisBlocks=segments.map(s=>s.text);
  }
  const script=meta.analysisBlocks.join('\n\n');
  return {valid:true,segments,adaptationPrompt:remixAdaptationRequest(script,{productName:meta.productName,region:meta.region,spokenLanguage:meta.spokenLanguage,segment:meta.rewriteIndex?expected.find(s=>s.index===meta.rewriteIndex):undefined,note:meta.note})};
}
module.exports={validateRemixJob};
