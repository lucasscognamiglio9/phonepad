const test=require('node:test'),assert=require('node:assert/strict');
const {readClipboardPaste}=require('./control-fixture.cjs').load('lib/clipboard-paste.ts');
test('paste reads only the allowed type and prioritizes a copied image',async()=>{
 const calls=[],image={data:'data:image/png;base64,YQ==',size:{width:1,height:1}};
 const port={hasImageAsync:async()=>{calls.push('hasImage');return true;},getImageAsync:async()=>{calls.push('image');return image;},getStringAsync:async()=>{calls.push('text');return 'ñ € 👋';}};
 assert.equal((await readClipboardPaste(port,true,true)).type,'image');assert.deepEqual(calls,['hasImage','image']);
 calls.length=0;assert.equal((await readClipboardPaste(port,true,false)).text,'ñ € 👋');assert.deepEqual(calls,['text']);
 calls.length=0;await readClipboardPaste(port,false,true);assert.deepEqual(calls,['hasImage','image']);
});
test('denied image permission does not request text or manufacture content',async()=>{
 let textReads=0;
 const port={hasImageAsync:async()=>true,getImageAsync:async()=>null,getStringAsync:async()=>{textReads++;return 'unexpected';}};
 assert.equal(await readClipboardPaste(port,true,true),null);assert.equal(textReads,0);
 assert.equal(await readClipboardPaste(port,false,false),null);assert.equal(textReads,0);
});
