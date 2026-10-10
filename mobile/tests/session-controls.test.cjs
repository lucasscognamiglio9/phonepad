const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const appearance=require('./appearance-fixture.cjs');
function fixture(){
 const slots=[],effects=[],calls=[],measurements=[];let cursor=0,dirty=false,tree;
 const viewport={width:390,height:844},insets={top:54,left:0,right:0,bottom:34};
 const jsx=(type,props)=>({type,props});
 const react={useRef:value=>slots[cursor++]??={current:value},useState:value=>{
  const i=cursor++;if(!(i in slots))slots[i]=value;
  return [slots[i],next=>{if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}];},
  useEffect:(effect,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});}}};
 const {SessionControls}=load('components/session-controls.tsx',{react,'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{Pressable:'Pressable',Text:'Text',View:'View',useWindowDimensions:()=>viewport},'react-native-safe-area-context':{useSafeAreaInsets:()=>insets},'./session-control-focus':{SessionControlFocus:'SessionControlFocus'},'./appearance':appearance,'./glass-button':{GlassButton:'GlassButton'},'./glass-popup':{GlassPopup:'GlassPopup'},'./glass-surface':{GlassSurface:'GlassSurface'},'./action-icon':{ActionIcon:'ActionIcon'}});
 const props={preview:true,keyboardOpen:true,disabled:false,bottomInset:300,openKeyboard:()=>calls.push('keyboard'),togglePreview:()=>calls.push('screen'),openOptions:()=>calls.push('mouse'),reconnect:()=>calls.push('reconnect')};
 const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
 const find=(type,label)=>nodes(tree).find(n=>n.type===type&&(!label||n.props.accessibilityLabel===label));
 function render(){do{dirty=false;cursor=0;tree=SessionControls(props);
   const frame=nodes(tree).find(n=>n.props?.ref);frame.props.ref.current={measureInWindow:callback=>measurements.push(callback)};
   while(effects.length)effects.shift()();}while(dirty);}
 render();return {props,viewport,insets,calls,render,find,measure:()=>{measurements.shift()?.(320,62,44,44);render();},
 open:()=>{find('GlassButton').props.onPress();measurements.shift()?.(320,62,44,44);render();},
 unmount:()=>slots.forEach(s=>s?.cleanup?.())};
}
test('one options control opens monitor, keyboard, mouse and reconnect in order, without changing keyboard state',()=>{
 const h=fixture();h.open();const popup=h.find('GlassPopup');
 assert.deepEqual(Array.from(popup.props.children.props.children.flat().slice(1),n=>n.props.accessibilityLabel),['Ocultar pantalla','Cerrar teclado','Mouse','Reconectar']);
 assert.deepEqual(h.calls,[]);assert.equal(popup.props.anchor.width,44);
 h.find('Pressable','Mouse').props.onPress();h.render();assert.equal(h.find('GlassPopup').props.anchor,null);assert.deepEqual(h.calls,['mouse']);
});
test('rotating or opening the keyboard remeasures a presented popup; late measurement cannot reopen it',()=>{
 const h=fixture();h.open();h.viewport.width=844;h.viewport.height=390;h.props.bottomInset=200;h.render();
 h.find('GlassPopup').props.close();h.render();h.measure();assert.equal(h.find('GlassPopup').props.anchor,null);assert.deepEqual(h.calls,[]);
});
test('read-only sessions retain screen, mouse and reconnect; keyboard is disabled and revocation closes the popup',()=>{
 const h=fixture();h.open();h.props.disabled=true;h.render();assert.equal(h.find('GlassPopup').props.anchor,null);
 h.open();assert.equal(h.find('Pressable','Cerrar teclado').props.disabled,true);assert.equal(h.find('Pressable','Reconectar').props.disabled,false);
 h.find('Pressable','Reconectar').props.onPress();h.render();assert.deepEqual(h.calls,['reconnect']);
});
test('unmount invalidates an asynchronous anchor response',()=>{
 const h=fixture();h.find('GlassButton').props.onPress();h.unmount();h.measure();assert.equal(h.find('GlassPopup').props.anchor,null);
});

test('options use only centered icons in a narrow dropdown while keeping accessible labels and selected states',()=>{
 const h=fixture();h.open();const popup=h.find('GlassPopup');
 assert.equal(popup.props.width,44);assert.equal(popup.props.attached,true);assert.equal(popup.props.rowCount,5);
 for(const row of popup.props.children.props.children.flat().slice(1)){
  assert.equal(row.props.children.type,'ActionIcon');
  assert.equal(row.props.style({pressed:false}).justifyContent,'center');
  assert.equal(typeof row.props.accessibilityLabel,'string');
 }
 assert.equal(h.find('Text'),undefined);
 assert.equal(h.find('Pressable','Ocultar pantalla').props.accessibilityState.selected,true);
});

test('expanding options replaces the trigger with one glass container containing the trigger and four actions',()=>{
 const h=fixture();assert.ok(h.find('GlassButton'));h.open();assert.equal(h.find('GlassButton'),undefined);
 assert.equal(h.find('GlassPopup').props.anchor.y,62);
 h.find('Pressable','Cerrar opciones').props.onPress();h.render();assert.ok(h.find('GlassButton'));
 assert.equal(h.find('GlassPopup').props.anchor,null);assert.deepEqual(h.calls,[]);
});

test('short landscape dropdown leaves its vertical scroll available instead of capturing it for lens selection',()=>{
 const h=fixture();h.viewport.width=844;h.viewport.height=390;h.props.bottomInset=176;h.render();h.open();
 assert.equal(h.find('SessionControlFocus').props.dragEnabled,false);
 assert.equal(h.find('GlassPopup').props.width,44);
});
