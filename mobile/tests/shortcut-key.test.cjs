const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const appearance=require('./appearance-fixture.cjs');
const actions=load('lib/actions.ts');
const jsx=(type,props)=>({type,props});
const modifiers={shapes:{rectangle:()=>({shape:'rectangle'}),capsule:()=>({shape:'capsule'})}};
for(const name of ['accessibilityAddTraits','accessibilityLabel','strokeBorder','buttonStyle','contentShape','disabled','font','foregroundStyle','frame','padding'])modifiers[name]=value=>({name,value});
const {ShortcutKey}=load('components/shortcut-key.ios.tsx',{
 '@expo/ui/swift-ui':{Button:'NativeButton',Host:'NativeHost',HStack:'NativeHStack',Image:'NativeImage',Text:'NativeText'},
 '@expo/ui/swift-ui/modifiers':modifiers,'react/jsx-runtime':{jsx,jsxs:jsx},'./appearance':appearance,'../lib/actions':actions,
});
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const modifier=(node,name)=>node.props.modifiers.find(m=>m.name===name)?.value;
test('iOS shortcut buttons measure native intrinsic widths, retain a 44pt hit area and ignore already-handled keyboard insets',()=>{
 const tree=ShortcutKey({label:'Ctrl',disabled:false,run:()=>{}}),all=nodes(tree);
 assert.equal(tree.type,'NativeHost');assert.equal(tree.props.matchContents,true);assert.equal(tree.props.ignoreSafeArea,'all');
 const label=all.find(n=>n.type==='NativeHStack');
 assert.deepEqual({...modifier(label,'frame')},{minWidth:44,minHeight:44});
 assert.equal(modifier(label,'contentShape').shape,'rectangle');
 assert.deepEqual({...modifier(all.find(n=>n.type==='NativeText'),'font')},{textStyle:'footnote',weight:'regular'});
 assert.equal(modifier(all.find(n=>n.type==='NativeButton'),'buttonStyle'),'plain');
});
test('clipboard shortcuts keep the same native font and smaller SF symbols, with one dispatch per tap',()=>{
 for(const [action,label] of [['paste','Pegar'],['copy','Copiar'],['toPhone','Al iPhone']]){
  let calls=0;const all=nodes(ShortcutKey({action,label,disabled:false,run:()=>calls++}));
  const icon=all.find(n=>n.type==='NativeImage');assert.equal(icon.props.systemName,actions.ACTIONS[action].symbol.ios);assert.equal(icon.props.size,18);
  const button=all.find(n=>n.type==='NativeButton');assert.equal(modifier(button,'accessibilityLabel'),label);
  button.props.onPress();assert.equal(calls,1);
 }
});
test('selected native modifiers expose their state and disabled shortcuts cannot dispatch even a queued press',()=>{
 let calls=0;const all=nodes(ShortcutKey({label:'Ctrl',selected:true,disabled:true,run:()=>calls++}));
 const button=all.find(n=>n.type==='NativeButton');assert.equal(modifier(button,'disabled'),true);
 assert.ok(modifier(button,'accessibilityAddTraits').includes('isSelected'));
 assert.ok(modifier(all.find(n=>n.type==='NativeHStack'),'strokeBorder'));
 button.props.onPress();assert.equal(calls,0);
});
