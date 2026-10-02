import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('待检查单独用橙黄状态，已通过和生成中不被染色',()=>{
  const source=fs.readFileSync(new URL('../app/studio-app.tsx',import.meta.url),'utf8');
  const functions=source.slice(source.indexOf('function taskStatusClass('),source.indexOf('\nasync function api(')).replaceAll('task: Task','task');
  const context=vm.createContext({statusLabels:{video_generating:'视频生成中'}});vm.runInContext(functions,context);
  const ready={status:'video_ready',download_path:'file.mp4',review_status:'pending'};
  assert.equal(context.taskStatusClass(ready),'review_pending');
  assert.equal(context.taskStatusClass({...ready,status:'scheduled'}),'review_pending');
  assert.equal(context.taskStatusClass({...ready,review_status:'approved'}),'video_ready');
  assert.equal(context.taskStatusClass({...ready,download_path:null}),'video_ready');
  assert.equal(context.taskStatusClass({status:'video_generating'}),'video_generating');
  const css=fs.readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
  assert.match(css,/\.status\.review_pending\s*\{[^}]*background: #fff0bf/);
  assert.equal((source.match(/status \$\{taskStatusClass\(task\)\}/g)||[]).length,3);
});
