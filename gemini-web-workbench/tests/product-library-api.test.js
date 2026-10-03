const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),path=require('node:path'),vm=require('node:vm'),esbuild=require('esbuild');
test('product and task APIs deduplicate IDs and snapshot the submitted images; reject unrelated or missing images',async()=>{
 const sql=new DatabaseSync(':memory:');
 sql.exec("CREATE TABLE products(id TEXT PRIMARY KEY,external_id TEXT,name TEXT,country TEXT,language TEXT,features TEXT,image_key TEXT,image_name TEXT,created_at TEXT);CREATE TABLE product_images(id TEXT PRIMARY KEY,product_id TEXT,object_key TEXT,file_name TEXT,content_type TEXT,sort_order INTEGER,created_at TEXT);CREATE TABLE reference_remix_tasks(product_id TEXT);CREATE TABLE gems(id TEXT,name TEXT,content TEXT);INSERT INTO gems VALUES('gem','测试 Gem','模板');CREATE TABLE tiktok_accounts(id TEXT,name TEXT,archive_directory TEXT);INSERT INTO tiktok_accounts VALUES('tk','测试账号','C:/fixture');");
 const columns='id product_id gem_id title status prompt provider progress duration region shooting_style callback_token auto_queue gemini_account_id tiktok_account_name archive_directory gem_content_snapshot product_external_id_snapshot gemini_request_text image_keys_snapshot error created_at updated_at';
 sql.exec('CREATE TABLE tasks('+columns.split(' ').map(c=>c+' TEXT').join(',')+')');
 const db={prepare(text){const stmt=sql.prepare(text);const bind=(...args)=>({run:async()=>({meta:stmt.run(...args)}),first:async()=>stmt.get(...args)||null,all:async()=>({results:stmt.all(...args)}),execute:()=>({meta:stmt.run(...args)})});return {bind,...bind()};},batch:async statements=>{sql.exec('BEGIN');try{const result=statements.map(s=>s.execute());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const objects=new Map(),bucket={put:async(k,b)=>objects.set(k,b),delete:async k=>objects.delete(k),head:async k=>objects.has(k)?{}:null};
 const mocks={storage:'export const ensureWorkspace=async()=>{};export const getDb=()=>globalThis.db;export const runtimeEnv=()=>({MEDIA:globalThis.bucket});export const jsonError=(e,status=500)=>Response.json({error:e.message},{status});','provider-config':'export const getProviderConfig=async()=>({config:{mode:"web"},secretConfigured:true});',gemini:'export const generatePrompt=async()=>({prompt:"test"});',seedance:'export const checkSeedance=async()=>{};export const submitSeedance=async()=>{};'};
 const load=async name=>{const result=await esbuild.build({entryPoints:[path.resolve(__dirname,'../../app/api/'+name+'/route.ts')],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/lib\/(storage|provider-config|gemini|seedance)$/},a=>({path:a.path.split('/').pop(),namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}));}}]});const ctx={module:{exports:{}},db,bucket,Response,Request,URL,File,crypto,console};vm.runInNewContext(result.outputFiles[0].text,ctx);return ctx.module.exports;};
 try{
 const products=await load('products'),tasks=await load('tasks');
 const upload=async name=>{const form=new FormData();form.set('externalId','173627418556382511');form.set('name','测试商品');form.append('images',new File([name],name+'.png',{type:'image/png'}));const r=await products.POST(new Request('http://fixture/api/products',{method:'POST',body:form}));assert.ok([200,201].includes(r.status));return r.json();};
 const first=await upload('first'),second=await upload('second');assert.equal(first.id,second.id);assert.equal(second.reused,true);assert.equal(sql.prepare('SELECT count(*) n FROM products').get().n,1);
 const create=keys=>tasks.POST(new Request('http://fixture/api/tasks',{method:'POST',body:JSON.stringify({productId:first.id,gemId:'gem',tiktokAccountName:'测试账号',imageKeys:keys})}));
 const response=await create(first.imageKeys);assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
 assert.deepEqual(JSON.parse(sql.prepare('SELECT image_keys_snapshot FROM tasks').get().image_keys_snapshot),first.imageKeys);
 assert.equal((await create(['products/unrelated/image'])).status,400);assert.equal((await create(['products/'+first.id+'/missing'])).status,400);
 assert.equal((await create(second.imageKeys)).status,201);
 sql.prepare('INSERT INTO products(id,external_id) VALUES(?,?)').run('other','different');
 const edit=async(id,externalId)=>products.PUT(new Request('http://fixture/api/products',{method:'PUT',body:JSON.stringify({id,externalId,name:'edited'})}));
 assert.equal((await edit('other','173627418556382511')).status,409);
 sql.prepare('INSERT INTO products(id,external_id) VALUES(?,?)').run('legacy-duplicate','173627418556382511');
 assert.equal((await edit('legacy-duplicate','173627418556382511')).status,200);
 }finally{sql.close();}
});
