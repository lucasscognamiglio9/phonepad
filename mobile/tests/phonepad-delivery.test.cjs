const test=require('node:test'),assert=require('node:assert/strict');
const {load,control}=require('./control-fixture.cjs');
function fixture({platform='linux',action='executed',replayed=false}={}) {
 const offers=[],keys=[];
 const connection={capabilities:{sessionEpoch:'one',hostPlatform:platform},canInput:true,canClipboard:true,
pressAction:key=>{keys.push(key);return 'paste-one';},
  waitFinalActionReceipt:async()=>({state:action,replayed})};
 const delivery=load('lib/text-delivery.ts',{'./control-layout':control,'./clipboard-transfer':{offerTextToHostClipboard:async(_,text)=>offers.push(text)}});
 return {connection,offers,keys,...delivery};
}
test('explicit desktop Paste waits for a same-session final receipt with no replay',async()=>{
 for(const options of [{action:'uncertain'},{replayed:true}]){const h=fixture(options);assert.equal(await h.pasteToHost(h.connection),'uncertain');assert.equal(h.keys.length,1);}
 const h=fixture();h.connection.waitFinalActionReceipt=async()=>{h.connection.capabilities.sessionEpoch='two';return {state:'executed'};};assert.equal(await h.pasteToHost(h.connection),'uncertain');
});
test('a revoked clipboard blocks explicit Paste',async()=>{
 const p=fixture();p.connection.canClipboard=false;assert.equal(await p.pasteToHost(p.connection),'rejected');assert.equal(p.keys.length,0);
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

