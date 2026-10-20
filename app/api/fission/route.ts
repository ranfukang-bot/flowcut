import { ensureWorkspace,getDb,jsonError,runtimeEnv } from '../../../lib/storage';
import { getProviderConfig } from '../../../lib/provider-config';
import { DEFAULT_GEM_REQUEST,renderGemRequest } from '../../../lib/gem-request';
import { validateFissionInput,type FissionInput } from '../../../lib/fission';
import { validateTikTokAccountName } from '../../../lib/tiktok-accounts';
import { taskDetail } from '../../../lib/task-list';

export async function GET() {
  try {
    await ensureWorkspace();
    const db=getDb();
    const rows=await db.prepare("SELECT id FROM tasks WHERE task_role='fission' ORDER BY created_at DESC,id DESC LIMIT 100").all<{id:string}>();
    return Response.json({batches:await Promise.all(rows.results.map(row=>taskDetail(db,row.id)))},{headers:{'cache-control':'no-store'}});
  } catch(error){return jsonError(error);}
}

export async function POST(request:Request) {
  try {
    await ensureWorkspace();
    const body=await request.json() as FissionInput;
    const input=validateFissionInput(body),db=getDb();
    if((await getProviderConfig('gemini')).config.mode!=='web') return Response.json({error:'多品裂变需要 Gemini 网页模式'},{status:400});
    const accountName=validateTikTokAccountName(body.tiktokAccountName);
    const account=await db.prepare('SELECT archive_directory FROM tiktok_accounts WHERE lower(name)=lower(?)').bind(accountName).first<{archive_directory:string}>();
    if(!account) throw Error('请选择已有的 TK 归档账号');
    const gem=async(id:string)=>db.prepare('SELECT id,name,content FROM gems WHERE id=?').bind(id).first<{id:string;name:string;content:string}>();
    const variant=await gem(body.variantGemId);
    const mother=body.motherSource==='generate'?await gem(body.motherGemId!):variant;
    if(!variant?.content?.trim() || !mother?.content?.trim()) throw Error('所选 Gem 已删除或内容为空');
    const products=[];
    for(const row of body.products){
      const product=await db.prepare('SELECT id,name,external_id FROM products WHERE id=?').bind(row.productId).first<{id:string;name:string;external_id:string}>();
      if(!product?.external_id?.trim()) throw Error('每个商品都必须有商品 ID');
      const images=await db.prepare('SELECT object_key FROM product_images WHERE product_id=? ORDER BY sort_order,id').bind(row.productId).all<{object_key:string}>();
      const keys=row.imageKeys ?? images.results.map(i=>i.object_key);
      if(!Array.isArray(keys) || !keys.length || keys.length>12 || keys.some(key=>typeof key!=='string'||!key.startsWith(`products/${product.id}/`)||key.includes('..')) || !runtimeEnv().MEDIA || (await Promise.all(keys.map(key=>runtimeEnv().MEDIA!.head(key)))).some(image=>!image)) throw Error('商品图片无效或缺失，请重新上传');
      products.push({...product,keys});
    }
    if(new Set(products.map(p=>p.external_id.trim().toLowerCase())).size!==products.length) throw Error('同一批商品 ID 不能重复');
    const id=body.requestId || crypto.randomUUID(),at=new Date().toISOString();
    const exists=await db.prepare('SELECT id,task_role FROM tasks WHERE id=?').bind(id).first<{id:string;task_role:string}>();
    if(exists) return exists.task_role==='fission'?Response.json({id,created:false}):Response.json({error:'请求标识冲突'},{status:409});
    const master=products.find(p=>p.id===input.motherProductId)!;
    const pasted=body.motherSource==='paste';
    const common=[input.duration,input.region,input.shooting_style,body.autoQueue===false?0:1,accountName,account.archive_directory||''];
    const statement=(row:typeof master,child:boolean,index:number)=>db.prepare(`INSERT INTO tasks
      (id,product_id,gem_id,title,status,prompt,provider,progress,duration,region,shooting_style,auto_queue,tiktok_account_name,archive_directory,
       callback_token,gem_content_snapshot,product_external_id_snapshot,image_keys_snapshot,gemini_request_text,
       task_role,batch_parent_id,batch_index,batch_size,variant_gem_id,variant_gem_snapshot,variant_request_text,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'gemini-web',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        child?`${id}-p${index}`:id,row.id,child?variant.id:mother.id,
        child?(row.name||row.external_id):`多品裂变 · ${products.length} 个商品`,
        child?(pasted?'variant_queued':'fission_wait'):(pasted?'fission_ready':'prompt_queued'),child?'':(pasted?input.motherPrompt:''),child? (pasted?36:0):(pasted?100:5),
        ...common,crypto.randomUUID(),child?variant.content:mother.content,row.external_id.trim(),JSON.stringify(row.keys),
        renderGemRequest(DEFAULT_GEM_REQUEST,{duration:input.duration,region:input.region,shooting_style:input.shooting_style}),
        child?'fission_child':'fission',child?id:null,child?index:null,products.length,variant.id,variant.content,input.variantRequest,at,at);
    await db.batch([statement(master,false,0),...products.map((p,i)=>statement(p,true,i+1))]);
    return Response.json({id,created:true},{status:201});
  } catch(error){return jsonError(error,400);}
}
