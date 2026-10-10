const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
const mod={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/direct-pointer.ts'),'utf8'),{compilerOptions:{module:1,target:9}}).outputText,{exports:mod,setTimeout,clearTimeout});
test('direct mapping excludes letterboxes, honors zoom and pan, and tracks orientation',()=>{
 assert.equal(mod.directPoint(0,0,400,800,1920,1080),null);
 let p=mod.directPoint(200,400,400,800,1920,1080);assert.equal(p.x,32768);assert.equal(p.y,32768);
 p=mod.directPoint(300,400,400,800,1920,1080,2,100,0);assert.equal(p.x,32768);
 p=mod.directPoint(800,450,800,450,1920,1080);assert.equal(p.x,65535);assert.equal(p.y,65535);
 assert.equal(mod.directPoint(1,1,0,0,1920,1080),null);
});
test('direct drag has one down/up; cancellation never synthesizes a click',()=>{
 const sent=[],d=new mod.DirectPointerSequence(c=>(sent.push(c),true));
 d.frame([{x:10,y:20}]);d.frame([{x:3000,y:4000}]);d.cancel();d.cancel();
 assert.equal(sent.filter(c=>c.a==='down').length,1);assert.equal(sent.filter(c=>c.a==='up').length,1);
 assert.equal(sent[0].t,'p');assert.equal(sent.at(-1).a,'up');
});
test('two-finger tap is right click and scroll never also clicks right',()=>{
 const sent=[],d=new mod.DirectPointerSequence(c=>(sent.push(c),true));
 d.frame([{x:10,y:20},{x:40,y:20}]);d.frame([]);assert.equal(sent.filter(c=>c.btn==='r').length,2);
 sent.length=0;d.frame([{x:10,y:20},{x:40,y:20}]);d.frame([{x:10,y:1044},{x:40,y:1044}]);d.frame([]);
 assert.equal(sent.some(c=>c.t==='s'),true);assert.equal(sent.some(c=>c.btn==='r'),false);
});

test('adding a second finger and canceling never commits the pending left tap',()=>{
 const sent=[],d=new mod.DirectPointerSequence(c=>(sent.push(c),true));
 d.frame([{x:10,y:20}]);assert.equal(sent.some(c=>c.t==='b'),false);
 d.frame([{x:10,y:20},{x:40,y:20}]);d.cancel();assert.equal(sent.length,0,'a cancelled pinch does not move or click the host');
});
