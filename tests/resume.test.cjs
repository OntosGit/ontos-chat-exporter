'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.join(__dirname, '..', 'extension');
const ID = '00000000-0000-4000-8000-000000000003';
const msg = id => ({id, author:{role:'user'}, content:{content_type:'text', parts:[id]}});
const page = (ids, page_info) => ({messages:ids.map(msg),page_info});
const ok = data => ({status:200,ok:true,json:async()=>data,headers:{get:()=>null}});
const bad = (status, retryAfter) => ({status,ok:false,headers:{get:k=>k==='Retry-After' ? retryAfter : null}});
function makeStorage(data = new Map(), flags = {}) {
  return {
    data, flags,
    local: {
      get: async keys => Object.fromEntries((typeof keys==='string'?[keys]:keys || [...data.keys()])
        .filter(k=>data.has(k)).map(k=>[k,data.get(k)])),
      set: async values => {
        if (flags.failPage && Object.keys(values).some(k=>/:before:|:after:/.test(k))) throw new Error('DISK_FULL');
        for (const [k,v] of Object.entries(values)) data.set(k,JSON.parse(JSON.stringify(v)));
      },
      remove: async keys => {for (const k of keys) data.delete(k);},
      getKeys: async () => [...data.keys()]
    }
  };
}
function create(fetchImpl, storage) {
  const sandbox={
    Date, String, Object, Number, Set, Array, URL, console, fetch:fetchImpl,
    setTimeout, clearTimeout,
    chrome:{storage:{local:storage.local}},
    location:{hostname:'chatgpt.com',origin:'https://chatgpt.com',pathname:'/c/'+ID},
    ONTOSCore:{normalizeConversation: x => x}
  };
  sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  for (const file of ['checkpoints.js','live.js'])
    vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),sandbox,{filename:file});
  return {api:sandbox.ONTOSLive,checkpoint:sandbox.ONTOSCheckpoints};
}
const session = url => url === '/api/auth/session';
const initial = page(['middle'],{has_previous_page:true,start_cursor:'old',has_next_page:true,end_cursor:'new'});
const oldest = page(['first'],{has_previous_page:false,has_next_page:true,end_cursor:'cursor-middle'});
const newest = page(['last'],{has_previous_page:true,start_cursor:'cursor-middle',has_next_page:false});

test('incremental batches survive reload and merge pages in chronological order',async()=>{
  const storage=makeStorage();const urls=[];
  const fetcher=async url=>{
    urls.push(String(url));
    if(session(url)) return ok({});
    if(String(url).includes('before=old')) return ok(oldest);
    if(String(url).includes('after=new')) return ok(newest);
    return ok({title:'Synthetic',conversation_id:ID,...initial});
  };
  const first=create(fetcher,storage).api;
  const p1=await first.fetchConversation(ID,()=>{},{maxPages:1});
  assert.equal(p1.ontos_paused,true);
  assert.equal(p1.checkpoint.pages,2);
  assert.equal(p1.checkpoint.messages,2);
  const second=create(fetcher,storage).api;
  const result=await second.fetchConversation(ID,()=>{},{maxPages:1});
  assert.deepEqual(Array.from(result.messages,x=>x.id),['first','middle','last']);
  assert.equal(result.ontos_pagination_audit.pages,3);
  assert.equal(urls.filter(x=>x.endsWith('?num_turns=100')).length,1,'initial HTTP page is never fetched again');
  const before=urls.length;
  const cached=await create(fetcher,storage).api.fetchConversation(ID);
  assert.equal(cached.messages.length,3);
  assert.equal(urls.length,before,'completed archive requires no HTTP fetch');
  const status=await second.status(ID);
  assert.equal(status.complete,true);
  assert.equal(status.pages,3);
});

test('429 preserves the last committed page, honors Retry-After, and resumes exactly once',async()=>{
  const storage=makeStorage();const urls=[];let once=true;
  const fetcher=async url=>{
    urls.push(String(url));
    if(session(url)) return ok({});
    if(String(url).includes('before=old')) return ok(oldest);
    if(String(url).includes('after=new')){
      if(once){once=false;return bad(429,'120');}
      return ok(newest);
    }
    return ok({title:'Synthetic',conversation_id:ID,...initial});
  };
  const a=create(fetcher,storage).api;
  const paused=await a.fetchConversation(ID);
  assert.equal(paused.reason,'rate_limit');
  assert.equal(paused.checkpoint.pages,2);
  assert.ok(paused.checkpoint.retryAt > Date.now()+110_000);
  const count=urls.length;
  const b=create(fetcher,storage).api;
  const still=await b.fetchConversation(ID);
  assert.equal(still.reason,'rate_limit');
  assert.equal(urls.length,count,'cooldown must not hit the server');
  const raw=await create(fetcher,storage).checkpoint.get(ID);
  raw.retryAt=0;
  await storage.local.set({['ontos:conversation-checkpoint:v1:'+ID+':state']:raw});
  const finished=await b.fetchConversation(ID);
  assert.deepEqual(Array.from(finished.messages,x=>x.id),['first','middle','last']);
  assert.equal(urls.filter(x=>x.includes('before=old')).length,1,'previously stored pages are skipped');
  assert.equal(urls.filter(x=>x.includes('after=new')).length,2,'only the refused page is retried');
});

test('a storage write failure cannot advance a page cursor',async()=>{
  const storage=makeStorage(new Map(),{failPage:true});
  const fetcher=async url=>session(url)?ok({}):String(url).includes('before=old')?ok(oldest):ok({title:'Test',conversation_id:ID,...initial});
  const api=create(fetcher,storage).api;
  await assert.rejects(api.fetchConversation(ID),/DISK_FULL/);
  let state=await api.status(ID);
  assert.equal(state.pages,1);
  storage.flags.failPage=false;
  const restored=await create(async url=>session(url)?ok({}):String(url).includes('before=old')?ok(oldest):ok(newest),storage).api.fetchConversation(ID);
  assert.equal(restored.ontos_pagination_audit.pages,3);
  state=await api.status(ID);
  assert.equal(state.complete,true);
});

test('missing page, duplicate messages and looping cursors cannot become complete exports',async()=>{
  const storage1=makeStorage();
  const badFetcher=async url=>session(url)?ok({}):String(url).includes('before=old')?
    ok(page(['middle'],{has_previous_page:false,has_next_page:false})):ok({title:'Duplicates',conversation_id:ID,...page(['middle'],{has_previous_page:true,start_cursor:'old',has_next_page:false})});
  await assert.rejects(create(badFetcher,storage1).api.fetchConversation(ID),/Перекрывающиеся страницы/);
  const storage2=makeStorage();
  const loop=async url=>session(url)?ok({}):ok({title:'Loop',conversation_id:ID,...page(['one'],{has_previous_page:true,start_cursor:'same',has_next_page:false})});
  await assert.rejects(create(loop,storage2).api.fetchConversation(ID),/зациклилась/);
  const storage3=makeStorage();
  const empty=async url=>session(url)?ok({}):String(url).includes('before=old')?ok(page([],{has_previous_page:false,has_next_page:false})):ok({title:'Empty',conversation_id:ID,...page(['one'],{has_previous_page:true,start_cursor:'old',has_next_page:false})});
  await assert.rejects(create(empty,storage3).api.fetchConversation(ID),/Пустая промежуточная страница/);
});

test('reset removes only this chat checkpoint and permits a fresh initial request',async()=>{
  const storage=makeStorage();let calls=0;
  const fetcher=async url=>{
    if(session(url)) return ok({});
    calls++;
    return ok({title:'Single',conversation_id:ID,...page(['only'],{has_previous_page:false,has_next_page:false})});
  };
  const api=create(fetcher,storage).api;
  await api.fetchConversation(ID);
  await api.fetchConversation(ID);
  assert.equal(calls,1);
  await api.reset(ID);
  assert.equal(await api.status(ID),null);
  await api.fetchConversation(ID);
  assert.equal(calls,2);
  assert.equal(storage.data.size,2);
});

test('rejects unauthorized conversation IDs and never calls non-ChatGPT hosts',async()=>{
  const urls=[];const storage=makeStorage();
  const api=create(async url=>{urls.push(url);return ok({})},storage).api;
  await assert.rejects(api.fetchConversation('bad-id'),/Неверный идентификатор/);
  assert.equal(urls.length,0);
});
