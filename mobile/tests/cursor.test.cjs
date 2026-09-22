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
 assert.equal(r.accept(JSON.stringify({...moved,sequence:3,imageId:'abcdef0123456789'})).visible,false);
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
