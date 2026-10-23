import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as statuses from '../lib/task-statuses.ts';
test('待检查单独用橙黄状态，已通过和生成中不被染色',()=>{
  const statusSource=fs.readFileSync(new URL('../app/task-status.tsx',import.meta.url),'utf8');
  const functions=statusSource.slice(statusSource.indexOf('export function clipAwaitingReview(')).replaceAll('export function','function').replaceAll('task: Task','task').replace('): boolean {',') {');
  const context=vm.createContext({...statuses});vm.runInContext(functions,context);
  const ready={status:'video_ready',download_path:'file.mp4',review_status:'pending'};
  assert.equal(context.taskStatusClass(ready),'review_pending');
  assert.equal(context.taskStatusClass({...ready,status:'scheduled'}),'review_pending');
  assert.equal(context.taskStatusClass({...ready,review_status:'approved'}),'video_ready');
  assert.equal(context.taskStatusClass({...ready,download_path:null}),'video_ready');
  assert.equal(context.taskStatusClass({status:'video_generating'}),'video_generating');
  assert.equal(context.taskStatusClass({task_role:'remix',status:'remix_segmented'}),'review_pending');
  assert.equal(context.taskStatusClass({task_role:'remix',status:'remix_done'}),'video_ready');
  assert.equal(context.taskStatusClass({task_role:'remix',status:'remix_finishing'}),'concat_running');
  const css=fs.readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
  assert.match(css,/\.status\.review_pending\s*\{[^}]*background: var\(--accent-soft\)/);

});
