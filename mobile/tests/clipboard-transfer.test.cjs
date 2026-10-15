const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function fixture(text='Texto ñ 👋\nsegunda línea') {
 const reads=[],writes=[],requests=[],connection={origin:'https://host.test',canClipboard:true,capabilities:{sessionEpoch:'one'}};
 const clipboard={getStringAsync:async()=>{reads.push(true);return text;},setStringAsync:async text=>{writes.push(text);return true;}};
 const exported={};const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/clipboard-transfer.ts'),'utf8'),{compilerOptions:{module:1,target:9}}).outputText;
 let response={state:'ready',text,sessionEpoch:'one'},ok=true;
 let customFetch;
 vm.runInNewContext(source,{exports:exported,AbortController,setTimeout,clearTimeout,require:name=>name==='buffer'?{Buffer}:clipboard,fetch:async(url,options)=>{requests.push({url,...options});return customFetch ? customFetch(options) : {ok,json:async()=>response};}});
 return {connection,clipboard,reads,writes,requests,...exported,setResponse:value=>response=value,setOk:value=>ok=value,setFetch:value=>customFetch=value};
}
test('explicit transfers preserve Unicode and affect only the chosen destination',async()=>{
 const h=fixture();await h.transferClipboard(h.connection,'phone',new AbortController().signal);
 assert.equal(h.reads.length,0);assert.deepEqual(h.writes,['Texto ñ 👋\nsegunda línea']);assert.equal(h.requests[0].method,'GET');
 h.requests.length=0;h.writes.length=0;
 await h.transferClipboard(h.connection,'host',new AbortController().signal);
 assert.equal(h.reads.length,1);assert.equal(h.writes.length,0);assert.equal(h.requests[0].method,'POST');
 assert.equal(JSON.parse(h.requests[0].body).text,'Texto ñ 👋\nsegunda línea');
});
test('empty, malformed and oversized phone clipboard never erase the computer clipboard',async()=>{
 for(const text of ['',null,'x\0y','\ud800','x'.repeat(128*1024+1)]){
  const h=fixture(text);await assert.rejects(h.transferClipboard(h.connection,'host',new AbortController().signal));assert.equal(h.requests.length,0);
 }
});
test('cancelled, revoked and stale transfers cannot overwrite the phone clipboard',async()=>{
 for(const mode of ['cancelled','revoked','stale','invalid','failed']){
  const h=fixture(),abort=new AbortController();
  if(mode==='cancelled')abort.abort();
  if(mode==='revoked')h.connection.canClipboard=false;
  if(mode==='stale')h.setResponse({text:'wrong',sessionEpoch:'two'});
  if(mode==='invalid')h.setResponse({text:'\ud800',sessionEpoch:'one'});
  if(mode==='failed')h.setOk(false);
  await assert.rejects(h.transferClipboard(h.connection,'phone',abort.signal));assert.equal(h.writes.length,0);
 }
 const h=fixture();h.clipboard.getStringAsync=async()=>{h.connection.capabilities.sessionEpoch='two';return 'old';};
 await assert.rejects(h.transferClipboard(h.connection,'host',new AbortController().signal));assert.equal(h.requests.length,0);
});
test('a denied phone write is not reported as a successful copy',async()=>{
 const h=fixture();h.clipboard.setStringAsync=async()=>false;
 await assert.rejects(h.transferClipboard(h.connection,'phone',new AbortController().signal));
});
test('cancelling an in-flight read aborts the request and never writes or retries',async()=>{
 const h=fixture(),abort=new AbortController();
 h.setFetch(options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('cancelled')))));
 const pending=h.transferClipboard(h.connection,'phone',abort.signal);abort.abort();
 await assert.rejects(pending);assert.equal(h.writes.length,0);assert.equal(h.requests.length,1);
});
