import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { approvalDay, APPROVAL_COUNT_INSERT } from '../lib/approval-stats.ts';

test('approval dates use the desktop timezone, including midnight and DST',()=>{
  assert.equal(approvalDay('2026-10-01T16:01:00Z','Asia/Shanghai'),'2026-10-02');
  assert.equal(approvalDay('2026-10-01T15:59:00Z','Asia/Shanghai'),'2026-10-01');
  assert.equal(approvalDay('2026-07-02T06:59:00Z','America/Los_Angeles'),'2026-07-01');
  assert.throws(()=>approvalDay('invalid','Asia/Shanghai'));
  assert.throws(()=>approvalDay('2026-01-01','bad-timezone'));
});

test('one count per approved task survives clearing and excludes pending, failed and remakes',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,tiktok_account_name TEXT,review_status TEXT,reviewed_at TEXT);
      CREATE TABLE approval_counts(task_id TEXT PRIMARY KEY,account_name TEXT,day_key TEXT,approved_at TEXT);`);
    const add=db.prepare('INSERT INTO tasks VALUES(?,?,?,?)');
    add.run('a','账号1','approved','2026-10-01T16:01:00Z');
    add.run('b','账号2','approved','2026-10-01T16:02:00Z');
    add.run('c','账号1','pending',null);add.run('d','账号1','replaced',null);
    const record=db.prepare(APPROVAL_COUNT_INSERT);
    for(const id of ['a','a','b','c','d'])record.run('2026-10-02',id);
    record.run('2026-10-03','a');
    db.exec('DELETE FROM tasks');
    assert.deepEqual(db.prepare('SELECT day_key,account_name,COUNT(*) n FROM approval_counts GROUP BY day_key,account_name').all().map(r=>({...r})),[
      {day_key:'2026-10-02',account_name:'账号1',n:1},{day_key:'2026-10-02',account_name:'账号2',n:1},
    ]);
  }finally{db.close();}
});
