const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const caret=load('lib/native-caret.ts');
const {CARET_CONTEXT:context,CARET_ORIGIN:origin,CARET_COLUMNS:columns}=caret;
test('native selection deltas preserve both axes and directions without a joystick',()=>{
 for(const [offset,key] of [[1,'ArrowRight'],[-1,'ArrowLeft'],[columns+1,'ArrowDown'],[-columns-1,'ArrowUp']]){
  assert.deepEqual([...caret.caretMovement(origin,{start:origin+offset,end:origin+offset})],[key]);
 }
 assert.deepEqual([...caret.caretMovement(origin,{start:origin+columns+3,end:origin+columns+3})],['ArrowDown','ArrowRight','ArrowRight']);
 for(const selection of [{start:-1,end:-1},{start:999,end:999},{start:origin,end:origin+2},{start:NaN,end:NaN}])assert.deepEqual([...caret.caretMovement(origin,selection)],[]);
});
test('navigation context is never included in inserted text, dictation, spaces, newlines or symbols',()=>{
 for(const inserted of ['a',' ','\n','Prueba ñ € 👋','frase dictada\nsegunda línea','👌🙌🏻']){
  assert.equal(caret.caretInsertion(context.slice(0,origin)+inserted+context.slice(origin)),inserted);
 }
 assert.equal(caret.caretInsertion(context),'');
 assert.equal(caret.caretInsertion(context.slice(0,origin-1)+context.slice(origin)),'');
});
