const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs'),appearance=require('./appearance-fixture.cjs');
const reflection=load('components/glass-reflection.ts',{'./appearance':appearance});
const jsx=(type,props)=>({type,props});
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
test('native perimeter retains CSS stops and the approved paint intensity',()=>{
 for(const x of [0,.25,.5,.75,1]){
  const g=reflection.reflectionGradient(x,.78,390,156);assert.equal(g.colors.length,101);
  for(const [i,a] of [[0,.025],[23,.17+(1-Math.abs(x-.5)*2)*.1],[52,.025],[79,.11],[100,.015]])assert.equal(g.colors[i],`rgba(255,255,255,${a.toFixed(4)})`);
 }
});
test('CSS angle survives narrow columns, circles, rotation and invalid first dimensions',()=>{
 for(const [w,h] of [[240,56],[390,156],[44,44],[44,220],[0,0]]){
  const g=reflection.reflectionGradient(.25,.6,w,h),dx=(g.endPoint.x-g.startPoint.x)*Math.max(1,w),dy=(g.endPoint.y-g.startPoint.y)*Math.max(1,h);
  assert.ok(Math.abs(Math.atan2(dx,-dy)-(125+.25*95+(.6-.5)*30)*Math.PI/180)<1e-10);
  assert.equal(g.startPoint.x+g.endPoint.x,1);assert.equal(g.startPoint.y+g.endPoint.y,1);
 }
 const bad=reflection.reflectionGradient(NaN,Infinity,NaN,Infinity);assert.ok(bad.colors.every(c=>!c.includes('NaN')));assert.ok(Number.isFinite(bad.startPoint.x));
});
test('Expo SwiftUI renders only an inset perimeter over a transparent rectangle',()=>{
 let animated;const motion={x:{value:.25},y:{value:.6},width:{value:240},height:{value:56},contact:{value:1}};
 const {GlassEdge}=load('components/glass-edge.ios.tsx',{
  react:{forwardRef:fn=>fn},'react/jsx-runtime':{jsx,jsxs:jsx},'@expo/ui/swift-ui':{Host:'Host',Rectangle:'Rectangle'},
  '@expo/ui/swift-ui/modifiers':{foregroundStyle:content=>({$type:'foregroundStyle',content}),strokeBorder:props=>({$type:'strokeBorder',...props})},
  'react-native':{StyleSheet:{absoluteFill:{position:'absolute',inset:0}}},
  'react-native-reanimated':{__esModule:true,default:{createAnimatedComponent:()=> 'AnimatedHost'},useDerivedValue:fn=>({get value(){return fn();}}),useAnimatedProps:fn=>{animated=fn;return fn();}},
  './appearance':appearance,'./glass-reflection':reflection,
 });
 const tree=GlassEdge({radius:24,motion});assert.equal(tree.props.pointerEvents,'none');assert.equal(tree.props.ignoreSafeArea,'all');
 assert.equal(tree.props.children.props.modifiers[0].content,'transparent');
 for(const s of animated().modifiers){assert.equal(s.$type,'strokeBorder');assert.equal(s.style.lineWidth,1);assert.equal(s.cornerRadius,24);}
 const before=animated().modifiers[2].content;motion.x.value=.9;assert.notEqual(animated().modifiers[2].content.center.x,before.center.x);
});
function surfaceFixture(available=true,glassPointer){
 let index=0,tree;const slots=[],pending=[],cleanups=[],listeners={},timings=[],sets=[],events=[],reactions=[];
 const react={useState:initial=>{const at=index++;if(!(at in slots))slots[at]=initial;return [slots[at],v=>{slots[at]=v;sets.push(v);}];},useEffect:(fn,deps)=>{const at=index++;if(!(at in slots)){slots[at]=deps;pending.push(fn);}}};
 const child={type:'TextInput',props:{value:'hola'}};
 const props={glassPointer,style:{width:240,borderRadius:24,padding:4},children:child,onLayout:()=>events.push('layout'),onTouchStart:()=>events.push('start'),onTouchMove:()=>events.push('move'),onTouchEnd:()=>events.push('end')};
 const {GlassSurface}=load('components/glass-surface.tsx',{
  react,'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{View:'View',StyleSheet:{absoluteFill:{position:'absolute',inset:0},flatten:x=>x},useWindowDimensions:()=>({width:844,height:390}),AccessibilityInfo:{addEventListener:(name,fn)=>{listeners[name]=fn;return{remove:()=>delete listeners[name]};},isReduceTransparencyEnabled:async()=>false,isReduceMotionEnabled:async()=>false}},
  'expo-glass-effect':{GlassView:'GlassView',isLiquidGlassAvailable:()=>available,isGlassEffectAPIAvailable:()=>available},
  'react-native-reanimated':{useAnimatedReaction:(read,run)=>{const at=index++;slots[at]??={read,run};slots[at].read=read;slots[at].run=run;reactions[at]=slots[at];},Easing:{out:x=>x,exp:'exp'},ReduceMotion:{System:'system'},useSharedValue:initial=>{const at=index++;return slots[at]??={value:initial};},withTiming:(v,config)=>{timings.push(config);return v;},cancelAnimation:()=>{}},
  './appearance':appearance,'./glass-edge':{GlassEdge:'GlassEdge'},'./glass-reflection':reflection,
 });
 function render(){index=0;tree=GlassSurface(props);pending.splice(0).forEach(fn=>cleanups.push(fn()));return tree;}
 render();return {tree:()=>tree,render,child,events,listeners,timings,sets,react:()=>reactions.forEach(r=>r.run(r.read())),unmount:()=>cleanups.forEach(fn=>fn?.())};
}
test('clear material stays stable; separate edge observes touches without input renders or idle animation',()=>{
 const h=surfaceFixture(),all=nodes(h.tree()),glass=all.find(n=>n.type==='GlassView'),edge=all.find(n=>n.type==='GlassEdge');
 assert.equal(glass.props.glassEffectStyle,'clear');assert.equal(glass.props.isInteractive,false);assert.equal(glass.props.pointerEvents,'none');
 assert.equal(h.tree().props.style[1].backgroundColor,'transparent');assert.ok(all.includes(h.child));assert.equal(edge.props.radius,24);
 assert.equal(all.find(n=>n.props?.accessibilityElementsHidden).props.pointerEvents,'none');assert.equal(h.timings.length,0);
 h.tree().props.onLayout({nativeEvent:{layout:{width:240,height:156}}});
 h.tree().props.onTouchStart({nativeEvent:{pageX:400,pageY:100}});h.tree().props.onTouchMove({nativeEvent:{pageX:500,pageY:120}});h.tree().props.onTouchEnd({nativeEvent:{touches:[]}});
 assert.deepEqual(h.events,['layout','start','move','end']);assert.equal(h.sets.length,0);assert.ok(h.timings.every(t=>t.reduceMotion==='system'));
 assert.equal(edge.props.motion.x.value,.5);assert.equal(edge.props.motion.y.value,.78);assert.equal(edge.props.motion.width.value,240);
});
test('unsupported glass stays transparent; accessibility changes never replace the editor and stop motion',async()=>{
 const h=surfaceFixture(false);await new Promise(setImmediate);
 assert.equal(nodes(h.tree()).find(n=>n.type==='GlassView'),undefined);
 assert.ok(nodes(h.tree()).some(n=>n.type==='View'&&Array.isArray(n.props.style)&&n.props.style[1]?.backgroundColor==='rgba(12,12,14,0.14)'));
 h.listeners.reduceTransparencyChanged(true);h.render();assert.equal(h.tree().props.style[1].backgroundColor,'#242424');assert.ok(nodes(h.tree()).includes(h.child));
 h.listeners.reduceMotionChanged(true);const before=h.timings.length;h.tree().props.onTouchMove({nativeEvent:{pageX:500,pageY:120}});assert.equal(h.timings.length,before);
 h.unmount();assert.deepEqual(Object.keys(h.listeners),[]);
});

test('touchpad shared position moves the localized composer reflection without React state or hit testing',()=>{
 const pointer={value:{x:.5,y:.78,active:false}},h=surfaceFixture(true,pointer);
 const edge=nodes(h.tree()).find(n=>n.type==='GlassEdge');
 for(const x of [.1,.5,.9]){
  pointer.value={x,y:.4,active:true};h.react();
  assert.equal(edge.props.motion.x.value,x);assert.equal(edge.props.motion.contact.value,1);
  const glow=reflection.reflectionHighlight(x,240,1);
  assert.equal(glow.center.x,x);assert.equal(glow.center.y,0);assert.equal(glow.colors.length,3);
  assert.equal(h.timings.at(-1).duration,90);
 }
 pointer.value={x:.5,y:.78,active:false};h.react();
 assert.equal(edge.props.motion.contact.value,0);assert.equal(edge.props.motion.x.value,.5);assert.equal(h.timings.at(-1).duration,710);
 assert.equal(h.sets.length,0);h.listeners.reduceMotionChanged(true);
 pointer.value={x:.2,y:.6,active:true};h.react();assert.equal(edge.props.motion.contact.value,0);
 h.unmount();
});
