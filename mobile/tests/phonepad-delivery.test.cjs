const test=require('node:test'),assert=require('node:assert/strict');
const {load,control}=require('./control-fixture.cjs');
function fixture({state='rejected',platform='linux',action='executed',replayed=false}={}) {
 const offers=[],keys=[];
 const connection={capabilities:{sessionEpoch:'one',hostPlatform:platform},canInput:true,canClipboard:true,
  literal:{send:async()=>({state}),acknowledged(){}},pressAction:key=>{keys.push(key);return 'paste-one';},
  waitFinalActionReceipt:async()=>({state:action,replayed})};
 const delivery=load('lib/text-delivery.ts',{'./control-layout':control,'./clipboard-transfer':{offerTextToHostClipboard:async(_,text)=>offers.push(text)}});
 return {connection,offers,keys,...delivery};
}
test('rejected text uses a single platform-correct paste, preserving dictation, Unicode and symbols',async()=>{
 for(const platform of ['linux','windows','darwin'])for(const text of ['¿Dictado corregido?\nSí: café ñ € — 👨‍👩‍👧‍👦','<> {} [] \\ / | ~ ^ ` @ # $ % & * _ + =','日本語 العربية 한글','a'.repeat(80000)]){
  const h=fixture({platform});assert.equal((await h.deliverText(h.connection,text)).state,'dispatched');
  assert.deepEqual(h.offers,[text]);assert.equal(h.keys.length,1);assert.equal(h.keys[0].key,'v');
  assert.deepEqual(Array.from(h.keys[0].mods),[platform==='darwin'?'super':'ctrl']);
 }
});
test('dispatched, uncertain and lost literal receipts never trigger another paste',async()=>{
 for(const state of ['dispatched','uncertain','dispatching','cancelled']){
  const h=fixture({state});assert.equal((await h.deliverText(h.connection,'texto')).state,state);assert.equal(h.keys.length,0);assert.equal(h.offers.length,0);
 }
 const h=fixture();h.connection.literal.send=async()=>{throw Error('lost');};await assert.rejects(h.deliverText(h.connection,'texto'));assert.equal(h.keys.length,0);
});
test('paste receipts must confirm execution in the same session without replay',async()=>{
 for(const options of [{action:'uncertain'},{replayed:true}]){
  const h=fixture(options);assert.equal((await h.deliverText(h.connection,'texto')).state,'uncertain');assert.equal(h.keys.length,1);
 }
 const h=fixture();h.connection.waitFinalActionReceipt=async()=>{h.connection.capabilities.sessionEpoch='two';return {state:'executed'};};
 assert.equal(await h.pasteToHost(h.connection),'uncertain');assert.equal(h.keys.length,1);
 const lost=fixture();lost.connection.waitFinalActionReceipt=async()=>{throw Error('lost');};assert.equal(await lost.pasteToHost(lost.connection),'uncertain');
});
test('revoked input or clipboard cannot trigger the fallback',async()=>{
 for(const permission of ['canInput','canClipboard']){
  const h=fixture();h.connection[permission]=false;assert.equal((await h.deliverText(h.connection,'texto')).state,'rejected');assert.equal(h.offers.length,0);assert.equal(h.keys.length,0);
 }
});
test('preview fits against the top at portrait and landscape sizes with or without keyboard',()=>{
 for(const [width,height,top,bottom] of [[390,844,118,94],[390,844,118,360],[700,390,54,0],[700,390,54,260]]){
  const fitted=control.topPreviewHeight(width,height-top-bottom,{width:1920,height:1080});
  assert.ok(fitted<=height-top-bottom);assert.equal(fitted,Math.min(width*9/16,height-top-bottom));
  assert.ok(height-(top+fitted)>=bottom);
 }
});
test('analog dead zone and cardinal directions reject invalid coordinates',()=>{
 assert.equal(control.directionKey(0,0,.25),null);assert.equal(control.directionKey(NaN,1,.25),null);
 for(const [x,y,key] of [[1,0,'ArrowRight'],[-1,0,'ArrowLeft'],[0,1,'ArrowDown'],[0,-1,'ArrowUp']])assert.equal(control.directionKey(x,y,.25),key);
});

test('preferred clipboard delivery avoids an always-uncertain literal adapter, and pending literal work still blocks it',async()=>{
 const h=fixture({state:'uncertain'});let calls=0;h.connection.literal.send=async()=>{calls++;return {state:'uncertain'};};
 h.connection.inputCapabilities={preferredDelivery:'clipboard-paste'};assert.equal((await h.deliverText(h.connection,'ñ 👋')).state,'dispatched');assert.equal(calls,0);assert.equal(h.keys.length,1);
 h.connection.literal.pending={text:'anterior'};await assert.rejects(h.deliverText(h.connection,'nuevo'));assert.equal(h.keys.length,1);
});

test('verified paste rejections and cancellations preserve the draft without falsely reporting an uncertain dispatch',async()=>{
 for(const action of ['rejected','cancelled']){
  const h=fixture({action});assert.equal((await h.deliverText(h.connection,'texto')).state,'rejected');
  assert.equal(h.keys.length,1);assert.equal(h.offers.length,1);
 }
});
