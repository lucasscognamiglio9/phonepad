const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
const mod={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/cursor.ts'),'utf8'),{compilerOptions:{module:1,target:9}}).outputText,{exports:mod});
const packet={t:'cursor',version:1,sequence:1,visible:true,x:960,y:540,hx:4,hy:5,w:30,h:30,sourceWidth:1920,sourceHeight:1080,imageId:'0123456789abcdef',image:'data:image/png;base64,iVBORw0KGgoAAA=='};
test('cursor hotspot follows zoom, pan and resized viewport; its bitmap stays 28 points',()=>{
 const c=new mod.CursorReceiver().accept(JSON.stringify(packet));
 for(const [w,h] of [[390,844],[844,240],[1024,768]])for(const scale of [1,2,4]){
  const p=mod.cursorPlacement(c,w,h,scale,31,-19);
  assert.equal(p.width,28);assert.equal(p.height,28);assert.ok(Math.abs(p.left+4*28/30-(w/2+31))<1e-8);assert.ok(Math.abs(p.top+5*28/30-(h/2-19))<1e-8);
 }
});
test('stale cursor packets, invalid shapes and external images cannot replace current state',()=>{
 const r=new mod.CursorReceiver();assert.ok(r.accept(JSON.stringify(packet)));
 assert.equal(r.accept(JSON.stringify({...packet,x:0})),null);
 assert.equal(r.accept(JSON.stringify({...packet,sequence:2,image:'https://other/image.png'})),null);
 assert.equal(r.accept(JSON.stringify({...packet,sequence:2,w:999})),null);
 assert.equal(r.accept(JSON.stringify({...packet,sequence:2,hx:-1})),null);
 const moved={...packet,sequence:2,x:123};delete moved.image;
 assert.equal(r.accept(JSON.stringify(moved)).image,packet.image);
 const pending=r.accept(JSON.stringify({...moved,sequence:3,imageId:'abcdef0123456789',hx:18,w:60}));
 assert.equal(pending.visible,true);assert.equal(pending.imageId,packet.imageId);assert.equal(pending.hx,packet.hx);assert.equal(pending.w,packet.w);
 const fresh=new mod.CursorReceiver();assert.equal(fresh.accept(JSON.stringify(moved)).visible,false);
});
test('hidden, offscreen and empty cursor never draws a predicted pointer',()=>{
 const r=new mod.CursorReceiver();const c=r.accept(JSON.stringify(packet));
 assert.equal(mod.cursorPlacement({...c,x:-1},400,800).opacity,0);
 const hidden=r.accept(JSON.stringify({t:'cursor',version:1,sequence:2,visible:false,sourceWidth:1920,sourceHeight:1080}));
 assert.equal(mod.cursorPlacement(hidden,400,800).opacity,0);assert.equal(mod.cursorPlacement(null,400,800).opacity,0);
});
test('Expo-serialized cursor worklet runs in the isolated UI runtime on mount',()=>{
 const babel=require('@babel/core');
 const preset=require.resolve('babel-preset-expo',{paths:[path.dirname(require.resolve('expo/package.json'))]});
 const transformed=babel.transformFileSync(path.join(__dirname,'../src/lib/cursor.ts'),{presets:[preset],caller:{name:'metro',platform:'ios',isDev:false,engine:'hermes',supportsStaticESM:false}});
 const compiled={};vm.runInNewContext(transformed.code,{exports:compiled,global:{Error}});
 const original=compiled.cursorPlacement;
 const isolated=vm.runInNewContext('('+original.__initData.code+')');
 assert.equal(isolated.call(original,null,390,844).opacity,0);
 const cursor=new mod.CursorReceiver().accept(JSON.stringify(packet));
 assert.equal(isolated.call(original,cursor,390,844).width,28);
 assert.equal(isolated.call(original,cursor,390,844,2,0,0,40).width,40);
});

test('cursor resizing keeps its hotspot aligned at all supported sizes',()=>{
 const c=new mod.CursorReceiver().accept(JSON.stringify(packet));
 for(const factor of [.5,.75,1,1.5]){
  const pos=mod.cursorPlacement(c,400,800,2,10,-20,28*factor);
  assert.equal(pos.width,28*factor);
  assert.ok(Math.abs(pos.left+c.hx*pos.width/c.w-210)<1e-8);
  assert.ok(Math.abs(pos.top+c.hy*pos.height/c.h-380)<1e-8);
 }
});


test('cursor feed coalesces state outside React and releases detached viewers',()=>{
 const feed=new mod.CursorFeed(), seen=[];
 const stop=feed.subscribe(state=>seen.push(state));
 const receiver=new mod.CursorReceiver();
 for(let sequence=1;sequence<=1000;sequence++) feed.publish(receiver.accept(JSON.stringify({...packet,sequence,x:sequence})));
 assert.equal(feed.current.x,1000);assert.equal(seen.length,1001);
 stop();feed.publish(null);assert.equal(seen.length,1001);
 const replay=[];const unsubscribe=feed.subscribe(state=>replay.push(state));
 assert.deepEqual(replay,[null]);unsubscribe();
});

test('a delayed reliable shape uses the latest position and never rolls movement back',()=>{
 const receiver=new mod.CursorReceiver();receiver.accept(JSON.stringify(packet));
 const secondId='abcdef0123456789';
 for(let sequence=2;sequence<50;sequence++){
  const next=receiver.accept(JSON.stringify({...packet,version:2,sequence,x:sequence*10,imageId:secondId,image:undefined}));
  assert.equal(next.visible,true);assert.equal(next.x,sequence*10);assert.equal(next.imageId,packet.imageId);
 }
 const next=receiver.accept(JSON.stringify({t:'cursor-image',version:2,imageId:secondId,image:packet.image,w:30,h:30,hx:4,hy:5}));
 assert.equal(next.x,490);assert.equal(next.imageId,secondId);
 assert.equal(receiver.accept(JSON.stringify({...packet,version:2,sequence:48,image:undefined})),null);
});
test('position received before its first shape becomes visible when that shape arrives',()=>{
 const receiver=new mod.CursorReceiver();
 assert.equal(receiver.accept(JSON.stringify({...packet,version:2,image:undefined})).visible,false);
 const shape={...packet,t:'cursor-image',version:2};
 const current=receiver.accept(JSON.stringify(shape));assert.equal(current.visible,true);assert.equal(current.x,960);
 assert.equal(receiver.accept(JSON.stringify({...shape,image:'file:///private.png'})),null);
 receiver.accept(JSON.stringify({t:'cursor',version:2,sequence:2,visible:false,sourceWidth:1920,sourceHeight:1080}));
 assert.equal(receiver.accept(JSON.stringify(shape)),null);
});
test('cursor interpolation stays bounded during jitter and resets across geometry/visibility changes',()=>{
 const previous=new mod.CursorReceiver().accept(JSON.stringify(packet));
 assert.equal(mod.cursorTransitionMs(previous,previous,16),16);
 assert.equal(mod.cursorTransitionMs(previous,previous,300),48);
 assert.equal(mod.cursorTransitionMs(previous,previous,-5),8);
 assert.equal(mod.cursorTransitionMs(null,previous,16),0);
 assert.equal(mod.cursorTransitionMs(previous,{...previous,visible:false},16),0);
 assert.equal(mod.cursorTransitionMs(previous,{...previous,sourceWidth:2560},16),0);
});


test('capture clock stays attached to the latest position across reliable shape delivery',()=>{
 const receiver=new mod.CursorReceiver();
 let state=receiver.accept(JSON.stringify({...packet,version:2,image:undefined,capturedAtUs:1000000}));assert.equal(state.capturedAtUs,1000000);
 state=receiver.accept(JSON.stringify({...packet,t:'cursor-image',version:2,capturedAtUs:1}));assert.equal(state.capturedAtUs,1000000);
 state=receiver.accept(JSON.stringify({...packet,sequence:2,capturedAtUs:Number.MAX_SAFE_INTEGER+1}));assert.equal(state.capturedAtUs,undefined);
});
