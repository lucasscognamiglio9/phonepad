const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
function hello(overrides={}) {
  return {t:'ok',protocolVersion:2,compatibleVersions:[1,2],sessionEpoch:'fixture-epoch',capabilityRevision:1,
    roles:['viewer','controller'],permissions:{view:{state:'granted'},input:{state:'granted'},files:{state:'granted'},clipboard:{state:'granted'}},
    capabilities:{input:{state:'available',actions:['m','b','s','k','g','t'],effective:true},literal:{state:'unsupported'},video:{state:'unknown'}},
    source:{state:'unavailable'},geometry:{state:'unavailable',geometryEpoch:null},...overrides};
}
function harness() {
  const sockets=[],states=[],changes=[];
  class Socket {
    static OPEN=1;readyState=1;bufferedAmount=0;sent=[];
    constructor(url){this.url=url;sockets.push(this);}
    send(value){this.sent.push(JSON.parse(value));}
    close(){this.readyState=3;this.onclose?.({code:1000});}
    receive(value){this.onmessage({data:JSON.stringify(value)});}
  }
  function load(name) {
    const exports={};
    const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib',name+'.ts'),'utf8'),{
      fileName:name+'.ts',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
    }).outputText;
    vm.runInNewContext(code,{exports,require:name=>name.startsWith('./')?load(name.slice(2)):name==='buffer'?require('buffer'):{},
      URL,AbortController,WebSocket:Socket,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async()=>({status:204})});
    return exports;
  }
  const {Connection}=load('connection'),caps=load('session-capabilities');
  const connection=new Connection('https://test.example',state=>states.push(state),()=>changes.push(true));
  return{connection,sockets,states,changes,...caps,async start(message=hello()){
    connection.start();await tick();sockets.at(-1).receive(message);return sockets.at(-1);
  }};
}

test('v2 negotiates explicitly and scopes all input to the current session, except ping',async()=>{
  const h=harness();try{
      const ws=await h.start();assert.equal(ws.url,'wss://test.example/ws?protocol=2&pointerGeometry=1&directPointer=1');
    assert.equal(h.states.at(-1),'connected');assert.equal(h.connection.canInput,true);
    h.connection.send({t:'k',a:'special',key:'Enter'});h.connection.send({t:'ping'});
    assert.equal(ws.sent[0].sessionEpoch,'fixture-epoch');assert.equal(ws.sent[1].sessionEpoch,undefined);
  }finally{h.connection.stop();}
});

test('pointer geometry keeps supported profiles separate from the applied profile and epoch',()=>{
  const h=harness();
  const message=hello();
  message.capabilities.input.pointerGeometry={version:1,
    supportedProfiles:[{id:'legacy-100x70',kind:'legacy-aspect-fit',widthMm:100,heightMm:70},
      {id:'square-centered',kind:'square-centered',sideMm:100,gainMmPerPoint:.12,
        gainSource:'calibrated',gainMinMmPerPoint:.08,gainMaxMmPerPoint:.16}],
    applied:{id:'legacy-100x70',geometryEpoch:4}};
  const parsed=h.parseSessionCapabilities(message);
  assert.equal(parsed.input.pointerGeometry.applied.id,'legacy-100x70');
  assert.equal(parsed.input.pointerGeometry.applied.geometryEpoch,4);
  assert.equal(parsed.input.pointerGeometry.supportedProfiles.length,2);
});

test('absent or malformed pointer geometry remains the legacy compatibility path',()=>{
  const h=harness();
  for(const pointerGeometry of [undefined,
    {version:1,supportedProfiles:[{id:'square-centered',kind:'square-centered',sideMm:100,
      gainMmPerPoint:.12,gainSource:'fixture',gainMinMmPerPoint:.08,gainMaxMmPerPoint:.16}],
      applied:{id:'square-centered',geometryEpoch:2}},
    {version:1,supportedProfiles:[],applied:{id:'legacy-100x70',geometryEpoch:1}}]){
    const message=hello();
    if(pointerGeometry === undefined) delete message.capabilities.input.pointerGeometry;
    else message.capabilities.input.pointerGeometry=pointerGeometry;
    assert.equal(h.parseSessionCapabilities(message).input.pointerGeometry,null);
  }
});

test('legacy servers keep common commands without pretending to negotiate v2 or literal text',async()=>{
  const h=harness();try{
    const ws=await h.start({t:'ok'});h.connection.click('l');
    assert.equal(h.connection.capabilities.profile,'legacy-v1');assert.equal(h.connection.inputCapabilities,null);
    assert.equal(ws.sent.length,2);assert.equal(ws.sent[0].sessionEpoch,undefined);
  }finally{h.connection.stop();}
});

test('view-only keeps the connection and preview permission while rejecting input locally',async()=>{
  const h=harness();try{
    const message=hello();message.permissions.input={state:'unavailable',reason:'provider_unavailable'};
    message.capabilities.input={state:'unavailable',actions:[],effective:false};
    const ws=await h.start(message);assert.equal(h.states.at(-1),'connected');assert.equal(h.connection.canView,true);
    assert.equal(h.connection.send({t:'k',a:'special',key:'Enter'}),false);
    h.connection.move(99,99);h.connection.click('l');assert.equal(ws.sent.length,0);
    assert.equal(h.connection.send({t:'ping'}),true);assert.equal(ws.sent.length,1);
  }finally{h.connection.stop();}
});

test('revocation cancels queued movement and held contacts; older capability updates cannot restore permissions',async()=>{
  const h=harness();try{
    const ws=await h.start(),epoch=h.connection.inputEpoch;
    h.connection.move(200,300);
    const revoked=hello({t:'capabilities',capabilityRevision:2});
    revoked.permissions.input={state:'revoked'};revoked.capabilities.input={state:'unavailable',actions:[],effective:false};
    ws.receive(revoked);ws.receive(hello({t:'capabilities',capabilityRevision:1}));
    assert.equal(h.connection.canInput,false);assert.equal(h.connection.touch(epoch,[]),false);
    await new Promise(resolve=>setTimeout(resolve,15));assert.equal(ws.sent.length,0);
    ws.receive(hello({t:'capabilities',capabilityRevision:3}));
    assert.equal(h.connection.canInput,true);assert.equal(h.connection.touch(epoch,[]),false);
    assert.equal(h.connection.touch(h.connection.inputEpoch,[]),true);
  }finally{h.connection.stop();}
});

test('malformed or incompatible advertisements fail closed instead of falling back to legacy commands',async()=>{
  for(const change of [m=>{m.protocolVersion=3;},m=>{delete m.permissions.input;},m=>{m.sessionEpoch='';},
    m=>{delete m.protocolVersion;},m=>{m.capabilityRevision=-1;},m=>{m.capabilities.literal.state='available';}]){
    const h=harness();try{
      const message=hello();change(message);const ws=await h.start(message);
      assert.equal(h.states.at(-1),'incompatible');assert.equal(ws.readyState,3);
      assert.equal(h.connection.send({t:'k',a:'text',text:'?'}),false);
    }finally{h.connection.stop();}
  }
});

test('nonfatal input rejection is visible without losing authorization or the preview',async()=>{
  const h=harness();try{
    const ws=await h.start();ws.receive({t:'rejected',scope:'input',code:'stale_session',fatal:false});
    assert.equal(h.connection.lastRejection,'stale_session');assert.equal(h.states.at(-1),'connected');
    assert.equal(h.connection.canView,true);assert.equal(h.connection.send({t:'ping'}),true);
  }finally{h.connection.stop();}
});

test('an old socket cannot supply new permissions after reconnect',async()=>{
  const h=harness();try{
    const old=await h.start();const current=await h.start(hello({sessionEpoch:'next-epoch'}));
    old.receive(hello({t:'capabilities',capabilityRevision:90}));
    assert.equal(h.connection.capabilities.sessionEpoch,'next-epoch');
    h.connection.click('l');assert.equal(current.sent[0].sessionEpoch,'next-epoch');
  }finally{h.connection.stop();}
});

test('revoking only file permission preserves the input epoch so a held finger can release',async()=>{
  const h=harness();try{
    const ws=await h.start(),epoch=h.connection.inputEpoch;
    const update=hello({t:'capabilities',capabilityRevision:2});update.permissions.files={state:'revoked'};
    ws.receive(update);
    assert.equal(h.connection.canTransfer,false);assert.equal(h.connection.inputEpoch,epoch);
    assert.equal(h.connection.touch(epoch,[]),true);assert.equal(ws.sent.at(-1).t,'t');
  }finally{h.connection.stop();}
});
