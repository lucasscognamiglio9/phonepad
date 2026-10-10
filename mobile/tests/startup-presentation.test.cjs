const test=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
function harness(initialState='active'){
 const slots=[],effects=[],listeners=[];let cursor=0,tree,dirty=false;
 const react={
  useState(initial){const i=cursor++;slots[i]??={value:initial};return[slots[i].value,v=>{const next=typeof v==='function'?v(slots[i].value):v;if(next!==slots[i].value){slots[i].value=next;dirty=true;}}];},
  useCallback(fn,deps){const i=cursor++;slots[i]??={fn};return slots[i].fn;},
  useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
 };
 const jsx=(type,props,key)=>({type,props,key});
 const {default:PhonePad}=load('app/index.tsx',{react,'react/jsx-runtime':{jsx,jsxs:jsx},
  '../components/launch-mark':{LaunchMark:'LaunchMark'},
  'react-native':{View:'View',StyleSheet:{absoluteFill:'absoluteFill'},AppState:{currentState:initialState,addEventListener:(_event,fn)=>{listeners.push(fn);return{remove:()=>listeners.splice(listeners.indexOf(fn),1)};}}},
  '../screens/control':{Control:'Control'},'../screens/host-picker':{HostPicker:'HostPicker'},
 });
 const render=()=>{do{dirty=false;cursor=0;tree=PhonePad();while(effects.length)effects.shift()();}while(dirty);return tree;};render();
 return{render,tree:()=>tree.props.children[0],overlay:()=>tree.props.children[1],state:value=>{listeners.forEach(fn=>fn(value));render();},unmount:()=>slots.forEach(s=>s.cleanup?.()),listeners};
}
test('cold startup keeps one mark through host restoration and waits for its reveal before removing it',()=>{
 const h=harness();assert.equal(h.overlay().props.children.type,'LaunchMark');assert.equal(h.overlay().props.children.props.ready,false);
 h.tree().props.onSelect('https://one.test');h.render();assert.equal(h.tree().type,'Control');assert.equal(h.overlay().props.children.props.ready,false);
 h.tree().props.onStartupComplete();h.render();assert.equal(h.overlay().props.children.props.ready,true);
 h.overlay().props.children.props.onComplete();h.render();assert.equal(h.overlay(),false);
 h.tree().props.onSelectHost('https://two.test');h.render();assert.equal(h.tree().key,'https://two.test');assert.equal(h.overlay(),false);
 h.unmount();assert.equal(h.listeners.length,0);
});
test('background and resume preserve the existing host and never replay the P after an interrupted start',()=>{
 const h=harness();h.tree().props.onSelect('https://one.test');h.render();const key=h.tree().key;
 h.state('inactive');assert.ok(h.overlay());h.state('background');h.state('active');assert.equal(h.overlay(),false);assert.equal(h.tree().key,key);
 h.render();assert.equal(h.overlay(),false);h.unmount();const fresh=harness();assert.ok(fresh.overlay());fresh.unmount();
});
test('manual setup signals readiness; a background-started process skips the presentation',()=>{
 const h=harness();h.tree().props.onStartupComplete();h.render();assert.equal(h.overlay().props.children.props.ready,true);
 h.overlay().props.children.props.onComplete();h.render();h.tree().props.onSelect('https://manual.test');h.render();assert.equal(h.overlay(),false);h.unmount();
 const background=harness('background');assert.equal(background.overlay(),false);background.state('active');assert.equal(background.overlay(),false);background.unmount();
});
test('an unknown initial AppState still presents one cold mark',()=>{
 const h=harness(null);assert.ok(h.overlay());h.state('active');assert.ok(h.overlay());h.unmount();
});
