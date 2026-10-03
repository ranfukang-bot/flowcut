const test=require('node:test');const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const path=require('node:path');const vm=require('node:vm');
const esbuild=require('esbuild');

test('real review API SQL reserves deletion against approval and deletes only its task and schedule',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,review_status TEXT,status TEXT,download_path TEXT);
    CREATE TABLE schedules(task_id TEXT);
    INSERT INTO tasks VALUES('pending','pending','video_ready','p.mp4'),('approved','approved','video_ready','a.mp4');
    INSERT INTO schedules VALUES('pending'),('approved');`);
  const db={prepare(sql){const stmt=sqlite.prepare(sql);return {bind(...args){return {run:async()=>({meta:stmt.run(...args)}),first:async()=>stmt.get(...args)||null};}};},batch:async statements=>{sqlite.exec('BEGIN');try{const result=[];for(const stmt of statements)result.push(await stmt.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  try{
    const build=await esbuild.build({entryPoints:[path.resolve(__dirname,'../../app/api/tasks/review/route.ts')],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'isolated-storage',setup(b){b.onResolve({filter:/lib\/storage$/},()=>({path:'storage',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const ensureWorkspace=async()=>{};export const getDb=()=>globalThis.fixtureDb;export const jsonError=e=>Response.json({error:e.message},{status:500});',loader:'js'}));}}]});
    const context={module:{exports:{}},exports:{},fixtureDb:db,Response,console};vm.runInNewContext(build.outputFiles[0].text,context);
    const post=async(id,action,confirmed=true)=>context.module.exports.POST(new Request('http://fixture/api/tasks/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,action,confirmed})}));
    assert.equal((await post('pending','reserve-delete',false)).status,400);
    assert.equal((await post('approved','reserve-delete')).status,409);
    assert.equal((await post('pending','delete-pending')).status,409);
    assert.equal((await post('pending','reserve-delete')).status,200);
    assert.equal((await post('pending','reserve')).status,409);
    assert.equal((await post('pending','reserve-delete')).status,200);
    assert.equal((await post('pending','delete-pending')).status,200);
    assert.equal((await post('pending','delete-pending')).status,200);
    assert.deepEqual(sqlite.prepare('SELECT id FROM tasks').all().map(r=>r.id),['approved']);
    assert.deepEqual(sqlite.prepare('SELECT task_id FROM schedules').all().map(r=>r.task_id),['approved']);
  }finally{sqlite.close();}
});
