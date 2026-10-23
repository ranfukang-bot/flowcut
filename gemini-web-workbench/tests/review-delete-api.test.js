const test=require('node:test');const assert=require('node:assert/strict');
const {siteFixture}=require('./helpers/site-routes.cjs');
test('real review API SQL reserves deletion against approval and deletes only its task and schedule',async t=>{
  const f=await siteFixture(t),at=new Date().toISOString();
  for(const id of ['pending','approved']) f.sqlite.prepare("INSERT INTO tasks(id,product_id,gem_id,title,status,prompt,provider,download_path,review_status,created_at,updated_at) VALUES(?,'p','g',?,'video_ready','','seedance-bridge',?,?,?,?)").run(id,id,id+'.mp4',id,at,at);
  for(const id of ['pending','approved'])f.sqlite.prepare("INSERT INTO schedules(id,task_id,account_name,scheduled_at,created_at) VALUES(?,?,'tk',?,?)").run(id,id,at,at);
  const post=(id,action,confirmed=true)=>f.call('tasks/review','POST',{body:{id,action,confirmed}});
  assert.equal((await post('pending','reserve-delete',false)).status,400);
  assert.equal((await post('approved','reserve-delete')).status,409);
  assert.equal((await post('pending','delete-pending')).status,409);
  assert.equal((await post('pending','reserve-delete')).status,200);
  assert.equal((await post('pending','reserve')).status,409);
  assert.equal((await post('pending','reserve-delete')).status,200);
  assert.equal((await post('pending','delete-pending')).status,200);
  assert.equal((await post('pending','delete-pending')).status,200);
  assert.deepEqual(f.rows('SELECT id FROM tasks').map(r=>r.id),['approved']);
  assert.deepEqual(f.rows('SELECT task_id FROM schedules').map(r=>r.task_id),['approved']);
});
