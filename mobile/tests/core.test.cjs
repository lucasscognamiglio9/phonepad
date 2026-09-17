const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function load(file,extra={}) {
 const exports={}; const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,require: name => name === "./literal-transfer" ? load("literal-transfer.ts",extra) : name === "buffer" ? require("buffer") : {},URL,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,...extra});return exports;
}
test('native keyboard reconciles dictation, correction and Unicode without splitting surrogate pairs',()=>{
 const {textCommands}=load('protocol.ts');
 assert.equal(textCommands('hola','hola mundo')[0].text,' mundo');
 assert.equal(textCommands('😄','').length,1);
 assert.equal(textCommands('hola','hola').length,0);
 assert.equal(textCommands('caza','casa').filter(x=>x.a==='special').length,2);
});
function harness(status=204){
 const sockets=[],states=[];
 class Socket {
  static OPEN=1;readyState=1;bufferedAmount=0;sent=[];
  constructor(){sockets.push(this)}send(s){this.sent.push(JSON.parse(s))}close(){this.readyState=3;this.onclose?.({code:1000})}
 }
 const {Connection}=load('connection.ts',{WebSocket:Socket,fetch:async()=>({status})});
 return {Connection,sockets,states,c:new Connection('https://host.ts.net',s=>states.push(s))};
}
const tick=()=>new Promise(r=>setTimeout(r,15));
test('never sends input until authorization AND websocket acknowledgement',async()=>{
 const h=harness();try{h.c.start();await tick();h.c.click('l');assert.equal(h.sockets[0].sent.length,0);
 h.sockets[0].onmessage({data:'{"t":"ok"}'});h.c.click('r');assert.equal(h.sockets[0].sent.length,2);
 }finally{h.c.stop()}
});
test('pause discards queued movement and resume still flushes new movement',async()=>{
 const h=harness();try{h.c.start();await tick();h.sockets[0].onmessage({data:'{"t":"ok"}'});
 h.c.move(900,900);h.c.stop();h.c.start();await tick();h.sockets[1].onmessage({data:'{"t":"ok"}'});
 h.c.move(3,4);await tick();assert.deepEqual(JSON.parse(JSON.stringify(h.sockets[1].sent)),[{t:'m',dx:3,dy:4}]);
 }finally{h.c.stop()}
});
test('unauthorized device never opens the control socket',async()=>{
 const h=harness(401);try{h.c.start();await tick();assert.equal(h.sockets.length,0);assert.equal(h.states.at(-1),'unauthorized')}finally{h.c.stop()}
});
test('rejects plaintext and credential-bearing server URLs',()=>{
 const h=harness();assert.throws(()=>new h.Connection('http://host.ts.net',()=>{}));assert.throws(()=>new h.Connection('https://user:secret@host.ts.net',()=>{}));
});

test('send reports unavailable transports and recovers from a socket closing while typing', async () => {
 const h=harness();
 try {
  assert.equal(h.c.send({t:'k',a:'text',text:'x'}),false);
  h.c.start();await tick();h.sockets[0].onmessage({data:'{"t":"ok"}'});
  assert.equal(h.c.send({t:'k',a:'text',text:'x'}),true);
  h.sockets[0].send=()=>{throw Error('closed during send')};
  assert.equal(h.c.send({t:'k',a:'text',text:'y'}),false);
  assert.equal(h.states.at(-1),'offline');
 } finally {h.c.stop()}
});


test('multiline insertion never sends bare newlines or unmodified Enter to the injector', () => {
 const {textCommands}=load('protocol.ts');
 const commands=JSON.parse(JSON.stringify(textCommands('', 'a\r\nb\nc')));
 assert.deepEqual(commands,[{t:'k',a:'text',text:'a'},{t:'k',a:'combo',mods:['shift'],key:'Enter'},
  {t:'k',a:'text',text:'b'},{t:'k',a:'combo',mods:['shift'],key:'Enter'},{t:'k',a:'text',text:'c'}]);
 assert.equal(textCommands('a\n', 'a').at(-1).key, 'Backspace');
});
