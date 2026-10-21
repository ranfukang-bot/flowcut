// Runs the real site API routes against an in-memory SQLite database that
// behaves like the local D1 binding. The schema comes from lib/storage.ts
// itself, so tests always see the same columns as the desktop app.
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path');
const esbuild=require('esbuild');

const ROOT=path.resolve(__dirname,'../../..');
const STUBS={
  'cloudflare:workers':'export const env=new Proxy({},{get:(_,key)=>globalThis.__flowcutFixture.env[key]});',
  'provider-config':`export const getProviderConfig=async name=>globalThis.__flowcutFixture.providers[name];
    export const readPath=(value,dotted)=>String(dotted||'').split('.').reduce((v,k)=>v==null?v:v[k],value);`,
  seedance:`export const submitSeedance=async input=>{globalThis.__flowcutFixture.seedanceCalls.push(input);return {};};
    export const checkSeedance=async()=>({});`,
};
const compiled=new Map();

async function bundle(route) {
  if (!compiled.has(route)) {
    compiled.set(route, esbuild.build({
      entryPoints:[path.join(ROOT,'app/api',route,'route.ts')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent',
      plugins:[{name:'fixture',setup(build){
        build.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare:workers',namespace:'fixture'}));
        // lib/provider-config and lib/seedance, however they are imported.
        build.onResolve({filter:/(?:^|\/)(provider-config|seedance)$/},args=>{
          const name=args.path.split('/').pop();
          return path.resolve(args.resolveDir,args.path)===path.join(ROOT,'lib',name)?{path:name,namespace:'fixture'}:undefined;
        });
        build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:STUBS[args.path],loader:'js'}));
      }}],
    }).then(result=>result.outputFiles[0].text));
  }
  return compiled.get(route);
}

function d1(sqlite) {
  const value=v=>v===undefined?null:typeof v==='boolean'?Number(v):v;
  const statement=(sql,args=[])=>{
    const run=()=>{const prepared=sqlite.prepare(sql);return prepared;};
    return {
      bind:(...next)=>statement(sql,next.map(value)),
      first:async column=>{const row=run().get(...args);if(!row)return null;return column?row[column]:{...row};},
      all:async()=>({results:run().all(...args).map(row=>({...row}))}),
      run:async()=>({meta:run().run(...args)}),
      raw:async()=>run().all(...args).map(row=>Object.values(row)),
      execute:()=>({meta:run().run(...args)}),
    };
  };
  return {
    prepare:sql=>statement(sql),
    batch:async statements=>{
      sqlite.exec('BEGIN');
      try {const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
}

// Each fixture loads fresh copies of the routes, so module-level caches such
// as the workspace initialisation never leak between tests.
async function siteFixture(t,{seedance={mode:'local-api',secretConfigured:true},gemini={mode:'web',secretConfigured:false}}={}) {
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  const objects=new Map();
  const fixture={
    sqlite,
    objects,
    seedanceCalls:[],
    env:{DB:d1(sqlite),MEDIA:{head:async key=>objects.has(key)?{key}:null,put:async(key,body)=>objects.set(key,body),delete:async key=>objects.delete(key)}},
    providers:{
      seedance:{config:{mode:seedance.mode},secretConfigured:seedance.secretConfigured,secrets:{apiKey:'bridge-key'}},
      gemini:{config:{mode:gemini.mode},secretConfigured:gemini.secretConfigured,secrets:{}},
    },
  };
  const modules=new Map();
  async function route(name) {
    if (!modules.has(name)) {
      const module={exports:{}};
      new Function('module','exports','require',await bundle(name))(module,module.exports,require);
      modules.set(name,module.exports);
    }
    globalThis.__flowcutFixture=fixture;
    return modules.get(name);
  }
  async function call(name,method,{query='',body,headers={}}={}) {
    const handler=(await route(name))[method];
    const init={method,headers:{'content-type':'application/json',authorization:'Bearer bridge-key',...headers}};
    if (body!==undefined) init.body=JSON.stringify(body);
    const response=await handler(new Request(`http://fixture/api/${name}${query}`,init));
    return {status:response.status,body:await response.json()};
  }
  fixture.route=route;
  fixture.call=call;
  fixture.rows=(sql,...args)=>sqlite.prepare(sql).all(...args).map(row=>({...row}));
  fixture.row=(sql,...args)=>{const row=sqlite.prepare(sql).get(...args);return row?{...row}:null;};
  // Real schema from lib/storage.ts: the first API call initialises it.
  await call('tasks','GET',{query:'?status=all'});
  return fixture;
}

module.exports={siteFixture};
