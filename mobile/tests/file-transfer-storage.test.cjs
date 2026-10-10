const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const id='01234567-0123-4567-8901-012345678901';
const limits={version:2,maxFiles:20,maxBytes:104857600,maxChunkBytes:1048576,ttlSeconds:86400};
function harness(t) {
 const cache=fs.mkdtempSync(path.join(os.tmpdir(),'phonepad-native-storage-test-'));
 t.after(()=>fs.rmSync(cache,{recursive:true,force:true}));
 const reads=[];
 class Entry {
  constructor(...parts) {this.uri=path.join(...parts.map(p=>typeof p==='string'?p:p.uri));}
  get name(){return path.basename(this.uri);}
  get exists(){return fs.existsSync(this.uri);}
  get size(){return fs.statSync(this.uri).size;}
  delete(){fs.rmSync(this.uri,{recursive:true});}
 }
 class File extends Entry {
  create(){fs.closeSync(fs.openSync(this.uri,'wx'));}
  write(data){if(!this.exists)throw Error('create first');fs.writeFileSync(this.uri,data);}
  textSync(){return fs.readFileSync(this.uri,'utf8');}
  open(mode){const fd=fs.openSync(this.uri,mode==='r'?'r':'r+');let offset=0;
   return {get offset(){return offset;},set offset(n){offset=n;},close(){fs.closeSync(fd);},
    readBytes(n){reads.push(n);const data=Buffer.alloc(n);const count=fs.readSync(fd,data,0,n,offset);offset+=count;return new Uint8Array(data.subarray(0,count));},
    writeBytes(data){fs.writeSync(fd,data,0,data.length,offset);offset+=data.length;}};
  }
 }
 class Directory extends Entry {
  create(){fs.mkdirSync(this.uri,{recursive:true});}
  list(){return fs.readdirSync(this.uri,{withFileTypes:true}).map(d=>d.isDirectory()?new Directory(this,d.name):new File(this,d.name));}
 }
 const exported={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/file-transfer-storage.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports:exported,Uint8Array,setTimeout,
  require:name=>name==='expo-file-system'?{File,Directory,FileMode:{ReadOnly:'r',WriteOnly:'w'},Paths:{cache}}
   :name==='./file-transfer'?{assertActive:signal=>{if(signal.aborted)throw Error('paused');}}:require(name),
 });
 function batch(data){const uri=path.join(cache,'original.bin');fs.writeFileSync(uri,data);return {id,items:[{uri,name:'original.bin',type:'application/octet-stream'}]};}
 return {...exported,cache,reads,batch,folder:path.join(cache,'phonepad-file-transfers-v2',id)};
}
test('snapshot bytes and hash survive original edits and app restoration, with bounded reads',async t=>{
 const h=harness(t),data=crypto.randomBytes(800013),batch=h.batch(data);
 const saved=await h.prepareBatch('https://host',batch,limits,new AbortController().signal,()=>{});
 assert.equal(saved.manifest.files[0].bytes,data.length);
 assert.equal(saved.manifest.files[0].sha256,crypto.createHash('sha256').update(data).digest('hex'));
 assert.ok(h.reads.every(n=>n<=262144));
 fs.writeFileSync(batch.items[0].uri,'changed original');
 assert.deepEqual(JSON.parse(JSON.stringify(h.restorePreparedBatch('https://host'))),JSON.parse(JSON.stringify(saved)));
 assert.equal(h.restorePreparedBatch('https://other'),null);
 assert.deepEqual(Buffer.from(h.readPreparedChunk(id,0,262144,100)),data.subarray(262144,262244));
 h.discardPreparedBatch(id);assert.equal(fs.existsSync(h.folder),false);assert.equal(fs.existsSync(batch.items[0].uri),true);
});
test('unknown-size provider content is bounded before writing beyond negotiated limit',async t=>{
 const h=harness(t),batch=h.batch(Buffer.alloc(4097));
 await assert.rejects(h.prepareBatch('https://host',batch,{...limits,maxBytes:4096},new AbortController().signal,()=>{}),/admite/);
 assert.equal(fs.existsSync(h.folder),false);
});
test('pause during preparation cleans incomplete snapshots and leaves original untouched',async t=>{
 const h=harness(t),batch=h.batch(Buffer.alloc(800003)),controller=new AbortController();
 await assert.rejects(h.prepareBatch('https://host',batch,limits,controller.signal,()=>controller.abort()),/paused/);
 assert.equal(fs.existsSync(h.folder),false);assert.equal(fs.statSync(batch.items[0].uri).size,800003);
});
test('restoration rejects changed local copies and cleanup only expires marked own folders',async t=>{
 const h=harness(t),batch=h.batch(Buffer.from('original'));
 await h.prepareBatch('https://host',batch,limits,new AbortController().signal,()=>{});
 fs.writeFileSync(path.join(h.folder,'0.data'),'bad');assert.equal(h.restorePreparedBatch('https://host'),null);
 const unrelated=path.join(path.dirname(h.folder),'do-not-delete');fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'notes'),'keep');
 const marker=JSON.parse(fs.readFileSync(path.join(h.folder,'owner.json'),'utf8'));marker.createdAt=Date.now()-86400001;
 fs.writeFileSync(path.join(h.folder,'owner.json'),JSON.stringify(marker));h.restorePreparedBatch('https://host');
 assert.equal(fs.existsSync(h.folder),false);assert.equal(fs.readFileSync(path.join(unrelated,'notes'),'utf8'),'keep');
});
