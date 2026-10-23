const test = require('node:test');
const assert = require('node:assert/strict');
const { planRemixSegments, parseSegmentHeader, validateRemixAnalysis, validateRemixAdaptation, remixAnalysisRequest, remixAdaptationRequest, remixCorrectionRequest } = require('../../lib/remix-segments.ts');
const block = (i, a, b, suffix = '') => `第${i}段｜原视频 ${a}-${b} 秒｜本段时长 ${b-a} 秒\n${'完整镜头、运镜、口播与同步声音。'.repeat(30)}${suffix}`;
for (const [seconds, durations] of [[3,[4]],[4,[4]],[15,[15]],[16,[8,8]],[24,[15,9]],[30,[15,15]],[33,[15,9,9]],[45,[15,15,15]],[60,[15,15,15,15]]]) {
  test(`${seconds} seconds creates a complete ${durations.join('+')} plan`, () => {
    const plan = planRemixSegments(seconds);
    assert.deepEqual(plan.segments.map(s=>s.duration), durations);
    assert.equal(plan.segments[0].start, 0);
    assert.equal(plan.segments.at(-1).end, Math.max(4, seconds));
    assert.equal(validateRemixAnalysis(plan.segments.map(s=>block(s.index,s.start,s.end)),plan.seconds,plan.segments).length, durations.length);
  });
}
test('rounding, unknown duration and full/half width headers', () => {
  assert.equal(planRemixSegments(23.7).seconds,24);
  assert.deepEqual(planRemixSegments(null),{seconds:null,segments:[]});
  assert.deepEqual(planRemixSegments(NaN),{seconds:null,segments:[]});
  assert.throws(()=>planRemixSegments(60.01),/60/);
  assert.equal(parseSegmentHeader(' 第 2 段 | 原视频 15 - 24 秒 | 本段时长 9 秒 ').duration,9);
  assert.equal(parseSegmentHeader('第2段｜原视频 15-24 秒｜本段时长 9 秒').start,15);
  assert.throws(()=>parseSegmentHeader('第2段｜原视频 15-24 秒｜本段时长 8 秒'));
  assert.equal(validateRemixAnalysis([block(1,0,12),block(2,12,24)]).length,2);
});
test('analysis rejects every incomplete batch instead of accepting partial blocks', () => {
  const {seconds,segments}=planRemixSegments(24);
  for(const blocks of [[],[block(1,0,15)], [block(2,0,15),block(3,15,24)], [block(1,1,15),block(2,15,24)], [block(1,0,15),block(2,16,24)], [block(1,0,11),block(2,11,24)], [block(1,0,15),block(2,15,26)], [block(1,0,15),block(2,15,24).slice(0,100)], Array(11).fill(block(1,0,4)), ['bad header\n'+'x'.repeat(400)]]) {
    assert.throws(()=>validateRemixAnalysis(blocks,seconds,segments));
  }
  assert.throws(()=>validateRemixAnalysis([block(1,0,3)]));
  assert.throws(()=>validateRemixAnalysis([block(1,0,16)]));
  assert.equal(validateRemixAnalysis([block(1,0,14),block(2,14,24)],seconds,segments).length,2);
});
test('adaptation and a single rewrite retain exactly the original ranges', () => {
  const original=validateRemixAnalysis([block(1,0,15),block(2,15,24)]);
  assert.equal(validateRemixAdaptation([block(1,0,15,'新商品'),block(2,15,24,'新商品')],original).length,2);
  assert.equal(validateRemixAdaptation([block(2,15,24)],original,2)[0].index,2);
  for(const [blocks,index]of [[[block(1,0,15)],undefined],[[block(1,0,14),block(2,14,24)],undefined],[[block(1,0,15)],2],[[block(2,15,24).slice(0,80)],2]])assert.throws(()=>validateRemixAdaptation(blocks,original,index));
});
test('exact round messages omit unknown duration, optional name and follow-reference language', () => {
  const plan=planRemixSegments(24), original=validateRemixAnalysis([block(1,0,15),block(2,15,24)]);
  assert.equal(remixAnalysisRequest(plan.seconds,plan.segments),'参考视频总时长：24 秒\n分段计划：第1段 原视频 0-15 秒（15 秒）；第2段 原视频 15-24 秒（9 秒）\n不要提问，直接输出。');
  assert.equal(remixAnalysisRequest(null,[]),'不要提问，直接输出。');
  const script=original.map(s=>s.text).join('\n\n');
  assert.equal(remixAdaptationRequest(script,{region:'印尼',spokenLanguage:'follow-reference'}),`请1：1复刻该视频 包括运镜、动作细节、音效等：\n${script}\n\n不要提问，直接输出。`);
  const request=remixAdaptationRequest(script,{region:'印尼',productName:'商品',segment:original[1],note:'运镜更慢'});
  assert.ok(request.includes('口播语言：印尼语\n'));
  assert.ok(request.endsWith('只输出第2段（原视频 15-24 秒，本段时长 9 秒）。修改说明：运镜更慢'));
  assert.ok(remixCorrectionRequest(original).includes(original.map(s=>s.header).join('\n')));
});
