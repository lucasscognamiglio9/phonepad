const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
const mod={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/session-awake.ts'),'utf8'),{compilerOptions:{module:1,target:9}}).outputText,{exports:mod});
test('late activation releases only its own tag after backgrounding',async()=>{
 let complete;const released=[];const cleanup=mod.keepSessionAwake(()=>new Promise(r=>complete=r),async tag=>released.push(tag),'old');cleanup();complete();await Promise.resolve();await Promise.resolve();
 assert.deepEqual(released,['old','old']);
});
