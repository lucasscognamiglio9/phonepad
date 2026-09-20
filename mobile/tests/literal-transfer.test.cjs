const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const caps = {version:1,session:'session-one',textMode:'literal-block',maxTextBytes:131072,maxChunkBytes:16384,maxChunks:128,maxOperations:64};
function harness() {
  const calls = [], chunks = []; let manifest, state='receiving', capability={...caps}, epoch=null, loseCommit=false, failChunk=false, loseCancel=false, bytes=0;
  const exported = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/literal-transfer.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{exports:exported,AbortController,setTimeout,clearTimeout,
    require:name=>name==='buffer'?require('buffer'):{randomUUID:crypto.randomUUID,CryptoDigestAlgorithm:{SHA256:'sha256'},
      digestStringAsync:async(_,text)=>crypto.createHash('sha256').update(text).digest('hex')},
    fetch:async(url,options)=>{
      assert.equal(options.headers.Origin,'https://host');assert.equal(options.credentials,'include');
      const body=JSON.parse(options.body);calls.push(body);
      if(body.op==='begin') {manifest=body.manifest;state='receiving';}
      if(body.op==='chunk') {if(failChunk) throw Error('lost chunk');const chunk=Buffer.from(body.data,'base64');chunks.push(chunk);bytes+=chunk.length;}
      if(body.op==='cancel') {state='cancelled';if(loseCancel) throw Error('lost cancel receipt');}
      if(body.op==='commit') {state='dispatched';if(loseCommit) throw Error('lost receipt');}
      return {ok:true,json:async()=>({...manifest,state,receivedBytes:bytes,nextChunk:chunks.length})};
    }});
  const transfer=new exported.LiteralTransfer('https://host',()=>capability,()=>epoch);
  return {transfer,calls,chunks,exported,setEpoch:value=>{epoch=value;},loseCommit:()=>{loseCommit=true;},failChunk:()=>{failChunk=true;},loseCancel:()=>{loseCancel=true;},disconnect:()=>{capability=null;}};
}
test('v2 text uses the current control epoch while recovery retains the original text lease',async()=>{
 const h=harness();h.setEpoch('epoch-one');h.loseCommit();await assert.rejects(h.transfer.send('¿Texto_ íntegro?'));
 assert.ok(h.calls.every(c=>c.sessionEpoch==='epoch-one'));
 const lease=h.transfer.pending.manifest.session;
 h.disconnect();h.setEpoch('epoch-two');assert.equal((await h.transfer.status()).state,'dispatched');
 assert.equal(h.calls.at(-1).sessionEpoch,'epoch-two');assert.equal(h.calls.at(-1).session,lease);
});
test('large literal text crosses UTF-8 chunk boundaries and commits only after all bytes',async()=>{
 const h=harness();const text=('¿_👨‍👩‍👧‍👦\r\ne\u0301').repeat(2800);
 const receipt=await h.transfer.send(text);
 assert.equal(receipt.state,'dispatched');assert.equal(Buffer.concat(h.chunks).toString('utf8'),text);
 assert.equal(receipt.sha256,crypto.createHash('sha256').update(text).digest('hex'));
 assert.equal(h.calls[0].op,'begin');assert.equal(h.calls.at(-1).op,'commit');
 assert.equal(h.calls.filter(c=>c.op==='commit').length,1);
 assert.ok(h.chunks.every(c=>c.length<=16384));
});
test('lost commit receipt retains identity and only a status query recovers it',async()=>{
 const h=harness();h.loseCommit();await assert.rejects(h.transfer.send('texto'));
 const id=h.transfer.pending.manifest.operationId;
 await assert.rejects(h.transfer.send('texto'));
 h.disconnect();assert.equal((await h.transfer.status()).state,'dispatched');
 assert.equal(h.calls.at(-1).op,'status');assert.equal(h.calls.at(-1).operationId,id);
 assert.equal(h.calls.filter(c=>c.op==='commit').length,1);
 await h.transfer.reviewed();assert.equal(h.transfer.pending,null);
 assert.equal(h.calls.filter(c=>c.op==='status').length,2);
});
test('reviewing a staged operation cancels it remotely before forgetting it',async()=>{
 const h=harness();h.failChunk();await assert.rejects(h.transfer.send('texto'));
 assert.equal(h.transfer.pending.receipt.state,'receiving');
 assert.equal(await h.transfer.reviewed(),true);
 assert.equal(h.calls.at(-1).op,'cancel');
 assert.equal(h.transfer.pending,null);
 const cancelCalls=h.calls.filter(c=>c.op==='cancel').length;
 assert.equal(await h.transfer.reviewed(),false);
 assert.equal(h.calls.filter(c=>c.op==='cancel').length,cancelCalls);
});
test('a lost cancel receipt is resolved by status before local cleanup',async()=>{
 const h=harness();h.failChunk();h.loseCancel();await assert.rejects(h.transfer.send('texto'));
 assert.equal(await h.transfer.reviewed(),true);
 assert.equal(h.calls.at(-1).op,'status');
 assert.equal(h.transfer.pending,null);
});
test('late drafts remain separate and mark an exact confirmed duplicate',()=>{
 const h=harness();
 const late=h.transfer.noteLateDraft('confirmado','confirmado');
 assert.equal(late.text,'confirmado');assert.equal(late.duplicate,true);
 assert.equal(h.transfer.lateDraft.text,'confirmado');assert.equal(h.transfer.lateDraft.duplicate,true);
 const used=h.transfer.useLateDraft();
 assert.equal(used.text,'confirmado');assert.equal(used.duplicate,true);
 assert.equal(h.transfer.lateDraft,null);
 h.transfer.noteLateDraft('otra versión','confirmado');
 h.transfer.discardLateDraft();
 assert.equal(h.transfer.lateDraft,null);
});
test('choosing a recovered version retains the current draft as the alternate',()=>{
 const h=harness();h.transfer.draft='nuevo';h.transfer.noteLateDraft('first next','first');
 assert.equal(h.transfer.useLateDraft().text,'first next');
 assert.equal(h.transfer.draft,'first next');assert.equal(h.transfer.lateDraft.text,'nuevo');
 h.transfer.useLateDraft();assert.equal(h.transfer.draft,'nuevo');assert.equal(h.transfer.lateDraft.text,'first next');
});
test('oversize, NUL and incomplete surrogate drafts never reach the network',async()=>{
 for(const value of ['x'.repeat(131073),'a\0b','\ud800','']){
  const h=harness();await assert.rejects(h.transfer.send(value));assert.equal(h.calls.length,0);assert.equal(h.transfer.pending,null);
 }
});
test('capability bounds are validated before enabling literal mode',()=>{
 const {inputCapabilities}=harness().exported;
 assert.ok(inputCapabilities(caps));
 for(const value of [null,{}, {...caps,session:'../bad'},{...caps,maxTextBytes:Infinity},{...caps,maxChunkBytes:0},{...caps,maxChunks:129}])
  assert.equal(inputCapabilities(value),null);
});
