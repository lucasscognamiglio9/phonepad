const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const initial = {version:1,revision:3,devices:[{id:'one',name:'Casa',origin:'https://one.example'},
  {id:'two',name:'Oficina',origin:'https://two.example'}],selected:'one'};
const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'), {
  fileName:file,
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;

function harness(options={}) {
  const slots=[],effects=[],selected=[],saves=[]; let cursor=0,dirty=false,tree;
  const react={
    useState(initial) {
      const i=cursor++; if(!slots[i]) slots[i]={value:typeof initial==='function'?initial():initial};
      return [slots[i].value,value=>{const next=typeof value==='function'?value(slots[i].value):value;
        if(!Object.is(next,slots[i].value)){slots[i].value=next;dirty=true;}}];
    },
    useRef(initial){const i=cursor++;if(!slots[i])slots[i]={current:initial};return slots[i];},
    useEffect(effect,deps){const i=cursor++,old=slots[i];
      if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});}},
  };
  const native=Object.fromEntries(['ActivityIndicator','KeyboardAvoidingView','Pressable','ScrollView','Text','TextInput','View'].map(k=>[k,k]));
  native.Platform={OS:'ios'};native.StyleSheet={create:x=>x,hairlineWidth:1};
  const modules={
    '../lib/notice-message':require('./control-fixture.cjs').load('lib/notice-message.ts'),
    '../components/appearance':require('./appearance-fixture.cjs'),react,'react-native':native,'react/jsx-runtime':{jsx:(type,props)=>typeof type==='function'?type(props):({type,props}),jsxs:(type,props)=>typeof type==='function'?type(props):({type,props})},
    'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,left:0,right:0,bottom:0})},
    '../components/glass-surface':{GlassSurface:'GlassSurface'},
    '../components/dismissible-notice':{DismissibleNotice:({message,dismiss})=>({type:'View',props:{children:[{type:'Text',props:{children:message}},{type:'Pressable',props:{accessibilityLabel:'Cerrar aviso',onPress:dismiss}}]}})},
    'expo-file-system':{},'expo-crypto':{randomUUID:()=> 'new-host'}};
  const settings={};vm.runInNewContext(compile('lib/host-settings.ts'),{exports:settings,require:name=>modules[name],URL,TextEncoder});
  modules['../lib/host-settings']=settings;
  const exports={};vm.runInNewContext(compile('screens/host-picker.tsx'),{exports,require:name=>modules[name]});
  const adapter={load:options.load ?? (async()=>({settings:initial})),save:async next=>{
    saves.push(next);return options.save?options.save(next):{ok:true,settings:{...next,revision:4}};}};
  const props={adapter,onStartupComplete:options.onStartupComplete,onSelect:origin=>selected.push(origin),autoSelect:options.autoSelect??false};
  function render(){let count=0;do{dirty=false;cursor=0;tree=exports.HostPicker(props);while(effects.length)effects.shift()();
    if(++count>20)throw Error('render loop');}while(dirty);return tree;}
  function nodes(node){if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(nodes);return[node,...nodes(node.props?.children)];}
  const find=label=>nodes(tree).find(n=>n.props?.accessibilityLabel===label);
  render();return{selected,saves,render,find,unmount:()=>slots.forEach(s=>s.cleanup?.()),
    texts:()=>nodes(tree).filter(n=>n.type==='Text').map(n=>n.props.children)};
}

test('saved selection restores only on first launch, without rewriting settings',async()=>{
  const h=harness({autoSelect:true});await tick();h.render();
  assert.deepEqual(h.selected,['https://one.example']);assert.equal(h.saves.length,0);
  const back=harness();await tick();back.render();assert.equal(back.selected.length,0);
});

test('double tap starts one save; selection opens only after durable success',async()=>{
  const answer=deferred(),h=harness({save:()=>answer.promise});await tick();h.render();
  const choose=h.find('Elegir Oficina').props.onPress;
  choose();choose();assert.equal(h.saves.length,1);assert.equal(h.selected.length,0);
  answer.resolve({ok:true,settings:{...h.saves[0],revision:4}});await tick();h.render();
  assert.deepEqual(h.selected,['https://two.example']);
});

test('a failed save retains the current selection and reports the failure',async()=>{
  const h=harness({save:async()=>({ok:false,error:{code:'write-failed',message:'Disco lleno'}})});await tick();h.render();
  h.find('Elegir Oficina').props.onPress();await tick();h.render();
  assert.equal(h.selected.length,0);assert.ok(h.texts().includes('No se pudo guardar la lista de equipos.'));
  assert.equal(h.find('Elegir Casa').props.accessibilityState.selected,true);
});

test('removing a saved host stays in the picker and preserves the other host',async()=>{
  const h=harness();await tick();h.render();h.find('Quitar Casa').props.onPress();await tick();h.render();
  assert.equal(h.selected.length,0);assert.equal(h.find('Elegir Casa'),undefined);
  assert.equal(h.saves[0].devices.length,1);assert.equal(h.saves[0].devices[0].origin,'https://two.example');
});

test('a save completing after unmount cannot open an old host session',async()=>{
  const answer=deferred(),h=harness({save:()=>answer.promise});await tick();h.render();
  h.find('Elegir Oficina').props.onPress();h.unmount();
  answer.resolve({ok:true,settings:{...h.saves[0],revision:4}});await tick();assert.equal(h.selected.length,0);
});

 test('initial loading has no visible copy, then releases the saved host form without a timer',async()=>{
 const answer=deferred(),h=harness({load:()=>answer.promise});assert.deepEqual(h.texts(),[]);assert.equal(h.find('Nombre del equipo'),undefined);
 answer.resolve({settings:initial});await tick();h.render();assert.ok(h.find('Nombre del equipo'));h.unmount();
 });
 test('a rejected initial settings read releases loading and presents recovery controls',async()=>{
 const h=harness({load:async()=>{throw Error('storage unavailable');}});await tick();h.render();assert.ok(h.find('Nombre del equipo'));assert.ok(h.find('Cerrar aviso'));h.unmount();
 });

 test('startup completion hands off to the saved host but ends when manual setup is needed',async()=>{
 let completed=0;const selected=harness({autoSelect:true,coldStart:true,onStartupComplete:()=>completed++});await tick();selected.render();assert.equal(completed,0);assert.equal(selected.selected.length,1);selected.unmount();
 const manual=harness({onStartupComplete:()=>completed++});await tick();manual.render();assert.equal(completed,1);manual.unmount();
 const failure=harness({load:async()=>{throw Error('unreadable');},onStartupComplete:()=>completed++});await tick();failure.render();assert.equal(completed,2);failure.unmount();
 });
