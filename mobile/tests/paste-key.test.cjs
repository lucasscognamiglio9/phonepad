const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const jsx=(type,props)=>({type,props});
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const pasteKey=available=>load('components/paste-key.tsx',{
 'react-native':{Text:'Text',View:'View'},'react/jsx-runtime':{jsx,jsxs:jsx},'./appearance':require('./appearance-fixture.cjs'),
 './shortcut-key':{ShortcutKey:'ShortcutKey'},'expo-clipboard':{isPasteButtonAvailable:available,ClipboardPasteButton:'PasteControl'},
}).PasteKey;

test('the native paste control receives the text, so iOS never asks to allow paste',()=>{
 const pasted=[];const tree=pasteKey(true)({label:'Al equipo',disabled:false,run:()=>assert.fail('fallback read'),paste:item=>pasted.push(item)});
 const control=nodes(tree).find(n=>n.type==='PasteControl');
 control.props.onPress({type:'text',text:'hola'});
 assert.deepEqual(pasted,[{type:'text',text:'hola'}]);
 assert.deepEqual([...control.props.acceptedContentTypes],['plain-text']);
 assert.ok(nodes(tree).some(n=>n.type==='Text'&&n.props.children==='Al equipo'));
});
test('without the native control, or while disabled, the key falls back to the plain button',()=>{
 assert.equal(pasteKey(false)({label:'Pegar aquí',disabled:false,run:()=>{},paste:()=>{}}).type,'ShortcutKey');
 assert.equal(pasteKey(true)({label:'Pegar aquí',disabled:true,run:()=>{},paste:()=>{}}).type,'ShortcutKey');
});
