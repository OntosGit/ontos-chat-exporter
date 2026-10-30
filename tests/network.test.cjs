'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.join(__dirname, '..');
const ID = '00000000-0000-4000-8000-000000000003';
const message = id => ({id, author:{role:'user'}, content:{content_type:'text', parts:[id]}});
const ok = data => ({status:200, ok:true, json:async()=>data});
const bad = status => ({status, ok:false, json:async()=>({})});
function create(fetchImpl) {
  const sandbox = {
    Date, String, Object, Number, Set, Array, URL, console,
    fetch: fetchImpl, setTimeout, clearTimeout,
    location: {hostname:'chatgpt.com', origin:'https://chatgpt.com', pathname:'/c/'+ID},
    document: {createElement:()=>({style:{}, setAttribute(){},append(){},remove(){}}), body:{appendChild(){}}}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(base,'extension/core.js'),'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(base,'extension/live.js'),'utf8'), sandbox);
  return sandbox.ONTOSLive;
}

test('reads all pages from a single conversation using first-party requests only', async () => {
  const requests = [];
  const api = create(async (url, options) => {
    requests.push({url:String(url), options});
    if (url === '/api/auth/session') return ok({accessToken:'synthetic-token-for-test-only'});
    if (String(url).includes('before=cursor-old')) return ok({messages:[message('first')], page_info:{has_previous_page:false,has_next_page:true,end_cursor:'new-end'}});
    if (String(url).includes('after=cursor-new')) return ok({messages:[message('last')], page_info:{has_previous_page:true,has_next_page:false,start_cursor:'old-start'}});
    return ok({title:'Synthetic',conversation_id:ID,messages:[message('middle')],page_info:{has_previous_page:true,start_cursor:'cursor-old',has_next_page:true,end_cursor:'cursor-new'}});
  });
  const result = await api.fetchConversation(ID, ()=>{});
  assert.equal(result.messages.length, 3);
  assert.deepEqual(Array.from(result.messages, x=>x.id), ['first','middle','last']);
  assert.equal(result.ontos_pagination_audit.pages,3);
  assert.ok(requests.every(x=>x.url.startsWith('https://chatgpt.com/') || x.url==='/api/auth/session'));
  const apiReqs = requests.filter(x=>x.url.startsWith('https://chatgpt.com/'));
  assert.ok(apiReqs.every(x=>x.options.headers.Authorization === 'Bearer synthetic-token-for-test-only'));
});

test('HTTP 500 does not turn into a pretend successful export', async () => {
  const api=create(async url => url === '/api/auth/session' ? ok({}) : bad(500));
  await assert.rejects(api.fetchConversation(ID,()=>{}), /HTTP 500/);
});

test('looping cursors are rejected', async () => {
  const api=create(async url => {
    if (url === '/api/auth/session') return ok({});
    return ok({title:'Loop',conversation_id:ID,messages:[message('again')],page_info:{has_previous_page:true,has_next_page:false,start_cursor:'same'}});
  });
  await assert.rejects(api.fetchConversation(ID,()=>{}), /зациклилась/);
});

test('the tool rejects invalid conversation IDs before making HTTP requests', async () => {
  let called=false;
  const api=create(async ()=>{called=true; return ok({});});
  await assert.rejects(api.fetchConversation('wrong',()=>{}), /Неверный идентификатор/);
  assert.equal(called,false);
});
