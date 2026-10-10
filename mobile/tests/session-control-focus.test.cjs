const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
function fixture(dragEnabled=true){
 const effects=[],values=[],calls=[];
 const jsx=(type,props)=>({type,props});
 const gesture={};for(const name of ['enabled','minDistance','onUpdate','onEnd','onFinalize'])gesture[name]=value=>{gesture[name+'Value']=value;return gesture;};
 const {SessionControlFocus}=load('components/session-control-focus.tsx',{
  react:{useRef:value=>({current:value}),useEffect:fn=>effects.push(fn)},'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{View:'View'},'react-native-gesture-handler':{Gesture:{Pan:()=>gesture},GestureDetector:'GestureDetector'},
  'react-native-reanimated':{__esModule:true,default:{View:'AnimatedView'},ReduceMotion:{System:'system'},useSharedValue:v=>{const value={value:v};values.push(value);return value;},useAnimatedStyle:fn=>fn(),withTiming:v=>v},
  'react-native-worklets':{scheduleOnRN:(fn,...args)=>fn(...args)},'expo-haptics':{selectionAsync:()=>{calls.push('tick');return Promise.resolve();}},
  './glass-surface':{GlassSurface:'GlassSurface'},'./appearance':require('./appearance-fixture.cjs'),
 });
 const actions=Array.from({length:5},(_,i)=>({disabled:i===2,run:()=>calls.push(i)}));
 const tree=SessionControlFocus({children:'icons',actions,dragEnabled});const cleanups=effects.map(fn=>fn());
 return{tree,gesture,values,calls,unmount:()=>cleanups.forEach(fn=>fn?.())};
}
test('options lens follows the finger continuously through native clear glass without committing while dragging',()=>{
 const h=fixture();h.gesture.onUpdateValue({x:22,y:105});
 assert.equal(h.values[0].value,83);assert.deepEqual(h.calls,['tick']);
 const lens=h.tree.props.children.props.children[0];assert.equal(lens.props.pointerEvents,'none');
 assert.equal(lens.props.children.type,'GlassSurface');assert.equal(lens.props.children.props.material,undefined);assert.equal(lens.props.children.props.interactive,true);
});
test('release executes exactly the final enabled icon; disabled icons do not run',()=>{
 const h=fixture();h.gesture.onEndValue({x:22,y:150},true);assert.deepEqual(h.calls,[3]);
 h.gesture.onEndValue({x:22,y:105},true);assert.deepEqual(h.calls,[3]);
});
test('cancel, release outside the rail, or a queued callback after closing executes nothing',()=>{
 const h=fixture();h.gesture.onEndValue({x:22,y:150},false);h.gesture.onEndValue({x:80,y:150},true);
 h.gesture.onEndValue({x:22,y:250},true);h.unmount();h.gesture.onEndValue({x:22,y:150},true);h.gesture.onUpdateValue({x:22,y:105});assert.deepEqual(h.calls,[]);
});
test('lens stays within the capsule and returns to its origin after cancellation without triggering an action',()=>{
 const h=fixture();h.gesture.onUpdateValue({x:22,y:500});assert.equal(h.values[0].value,176);
 h.gesture.onFinalizeValue();assert.equal(h.values[0].value,0);assert.equal(h.values[1].value,0);assert.ok(h.calls.every(c=>c==='tick'));
});

test('a clipped landscape rail yields vertical movement to native scrolling instead of selecting hidden actions',()=>{
 const h=fixture(false);assert.equal(h.gesture.enabledValue,false);
});
