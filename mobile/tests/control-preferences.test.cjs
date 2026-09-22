const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
test('control preferences survive a torn journal, stay per-host, and need no TextEncoder global',async()=>{
 const data=new Map(),hash=await import('@noble/hashes/sha2.js'),utils=await import('@noble/hashes/utils.js');
 class File{constructor(root,name){this.name=name}get exists(){return data.has(this.name)}textSync(){return data.get(this.name)}write(value){data.set(this.name,value)}}
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/control-preferences.ts'),'utf8'),{compilerOptions:{module:1,target:9}}).outputText,{exports,require:name=>({'expo-file-system':{File,Paths:{document:'mock'}},'@noble/hashes/sha2.js':hash,'@noble/hashes/utils.js':utils,buffer:require('buffer')}[name])});
 exports.saveControlPreferences('https://a',{mode:'direct',gain:1.5});
 exports.saveControlPreferences('https://a',{mode:'trackpad',gain:2});
 assert.equal(exports.loadControlPreferences('https://a').gain,2);
 assert.equal(exports.loadControlPreferences('https://b').gain,2);
 assert.equal(exports.loadControlPreferences('https://b').cursorScale,.75);
 exports.saveControlPreferences('https://c',{gain:4,cursorScale:1.5,mode:'trackpad'});
 assert.equal(exports.loadControlPreferences('https://c').gain,4);
 assert.equal(exports.loadControlPreferences('https://c').cursorScale,1.5);
 assert.equal(exports.parseControlPreferences({gain:999,cursorScale:0}).gain,4);
 assert.equal(exports.parseControlPreferences({gain:999,cursorScale:0}).cursorScale,.5);
 const last=[...data.keys()].find(name=>name.endsWith('-b.json'));data.set(last,'{"version":');
 assert.equal(exports.loadControlPreferences('https://a').mode,'direct');
 assert.equal(exports.loadControlPreferences('https://a').gain,1.5);
});
