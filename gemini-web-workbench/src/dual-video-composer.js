const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const {reviewDirectory} = require('./video-review');
const {loadJsonState,writeTextDurable} = require('../../vendor/seedance-engine/durable-json');

function segmentDirectory(userData,id,index) {
  if (![1,2].includes(index)) throw Error('无效的视频分段');
  return path.join(reviewDirectory(userData,id),'segments',String(index));
}
function mediaTool(name) {
  const bundled = path.join(process.resourcesPath || '', 'media-tools', name + '.exe');
  return fs.existsSync(bundled) ? bundled : name;
}
async function probe(file, signal) {
  const {stdout} = await run(mediaTool('ffprobe'),['-v','error','-show_streams','-show_format','-of','json',file],{windowsHide:true,signal,timeout:30000,maxBuffer:1024*1024});
  const value = JSON.parse(stdout);
  if (!value.streams.some(s=>s.codec_type === 'video')) throw Error('文件中没有视频画面');
  return value;
}
class DualVideoComposer {
  constructor(userData) { this.userData=userData; this.active=new Map(); }
  cancel(id) { this.active.get(id)?.abort(); }
  async compose(children) {
    const task=children[0], id=task.flowcutTaskId;
    if (this.active.has(id)) return null;
    const controller=new AbortController(); this.active.set(id,controller);
    const folder=reviewDirectory(this.userData,id);
    const output=path.join(folder,'combined-30s.mp4');
    const temp=path.join(folder,'combined-30s.mp4.partial');
    const receipt=path.join(folder,'composition.json');
    try {
      const state=loadJsonState({file:receipt,validate:v=>v?.signature===task.dualSignature && v?.file===output ? '' : '拼接记录不匹配'});
      if (state.status==='blocked') throw Error('拼接记录损坏，已阻止重复合成');
      if (state.value) return state.value.file; // Approval may have moved the file.
      const save=()=>writeTextDurable(receipt,JSON.stringify({file:output,signature:task.dualSignature}),{backup:'mirror'});
      if (fs.existsSync(output)) {
        const existing=await probe(output,controller.signal);
        if (Math.abs(Number(existing.format.duration)-30) > 0.2) throw Error('已有合成文件时长异常，请检查临时目录');
        save(); return output;
      }
      if (children.length!==2 || children.some(t=>!t.lastDownloadedPath)) return null;
      const files=children.map(t=>t.lastDownloadedPath);
      for (let i=0;i<2;i++) {
        const expected=fs.realpathSync(segmentDirectory(this.userData,id,i+1));
        if (path.dirname(fs.realpathSync(files[i]))!==expected) throw Error('分段视频不在该任务的临时目录中');
      }
      const media=await Promise.all(files.map(f=>probe(f,controller.signal)));
      media.forEach((m,i)=>{
        const duration=Number(m.streams.find(s=>s.codec_type==='video').duration || m.format.duration);
        if (!Number.isFinite(duration) || Math.abs(duration-15)>0.6) throw Error(`第 ${i+1} 段实际时长不是 15 秒，已停止拼接，请检查视频`);
      });
      const filters=[];
      for(let i=0;i<2;i++) {
        filters.push(`[${i}:v:0]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=1,trim=duration=15,setpts=PTS-STARTPTS[v${i}]`);
        const audio=media[i].streams.some(s=>s.codec_type==='audio') ? `${i}:a:0` : '2:a:0';
        filters.push(`[${audio}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=15,asetpts=PTS-STARTPTS[a${i}]`);
      }
      filters.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
      fs.mkdirSync(folder,{recursive:true});
      await run(mediaTool('ffmpeg'),['-hide_banner','-loglevel','error','-y','-i',files[0],'-i',files[1],'-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-filter_complex',filters.join(';'),'-map','[v]','-map','[a]','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart','-t','30','-f','mp4',temp],{windowsHide:true,signal:controller.signal,timeout:15*60000,maxBuffer:1024*1024});
      const result=await probe(temp,controller.signal);
      if (Math.abs(Number(result.format.duration)-30)>0.2) throw Error('合成视频时长校验失败');
      controller.signal.throwIfAborted();
      fs.renameSync(temp,output); save(); return output;
    } finally {
      this.active.delete(id);
      try {fs.unlinkSync(temp);} catch(e) {if(e.code!=='ENOENT') console.error(e);}
    }
  }
}
module.exports={DualVideoComposer,segmentDirectory,probe};
