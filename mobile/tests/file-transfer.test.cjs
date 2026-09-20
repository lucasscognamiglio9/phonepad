const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const limits = {version:2,maxFiles:20,maxBytes:104857600,maxChunkBytes:262144,ttlSeconds:86400};
const id = '01234567-0123-4567-8901-012345678901';
function harness(contents=[Buffer.from('hello')], options={}) {
 const files=contents.map((data,i)=>({name:`${i}.txt`,type:'text/plain',bytes:data.length,sha256:digest(data)}));
 const batch={origin:'https://host',manifest:{version:2,id,files},createdAt:1};
 const received=contents.map(()=>Buffer.alloc(0));let state='receiving',lost=false,clipboardCopies=0,clipboard='unrequested';
 const calls=[],reads=[]; const exported={};
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/file-transfer.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const status=()=>({version:2,id,state,folder:state==='stored'?'Downloads/Phonepad/batch-'+id:undefined,
  files:files.map((f,i)=>({...f,name:`${i+1}-${f.name}`,index:i,receivedBytes:received[i].length})),
  ...(state==='stored'?{clipboard:{state:clipboard,replayed:clipboard!=='unrequested'}}:{})});
 vm.runInNewContext(code,{exports:exported,require,Uint8Array,ArrayBuffer,AbortController,setTimeout,clearTimeout,
  fetch:async(url,init)=>{
   assert.equal(init.headers.Origin,'https://host');assert.equal(init.credentials,'include');
   const query=new URL(url).searchParams,action=query.get('action');calls.push({action,method:init.method,offset:query.get('offset')});
   if(init.method==='GET'&&!query.has('id'))return {ok:true,json:async()=>options.limits??limits};
   if(action==='begin')assert.deepEqual(JSON.parse(init.body),batch.manifest);
   if(init.method==='PUT'){
    const i=Number(query.get('index')),offset=Number(query.get('offset')),data=Buffer.from(init.body);
    assert.equal(offset,received[i].length);assert.equal(digest(data),init.headers['X-Chunk-SHA256']);
    received[i]=Buffer.concat([received[i],data]);
    if(options.loseChunk&&!lost){lost=true;throw Error('lost chunk receipt');}
   }
   if(action==='commit'){
    received.forEach((data,i)=>assert.equal(digest(data),files[i].sha256));state='stored';
    if(options.loseCommit&&!lost){lost=true;throw Error('lost commit receipt');}
   }
   if(action==='cancel')state='cancelled';
   if(action==='clipboard'){
    assert.equal(state,'stored');
    if(clipboard==='unrequested'){clipboardCopies++;clipboard='ready';
     if(options.loseClipboard&&!lost){lost=true;throw Error('lost clipboard receipt');}
     const receipt=status();receipt.clipboard.replayed=false;return {ok:true,json:async()=>receipt};
    }
   }
   const receipt=status();if(options.badReceipt&&init.method==='PUT')receipt.files[0].sha256='0'.repeat(64);
   return {ok:true,json:async()=>receipt};
  }});
 const read=(_id,index,offset,count)=>{assert.equal(_id,id);reads.push({index,offset,count});return contents[index].subarray(offset,offset+count);};
 return {...exported,batch,read,calls,reads,received,status,clipboardCopies:()=>clipboardCopies};
}
test('bounded chunks verify full file identities and empty files before one commit',async()=>{
 const data=crypto.randomBytes(620003),h=harness([data,Buffer.alloc(0),Buffer.from('¿👩🏾‍🚀\r\n')]),progress=[];
 const result=await h.sendPreparedBatch(h.batch,limits,h.read,new AbortController().signal,p=>progress.push(p));
 assert.equal(result.state,'stored');assert.deepEqual(h.received[0],data);assert.ok(h.reads.every(r=>r.count<=262144));
 assert.equal(h.calls.filter(c=>c.action==='commit').length,1);assert.equal(h.clipboardCopies(),0);assert.equal(progress.at(-1),100);
});
test('lost chunk receipt resumes at the confirmed byte offset and never re-reads acknowledged bytes',async()=>{
 const h=harness([crypto.randomBytes(600007)],{loseChunk:true});
 await assert.rejects(h.sendPreparedBatch(h.batch,limits,h.read,new AbortController().signal,()=>{}),/lost chunk/);
 const result=await h.sendPreparedBatch(h.batch,limits,h.read,new AbortController().signal,()=>{});
 assert.equal(result.state,'stored');assert.deepEqual(h.reads.map(r=>r.offset),[0,262144,524288]);
});
test('lost commit is recovered by identity with no second commit and no implicit clipboard write',async()=>{
 const h=harness(undefined,{loseCommit:true});
 await assert.rejects(h.sendPreparedBatch(h.batch,limits,h.read,new AbortController().signal,()=>{}));
 assert.equal((await h.sendPreparedBatch(h.batch,limits,h.read,new AbortController().signal,()=>{})).state,'stored');
 assert.equal(h.calls.filter(c=>c.action==='commit').length,1);assert.equal(h.clipboardCopies(),0);
});
test('lost clipboard result is queried/retried without re-acquiring clipboard ownership',async()=>{
 const h=harness(undefined,{loseClipboard:true}),signal=new AbortController().signal;
 await h.sendPreparedBatch(h.batch,limits,h.read,signal,()=>{});
 await assert.rejects(h.copyPreparedBatch(h.batch,signal));
 assert.equal((await h.queryPreparedBatch(h.batch,signal)).clipboard.state,'ready');
 assert.equal((await h.copyPreparedBatch(h.batch,signal)).clipboard.replayed,true);assert.equal(h.clipboardCopies(),1);
});
test('identity, byte counts and checksums reject corrupt acknowledgments',async()=>{
 const h=harness(undefined,{badReceipt:true});
 await assert.rejects(h.sendPreparedBatch(h.batch,limits,h.read,new AbortController().signal,()=>{}),/recibo/);
 assert.equal(h.calls.some(c=>c.action==='commit'),false);
 for(const edit of [v=>v.id='wrong',v=>v.files[0].receivedBytes=-1,v=>v.files[0].index=9,v=>v.files[0].type='image/png']){
  const status=h.status();edit(status);assert.throws(()=>h.verifiedStatus(status,h.batch.manifest),/recibo/);
 }
});
test('cancellation stops before networking and remote cancellation is idempotently prepared',async()=>{
 const h=harness(),controller=new AbortController();controller.abort();
 await assert.rejects(h.sendPreparedBatch(h.batch,limits,h.read,controller.signal,()=>{}),/pausado/);assert.equal(h.calls.length,0);
 assert.equal((await h.cancelPreparedBatch(h.batch,new AbortController().signal)).state,'cancelled');
 assert.deepEqual(h.calls.map(c=>c.action),['begin','cancel']);
});
test('negotiated limits cannot expand client memory or allow unsupported versions',async()=>{
 for(const value of [{...limits,maxChunkBytes:Infinity},{...limits,maxFiles:21},{...limits,maxBytes:0},{...limits,version:1}]){
  const h=harness(undefined,{limits:value});await assert.rejects(h.transferLimits(h.batch.origin,new AbortController().signal),/compatibles/);
 }
});
