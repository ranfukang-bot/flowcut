const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {siteFixture}=require('./helpers/site-routes.cjs');
const {VideoReview,reviewDirectory}=require('../src/video-review');
const {concatClips}=require('../src/clip-concat');
const {probe}=require('../src/dual-video-composer');

const PRODUCT_ID='1735360337668113923';
const block=n=>`第${n}条视频提示词：`+'产品特写、人物口播与使用场景自然衔接，画面真实，光线柔和。'.repeat(14);

function clipVideo(file,{color,size,seconds,audio}) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const input=['-f','lavfi','-i',`color=c=${color}:s=${size}:r=24:d=${seconds}`];
  if (audio) input.push('-f','lavfi','-i',`sine=frequency=660:sample_rate=44100:duration=${seconds}`);
  execFileSync('ffmpeg',['-v','error',...input,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',...(audio?['-c:a','aac','-ac','1']:[]),'-t',String(seconds),file],{windowsHide:true});
}
function pixel(file,seconds) {
  const rgb=execFileSync('ffmpeg',['-v','error','-ss',String(seconds),'-i',file,'-vframes','1','-vf','crop=8:8:536:956,scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true});
  return [...rgb];
}
const dominant=([r,g,b])=>r>150&&g<90&&b<90?'red':b>150&&r<90&&g<90?'blue':g>100&&r<90&&b<90?'green':`rgb(${r},${g},${b})`;

// One group with three downloaded clips, served by the real site routes; the
// desktop review runtime talks to those routes exactly as it does in the app.
async function fixture(t,{join=concatClips}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-concat-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=await siteFixture(t);
  const at=new Date().toISOString();
  f.sqlite.prepare("INSERT INTO gems(id,name,content,created_at,updated_at) VALUES('gem','主 Gem','设定',?,?)").run(at,at);
  f.sqlite.prepare("INSERT INTO products(id,external_id,name,created_at) VALUES('product',?,'测试商品',?)").run(PRODUCT_ID,at);
  f.sqlite.prepare("INSERT INTO tiktok_accounts(id,name,created_at) VALUES('tk','测试账号',?)").run(at);
  f.objects.set('products/product/a.png',1);
  const created=await f.call('tasks','POST',{body:{productId:'product',gemId:'gem',tiktokAccountName:'测试账号',imageKeys:['products/product/a.png'],duration:15}});
  const group=created.body.id;
  const job=(await f.call('gemini-bridge','GET',{query:'?workerId=desk&capacity=1&accountIds=a'})).body.jobs[0];
  const blocks=[block(1),block(2),block(3)];
  await f.call('gemini-bridge','POST',{body:{action:'result',kind:'standard',taskId:job.id,workerId:'desk',prompt:blocks.join('\n'),codeBlocks:blocks}});
  const clips=f.rows('SELECT id FROM tasks WHERE batch_parent_id=? ORDER BY batch_index',group).map(row=>row.id);
  const specs=[{color:'red',size:'720x1280',seconds:2,audio:true},{color:'blue',size:'1080x1920',seconds:3,audio:true},{color:'green',size:'540x960',seconds:1.5,audio:false}];
  const files=clips.map((id,i)=>{
    const file=path.join(reviewDirectory(root,id),PRODUCT_ID+'.mp4');
    clipVideo(file,specs[i]);
    f.sqlite.prepare("UPDATE tasks SET status='video_ready',progress=100,download_path=? WHERE id=?").run(file,id);
    return file;
  });
  const request=async(route,init)=>{
    const url=new URL('http://fixture'+route);
    const name=url.pathname.replace(/^\/api\//,'');
    const result=await f.call(name,init?.method||'GET',{query:url.search,body:init?.body?JSON.parse(init.body):undefined});
    if (result.status>=400) throw Error(result.body.error||'请求失败');
    return result.body;
  };
  const review=new VideoReview({userData:root,request,defaultDirectory:()=>path.join(root,'publish'),shell:{openPath:async()=>''},concatClips:join});
  return {root,f,group,clips,files,review};
}
const reviewStatus=(f,ids)=>ids.map(id=>f.row('SELECT review_status FROM tasks WHERE id=?',id)?.review_status??null);

test('selected clips are joined in order into one 1080x1920 video with sound; approving it removes the clips',{timeout:180000},async t=>{
  const {root,f,group,clips,files,review}=await fixture(t);
  const result=await review.concat(group,[clips[2],clips[0],clips[1]],true);
  const media=await probe(result.file);
  const video=media.streams.find(s=>s.codec_type==='video'),audio=media.streams.find(s=>s.codec_type==='audio');
  assert.deepEqual([video.width,video.height],[1080,1920]);
  assert.ok(Math.abs(Number(media.format.duration)-6.5)<0.3,`duration ${media.format.duration}`);
  assert.deepEqual([Number(audio.sample_rate),audio.channels],[48000,2]);
  assert.deepEqual([1,3.5,5.8].map(s=>dominant(pixel(result.file,s))),['red','blue','green'],'clips are joined in batch order with no reordering');
  assert.deepEqual(reviewStatus(f,clips),['merged','merged','merged']);
  const joined=f.row('SELECT status,task_role,download_path FROM tasks WHERE id=?',result.id);
  assert.deepEqual(joined,{status:'video_ready',task_role:'concat',download_path:result.file});
  await assert.rejects(review.approve(clips[0],true),/状态|重做|刷新/,'a merged clip cannot be approved on its own');

  const approved=await review.approve(result.id,true);
  assert.equal(approved.cleanupWarning,undefined);
  assert.equal(path.basename(approved.file),PRODUCT_ID+'.mp4');
  assert.ok(fs.existsSync(approved.file));
  assert.ok(files.every(file=>!fs.existsSync(file)),'clip files are removed once the joined video is approved');
  assert.deepEqual(f.rows('SELECT id FROM tasks WHERE batch_parent_id=?',group).map(r=>r.id),[result.id]);
  assert.ok(!fs.existsSync(path.join(root,'review-videos',path.basename(path.dirname(files[0])))),'empty clip folders are removed');
});

test('a failed join leaves every selected clip waiting for review, untouched',async t=>{
  const {f,group,clips,files,review}=await fixture(t,{join:async(inputs,output)=>{fs.writeFileSync(output+'.partial','half');throw Error('FFmpeg 已停止');}});
  await assert.rejects(review.concat(group,clips.slice(0,2),true),/拼接未完成，所选视频保持原状：FFmpeg 已停止/);
  assert.deepEqual(reviewStatus(f,clips),['pending','pending','pending']);
  assert.equal(f.row("SELECT COUNT(*) AS n FROM tasks WHERE task_role='concat'").n,0);
  assert.ok(files.every(file=>fs.statSync(file).size>0));
  await assert.rejects(review.concat(group,[clips[0]],true),/2–10/);
  await assert.rejects(review.concat(group,[clips[0],clips[0]],true),/2–10/);
});

test('restart recovery finishes a join whose file was written and releases one that was not',async t=>{
  const {f,group,clips,review}=await fixture(t,{join:async()=>{throw Error('unused');}});
  const call=body=>f.call('tasks/review','POST',{body:{confirmed:true,...body}});
  assert.equal((await call({id:group,action:'concat-reserve',concatId:'written',sourceIds:clips.slice(0,2)})).status,200);
  const output=review.concatOutput('written');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,'joined video');
  assert.equal((await call({id:group,action:'concat-reserve',concatId:'interrupted',sourceIds:[clips[2],clips[0]]})).status,409,'clips already reserved cannot join twice');
  const result=await review.recoverConcats();
  assert.deepEqual({finished:result.finished,released:result.released,errors:result.errors},{finished:1,released:0,errors:[]});
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?','written').status,'video_ready');

  assert.equal((await call({id:group,action:'concat-reserve',concatId:'lost',sourceIds:[clips[2],clips[0]]})).status,409);
  await call({id:'written',action:'reserve-delete'});await call({id:'written',action:'delete-pending'});
  assert.equal((await call({id:group,action:'concat-reserve',concatId:'lost',sourceIds:[clips[2],clips[0]]})).status,200);
  const second=await review.recoverConcats();
  assert.deepEqual({finished:second.finished,released:second.released},{finished:0,released:1});
  assert.deepEqual(reviewStatus(f,clips),['pending','pending','pending']);
});
