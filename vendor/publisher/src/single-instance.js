import fs from 'node:fs';
import path from 'node:path';
export function acquireInstance(root) {
  const file=path.join(root,'state','service.lock');fs.mkdirSync(path.dirname(file),{recursive:true});
  for(let attempt=0;attempt<2;attempt++) {
    try {const fd=fs.openSync(file,'wx');fs.writeSync(fd,String(process.pid));fs.closeSync(fd);process.on('exit',()=>{try{if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}catch{}});return;}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      const pid=Number(fs.readFileSync(file,'utf8'));let alive=false;
      if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);alive=true;}catch(err){if(err.code==='EPERM')alive=true;}}
      if(alive)throw new Error('工作台服务已经运行，请打开 http://127.0.0.1:8876');
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法创建工作台运行锁');
}
