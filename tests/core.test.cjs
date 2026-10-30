'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.join(__dirname, '..');
const loadJSON = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const sandbox = {Date, String, Object, Number, Set, Array, URL, console};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(base, 'extension/core.js'), 'utf8'), sandbox);
const core = sandbox.ONTOSCore;

test('synthetic sequence filters internal records while preserving actual text', () => {
  const model = core.normalizeConversation(loadJSON('synthetic-thread.json'));
  assert.equal(model.sourceMessages, 5);
  assert.equal(model.visibleMessages, 3);
  assert.equal(model.serviceMessages, 2);
  assert.equal(model.nonTextCount, 1);
  assert.equal(model.verified, true);
  assert.equal(model.messages[0].role, 'user');
  assert.match(model.messages[0].text, /<script>alert\(1\)<\/script>/);
  assert.ok(!model.messages.some(m => m.text.includes('internal placeholder')));
});

test('HTML text is escaped rather than executable', () => {
  const html = core.renderHTML(core.normalizeConversation(loadJSON('synthetic-thread.json')));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /Сообщений в HTML: <b>3<\/b>/);
});

test('Markdown contains the original chat content and an attachment marker', () => {
  const md = core.renderMarkdown(core.normalizeConversation(loadJSON('synthetic-thread.json')));
  assert.match(md, /console\.log\('demo'\)/);
  assert.match(md, /Нетекстовое вложение: image_asset_pointer/);
  assert.ok(!md.includes('Synthetic tool output stays'));
});

test('a conversation tree exports the active parent chain, not the alternative branch', () => {
  const model = core.normalizeConversation(loadJSON('synthetic-tree.json'));
  assert.equal(model.sourceMessages, 4);
  assert.equal(model.pathMessages, 3);
  assert.equal(model.branchMessages, 1);
  assert.equal(model.visibleMessages, 3);
  assert.ok(!core.renderMarkdown(model).includes('Unused alternative branch'));
});

test('broken parent pointers fail closed', () => {
  const data = loadJSON('synthetic-tree.json');
  data.mapping['node-c'].parent = 'nonexistent';
  assert.throws(() => core.normalizeConversation(data), /недостающем узле/);
});

test('a cycle in the parent chain fails closed', () => {
  const data = loadJSON('synthetic-tree.json');
  data.mapping['node-a'].parent = 'node-c';
  assert.throws(() => core.normalizeConversation(data), /Повтор узла/);
});

test('incomplete pages fail closed; missing page information produces a warning', () => {
  const bad = loadJSON('synthetic-thread.json');
  bad.page_info.has_previous_page = true;
  assert.throws(() => core.normalizeConversation(bad), /неполной пагинации/);
  const unknown = loadJSON('synthetic-thread.json');
  delete unknown.page_info;
  const model = core.normalizeConversation(unknown);
  assert.equal(model.verified, false);
  assert.ok(model.warnings.length > 0);
});

test('duplicate source message IDs fail closed', () => {
  const data = loadJSON('synthetic-thread.json');
  data.messages[1].id = data.messages[0].id;
  assert.throws(() => core.normalizeConversation(data), /повторяющиеся идентификаторы/);
});

test('filename sanitizer rejects slash and control characters', () => {
  const slug = core.safeSlug('folder/sub\u0000name: demo');
  assert.equal(slug.includes('/'), false);
  assert.equal(slug.includes('\u0000'), false);
});
