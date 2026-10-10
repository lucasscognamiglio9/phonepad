const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const appearance=require('./appearance-fixture.cjs');
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];}
function fixture(label){
 let ref,tree,vibrations=0;const changed=[],jsx=(type,props)=>({type,props});
 const {SessionOptions}=load('components/session-options.tsx',{
  react:{useRef:value=>ref??={current:value}},'react/jsx-runtime':{jsx,jsxs:jsx},
  'expo-haptics':{selectionAsync:async()=>{vibrations++;}},'@expo/ui':{Host:'Host',Slider:'Slider'},
  'react-native':{Modal:'Modal',Platform:{OS:'ios'},ScrollView:'ScrollView',View:'View',Text:'Text',Pressable:'Pressable',useWindowDimensions:()=>({width:390,height:844})},
  'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:54,bottom:34,left:0,right:0})},'../lib/control-preferences':load('lib/control-preferences.ts'), './appearance':appearance,'./glass-surface':{GlassSurface:'GlassSurface'},'./glass-button':{GlassButton:'GlassButton'},
 });
 const root=SessionOptions({visible:true,close:()=>{},preferences:{gain:3,cursorScale:.95},change:()=>{}});
 const component=nodes(root).find(n=>n.props?.label===label),props={...component.props,update:value=>changed.push(value)};
 function render(){tree=component.type(props);}render();
 return {root,props,render,changed,vibrations:()=>vibrations,slider:()=>nodes(tree).find(n=>n.type==='Slider'),nodes:()=>nodes(tree)};
}
test('both sliders share a continuous percentage scale, with no visible markers or update row',()=>{
 for(const label of ['Sensibilidad','Tamaño del cursor']){
  const h=fixture(label),slider=h.slider().props;
  assert.equal(slider.value,h.props.value);assert.equal(slider.min,50);assert.equal(slider.max,150);assert.equal(slider.step,undefined);
  slider.onValueChange(103.1);slider.onValueChange(103.4);slider.onValueChange(103.5);
  assert.deepEqual(h.changed,[103.1,103.4,103.5]);
  assert.equal(h.nodes().some(n=>n.props?.pointerEvents==='none'),false);
  assert.equal(nodes(h.root).some(n=>n.type==='GlassButton'),false);
 }
});

test('haptics tick only at reference percentages in either direction, without snapping decimals',()=>{
 for(const label of ['Sensibilidad','Tamaño del cursor']){
  const h=fixture(label);h.props.value=100;h.render();const change=h.slider().props.onValueChange;
  for(const value of [100,100.1,124.9])change(value);assert.equal(h.vibrations(),0);
  change(125);change(125);change(125.1);assert.equal(h.vibrations(),1);
  change(124.9);assert.equal(h.vibrations(),2);
  change(101);change(100);assert.equal(h.vibrations(),3);
  change(99.9);change(90.7);assert.equal(h.vibrations(),3);
  change(74.9);assert.equal(h.vibrations(),4);change(75.1);assert.equal(h.vibrations(),5);
 }
});

test('invalid events and repeated range overflow cannot corrupt settings or duplicate ticks',()=>{
 const h=fixture('Sensibilidad'),change=h.slider().props.onValueChange;
 for(const value of [NaN,Infinity,-Infinity])change(value);
 assert.deepEqual(h.changed,[]);assert.equal(h.vibrations(),0);
 change(999);change(999);assert.deepEqual(h.changed,[150]);assert.equal(h.vibrations(),1);
 change(-999);change(-999);assert.deepEqual(h.changed,[150,50]);assert.equal(h.vibrations(),2);
});

test('restoring saved settings changes neither their values nor haptics until the slider is moved',()=>{
 const h=fixture('Tamaño del cursor');assert.equal(h.slider().props.value,95);
 assert.deepEqual(h.changed,[]);assert.equal(h.vibrations(),0);
 h.slider().props.onValueChange(98);assert.equal(h.vibrations(),0);
 h.slider().props.onValueChange(102);assert.equal(h.vibrations(),1);
 h.props.value=124;h.render();assert.equal(h.slider().props.value,124);
 h.slider().props.onValueChange(124.5);assert.equal(h.vibrations(),1);
 assert.deepEqual(h.changed,[98,102,124.5]);
});
