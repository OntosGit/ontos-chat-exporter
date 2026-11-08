'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
const ID = '00000000-0000-4000-8000-000000000003';

function locksForTabs() {
  const tails = new Map();
  const calls = [];
  return {
    calls,
    request(name, options, callback) {
      assert.equal(options.mode, 'exclusive');
      calls.push(name);
      const prior = tails.get(name) || Promise.resolve();
      const current = prior.then(callback, callback);
      tails.set(name, current.catch(() => {}));
      return current;
    }
  };
}

function tab(live, locks, id = ID) {
  let handler;
  const sandbox = {
    navigator: locks === null ? {} : {locks},
    location: {hostname:'chatgpt.com', pathname:'/c/' + id},
    chrome: {runtime: {
      onMessage: {addListener: callback => {handler = callback;}},
      sendMessage: () => Promise.resolve()
    }},
    ONTOSLive: live,
    ONTOSCheckpoints: {},
    ONTOSCore: {
      normalizeConversation: () => ({
        title:'Synthetic', visibleMessages:1, sourceMessages:1,
        branchMessages:0, nonTextCount:0, verified:true
      }),
      safeSlug: () => 'synthetic',
      downloadText: () => {},
      renderMarkdown: () => 'synthetic',
      renderHTML: () => 'synthetic'
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, {filename:'content.js'});
  return {send: request => new Promise(resolve => {
    assert.equal(handler(request, {}, resolve), true);
  })};
}

test('reset in another tab waits for an in-flight export of the same conversation', async () => {
  const locks = locksForTabs();
  let started, release, resets = 0;
  const entered = new Promise(resolve => {started = resolve;});
  const suspended = new Promise(resolve => {release = resolve;});
  const a = tab({
    fetchConversation: async () => {started(); return suspended;},
    status: async () => ({complete:true})
  }, locks);
  const b = tab({reset: async () => {resets += 1;}}, locks);
  const exporting = a.send({kind:'ONTOS_EXPORT', format:'md', maxPages:5});
  await entered;
  const resetting = b.send({kind:'ONTOS_RESET'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resets, 0, 'second tab must not delete pages while first tab exports');
  release({messages:[], page_info:{has_previous_page:false, has_next_page:false}});
  assert.equal((await exporting).ok, true);
  assert.equal((await resetting).ok, true);
  assert.equal(resets, 1);
  assert.equal(locks.calls.length, 2);
  assert.equal(locks.calls[0], locks.calls[1], 'both tabs lock the same conversation');
});

test('reset is fail-closed when cross-tab locking is unavailable', async () => {
  let resets = 0;
  const b = tab({reset: async () => {resets += 1;}}, null);
  const result = await b.send({kind:'ONTOS_RESET'});
  assert.equal(result.ok, false);
  assert.match(result.message, /Межвкладочная блокировка недоступна/);
  assert.equal(resets, 0);
});

test('same-tab second request cannot overtake a reset awaiting another tab', async () => {
  const locks = locksForTabs();
  let started, release;
  const entered = new Promise(resolve => {started = resolve;});
  const suspended = new Promise(resolve => {release = resolve;});
  const first = tab({
    fetchConversation: async () => {started(); return suspended;},
    status: async () => ({complete:true})
  }, locks);
  let resets = 0, exports = 0;
  const second = tab({
    reset: async () => {resets++;},
    fetchConversation: async () => {exports++; return {messages:[]};}
  }, locks);
  const exporting = first.send({kind:'ONTOS_EXPORT', format:'md', maxPages:5});
  await entered;
  const resetting = second.send({kind:'ONTOS_RESET'});
  await new Promise(resolve => setImmediate(resolve));
  const overlapping = await second.send({kind:'ONTOS_EXPORT', format:'md', maxPages:1});
  assert.equal(overlapping.ok, false);
  assert.match(overlapping.message, /Экспорт уже выполняется/);
  release({messages:[]});
  assert.equal((await exporting).ok, true);
  assert.equal((await resetting).ok, true);
  assert.equal(resets, 1);
  assert.equal(exports, 0);
});
