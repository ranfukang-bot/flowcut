const fs=require('node:fs'),path=require('node:path');
const destination=path.resolve(__dirname,'../media-tools');
fs.mkdirSync(destination,{recursive:true});
const directories=[process.env.FLOWCUT_FFMPEG_DIR,...String(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
for(const name of ['ffmpeg.exe','ffprobe.exe']) {
  const output=path.join(destination,name);
  if(fs.existsSync(output)) continue;
  const source=directories.map(d=>path.join(d.replace(/^"|"$/g,''),name)).find(f=>fs.existsSync(f));
  if(!source) throw Error(`缺少 ${name}：请安装 FFmpeg 并加入 PATH，或设置 FLOWCUT_FFMPEG_DIR`);
  fs.copyFileSync(source,output);
  for(const license of ['LICENSE','LICENSE.txt','COPYING.GPLv3','README.txt']) {
    const file=path.resolve(path.dirname(source),'..',license);
    if(fs.existsSync(file)) fs.copyFileSync(file,path.join(destination,license));
  }
}
console.log('FFmpeg and FFprobe are ready for packaging.');
