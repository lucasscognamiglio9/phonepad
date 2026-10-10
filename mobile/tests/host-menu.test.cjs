const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const initial = {version:1,revision:1,selected:'one',devices:[
  {id:'one',name:'Ubuntu',origin:'https://ubuntu.example'},
  {id:'two',name:'Mac',origin:'https://mac.example'},
]};

function harness(status,options={}) {
  const slots=[]; const effects=[]; const selected=[]; const saved=[]; let cursor=0,dirty=false,tree;
  const react={
    useRef(value) {const i=cursor++;return slots[i]??={current:value};},
    useState(value) { const i=cursor++; if (!(i in slots)) slots[i]=value;
      return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;dirty=true;}]; },
    useEffect(effect,deps) { const i=cursor++; const old=slots[i];
      if (!old || deps.some((value,index)=>!Object.is(value,old.deps[index]))) {
        slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});
      }
    },
  };
  const modules={
    '../lib/notice-message':require('./control-fixture.cjs').load('lib/notice-message.ts'),
    react,
    'react/jsx-runtime':{jsx:(type,props)=>typeof type==='function'?type(props):({type,props}),jsxs:(type,props)=>typeof type==='function'?type(props):({type,props})},
    'react-native':Object.assign(Object.fromEntries(['ActivityIndicator','Pressable','ScrollView','Text','TextInput','View'].map(key=>[key,key])),{
      Keyboard:{dismiss:()=>{}},StyleSheet:{hairlineWidth:1},useWindowDimensions:()=>({width:390,height:844}),
    }),
    'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:54,right:0,bottom:34,left:0})},
    'react-native-keyboard-controller':{useKeyboardState:selector=>selector({isVisible:false,height:0})},
    './appearance':require('./appearance-fixture.cjs'),
    './glass-surface':{GlassSurface:'GlassSurface'},
    './dismissible-notice':{DismissibleNotice:({message,dismiss})=>({type:'Text',props:{accessibilityRole:'alert',children:message,onDismiss:dismiss}})},
    './action-icon':{ActionIcon:'ActionIcon'},
    '../lib/host-settings':{
      hostSettingsAdapter:{},
      loadSelectedHost:async adapter=>({settings:await adapter.load()}),
      selectHost:(settings,id)=>({...settings,selected:id}),
      addHost:(settings,{name,origin})=>({...settings,devices:[...settings.devices,{id:'new',name,origin}]}),
    },
  };
  const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/host-menu.tsx'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const exports={};
  vm.runInNewContext(source,{exports,require:name=>modules[name],fetch:options.fetch??(async()=>({status})),AbortController,setTimeout,clearTimeout});
  const adapter={load:async()=>initial,save:async settings=>{
    saved.push(settings);if(options.save)return options.save(settings);return {ok:true,settings:{...settings,revision:settings.revision+1}};
  }};
  const props={visible:true,activeOrigin:'https://ubuntu.example',connected:true,close:()=>{},
    select:origin=>selected.push(origin),canSwitch:()=>true,adapter};
  function render(){let count=0;do{dirty=false;cursor=0;tree=exports.HostMenu(props);while(effects.length)effects.shift()();
    if (++count>20) throw Error('render loop');}while(dirty);return tree;}
  function nodes(node){if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(nodes);
    return[node,...nodes(node.props?.children)];}
  const find=label=>nodes(tree).find(node=>node.props?.accessibilityLabel===label);
  return {render,find,selected,saved,props,unmount:()=>slots.forEach(s=>s?.cleanup?.()),alert:()=>nodes(tree).find(node=>node.props?.accessibilityRole==='alert')};
}

test('offline computer stays saved without replacing the active session',async()=>{
  const h=harness(503);h.render();await new Promise(setImmediate);h.render();
  h.find('Mac').props.onPress();await new Promise(setImmediate);h.render();
  assert.equal(h.selected.length,0);
  assert.equal(h.saved.length,0);
  assert.equal(h.alert().props.children,'Equipo no disponible.');
});

test('available computer is saved before switching the session',async()=>{
  const h=harness(204);h.render();await new Promise(setImmediate);h.render();
  h.find('Mac').props.onPress();await new Promise(setImmediate);h.render();
  assert.equal(h.saved[0].selected,'two');
  assert.deepEqual(h.selected,['https://mac.example']);
});

test('double tapping a host while the reachability probe is pending cannot start two switches',async()=>{
 let finish,probes=0;const h=harness(204,{fetch:()=>{probes++;return new Promise(resolve=>finish=resolve);}});
 h.render();await new Promise(setImmediate);h.render();const choose=h.find('Mac').props.onPress;
 choose();choose();assert.equal(probes,1);finish({status:204});await new Promise(setImmediate);h.render();
 assert.equal(h.saved.length,1);assert.deepEqual(h.selected,['https://mac.example']);
});
test('a host response arriving after the menu closes cannot save or open the old session',async()=>{
 let finish;const h=harness(204,{fetch:()=>new Promise(resolve=>finish=resolve)});
 h.render();await new Promise(setImmediate);h.render();h.find('Mac').props.onPress();h.props.visible=false;h.render();
 finish({status:204});await new Promise(setImmediate);h.render();assert.equal(h.saved.length,0);assert.equal(h.selected.length,0);
});
test('a save completing after unmount cannot switch the session',async()=>{
 let finish;const h=harness(204,{save:()=>new Promise(resolve=>finish=resolve)});
 h.render();await new Promise(setImmediate);h.render();h.find('Mac').props.onPress();await new Promise(setImmediate);
 h.unmount();finish({ok:true,settings:initial});await new Promise(setImmediate);assert.equal(h.selected.length,0);
});
