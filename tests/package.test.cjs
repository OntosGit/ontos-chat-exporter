'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=path.join(__dirname,'..');
const text=p=>fs.readFileSync(path.join(base,p),'utf8');

test('manifest declares minimal permissions, no capture or tracking capabilities',()=>{
  const manifest=JSON.parse(text('extension/manifest.json'));
  assert.equal(manifest.manifest_version,3);
  assert.deepEqual(manifest.permissions,['activeTab','storage','unlimitedStorage']);
  assert.deepEqual(manifest.host_permissions,['https://chatgpt.com/*']);
  assert.equal(manifest.content_scripts[0].all_frames,false);
  assert.equal(manifest.version,'1.4.0');
  assert.ok(manifest.content_scripts[0].js.indexOf('checkpoints.js') < manifest.content_scripts[0].js.indexOf('live.js'));
});

test('popup chooses the active tab only',()=>{
  const source=text('extension/popup.js');
  assert.ok(source.includes('active:true, currentWindow:true'));
  assert.ok(source.includes("ping.version !== '1.4.0'"));
});

test('Reader shares the same pure conversation core as the extension',()=>{
  const html=text('reader/ONTOS_Reader.html');
  const embedded=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(embedded);
  assert.equal(embedded[1],text('extension/core.js'));
});

test('public release contains no account conversation dump or identifying IDs',()=>{
  const candidates=['README.md','README.ru.md','PRIVACY.md','SECURITY.md','CHANGELOG.md','extension/core.js','extension/checkpoints.js','extension/live.js','extension/popup.js'];
  for (const p of candidates) {
    const s=text(p);
    assert.equal(/(?:[A-Za-z]:\\Users\\|@gmail\.com|@yandex\.ru|Bearer\s+eyJ|-----BEGIN PRIVATE KEY-----)/i.test(s),false,p);
  }
});
