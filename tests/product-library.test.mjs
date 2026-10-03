import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {saveLibraryProduct} from '../lib/product-library.ts';

function fixture(t) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(`CREATE TABLE products(id TEXT PRIMARY KEY,external_id TEXT,name TEXT,country TEXT,language TEXT,features TEXT,image_key TEXT,image_name TEXT,created_at TEXT);
    CREATE TABLE product_images(id TEXT PRIMARY KEY,product_id TEXT,object_key TEXT,file_name TEXT,content_type TEXT,sort_order INTEGER,created_at TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,product_id TEXT,image_keys_snapshot TEXT);
    CREATE TABLE reference_remix_tasks(product_id TEXT);`);
  const db={prepare(text){const stmt=sql.prepare(text);return {bind(...args){return {run:async()=>({meta:stmt.run(...args)}),first:async()=>stmt.get(...args)||null,all:async()=>({results:stmt.all(...args)}),execute:()=>({meta:stmt.run(...args)})};}};},batch:async statements=>{sql.exec('BEGIN');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const objects=new Map();const bucket={put:async(key,bytes)=>objects.set(key,Buffer.from(bytes)),delete:async key=>objects.delete(key)};
  const input=(externalId,bytes='new')=>({externalId,name:'测试商品',files:[new File([bytes],'商品.png',{type:'image/png'})]});
  return {sql,db,bucket,objects,input};
}

test('same long product ID reuses its record, replaces current images and preserves task snapshots',async t=>{
  const f=fixture(t),id='173627418556382511';
  const first=await saveLibraryProduct(f.db,f.bucket,f.input(id,'original'));
  f.sql.prepare('INSERT INTO tasks VALUES(?,?,?)').run('legacy',first.id,null);
  f.sql.prepare('INSERT INTO tasks VALUES(?,?,?)').run('frozen',first.id,JSON.stringify(first.imageKeys));
  const second=await saveLibraryProduct(f.db,f.bucket,f.input(' '+id+' ','latest'));
  assert.equal(second.id,first.id);assert.equal(second.reused,true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM products').get().n,1);
  assert.equal(f.sql.prepare('SELECT external_id FROM products').get().external_id,id);
  for(const task of f.sql.prepare('SELECT * FROM tasks').all())assert.deepEqual(JSON.parse(task.image_keys_snapshot),first.imageKeys);
  assert.equal(f.objects.get(first.imageKeys[0]).toString(),'original');
  assert.equal(f.objects.get(second.imageKeys[0]).toString(),'latest');
  assert.deepEqual(f.sql.prepare('SELECT object_key FROM product_images').all().map(r=>r.object_key),second.imageKeys);
});

test('concurrent submissions resolve one identity but retain their own submitted images',async t=>{
  const f=fixture(t);
  const results=await Promise.all(Array.from({length:8},(_,i)=>saveLibraryProduct(f.db,f.bucket,f.input('173627418556382511','image-'+i))));
  assert.equal(new Set(results.map(r=>r.id)).size,1);assert.equal(results.filter(r=>!r.reused).length,1);
  results.forEach((r,i)=>assert.equal(f.objects.get(r.imageKeys[0]).toString(),'image-'+i));
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM products').get().n,1);
});

test('blank IDs stay separate and old duplicate records are preserved without creating another',async t=>{
  const f=fixture(t);const a=await saveLibraryProduct(f.db,f.bucket,f.input(''));const b=await saveLibraryProduct(f.db,f.bucket,f.input(' '));assert.notEqual(a.id,b.id);
  f.sql.prepare('INSERT INTO products(id,external_id,name,created_at) VALUES(?,?,?,?)').run('old','123456789012345678','old','2025-01-01');
  f.sql.prepare('INSERT INTO products(id,external_id,name,created_at) VALUES(?,?,?,?)').run('recent','123456789012345678','recent','2026-01-01');
  const reused=await saveLibraryProduct(f.db,f.bucket,f.input('123456789012345678'));assert.equal(reused.id,'recent');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM products').get().n,4);
});

test('failed upload cannot remove an existing product or its images',async t=>{
  const f=fixture(t);const first=await saveLibraryProduct(f.db,f.bucket,f.input('123456789012345678','keep'));
  await assert.rejects(saveLibraryProduct(f.db,{...f.bucket,put:async()=>{throw Error('network failed');}},f.input('123456789012345678')),/network failed/);
  assert.equal(f.objects.get(first.imageKeys[0]).toString(),'keep');assert.equal(f.sql.prepare('SELECT image_key FROM products').get().image_key,first.imageKeys[0]);
});

test('failure of the first claimant cannot delete an identity being filled by another upload',async t=>{
  const f=fixture(t);let release;const gate=new Promise(r=>release=r);
  const broken=saveLibraryProduct(f.db,{...f.bucket,put:async()=>{await gate;throw Error('failed');}},f.input('123456789012345678'));
  const success=await saveLibraryProduct(f.db,f.bucket,f.input('123456789012345678','keep'));release();await assert.rejects(broken,/failed/);
  assert.equal(f.sql.prepare('SELECT id FROM products').get().id,success.id);assert.equal(f.objects.get(success.imageKeys[0]).toString(),'keep');
});
