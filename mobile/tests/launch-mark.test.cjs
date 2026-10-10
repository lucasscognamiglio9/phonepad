const test=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const {appearance}=require('./appearance-fixture.cjs');
function harness(reduced=false){
 const slots=[],effects=[],listeners={},timings=[],cancelled=[],animations=[],styles=[];let cursor=0,dirty=false,tree,ready=false,completions=0;
 const react={
  useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,v=>{const next=typeof v==='function'?v(slots[i].value):v;if(next!==slots[i].value){slots[i].value=next;dirty=true;}}];},
  useRef(initial){const i=cursor++;slots[i]??={current:initial};return slots[i];},
  useCallback(fn){const i=cursor++;slots[i]??={fn};return slots[i].fn;},
  useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
 };
 const listen=(name,fn)=>{listeners[name]=fn;return{remove:()=>delete listeners[name]};};
 class Timing{constructor(minimum,exit){this.minimum=minimum;this.exit=exit;timings.push(this);}show(){this.shown=true;}markReady(){this.ready=true;}setActive(v){this.active=v;}dispose(){this.disposed=true;}}
 const reanimated={__esModule:true,default:{View:'AnimatedView',Image:'AnimatedImage'},ReduceMotion:{Never:'never'},
  Easing:{inOut:x=>x,cubic:'cubic'},useReducedMotion:()=>reduced,
  useSharedValue(v){const i=cursor++;slots[i]??={value:v};return slots[i];},useAnimatedStyle:fn=>{styles.push(fn);return fn();},cancelAnimation:v=>cancelled.push(v),
  withTiming:(to,config,done)=>{const a={to,config,done};animations.push(a);return a;},
 };
 const jsx=(type,props)=>({type,props});
 const {LaunchMark}=load('components/launch-mark.tsx',{react,'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{useWindowDimensions:()=>({width:390,height:844}),AppState:{currentState:'active',addEventListener:listen},AccessibilityInfo:{addEventListener:listen}},
  'react-native-reanimated':reanimated,'react-native-worklets':{scheduleOnRN:fn=>fn()},'./appearance':{appearance},'../lib/launch-timing':{LaunchTiming:Timing},'../../assets/phonepad-icon.png':'current-brand',
 });
 const render=()=>{do{dirty=false;cursor=0;styles.length=0;tree=LaunchMark({ready,onComplete:()=>completions++});while(effects.length)effects.shift()();}while(dirty);return tree;};render();
 return{render,tree:()=>tree,timings,animations,cancelled,listeners,styles,slots,ready:()=>{ready=true;render();},completions:()=>completions,unmount:()=>slots.forEach(s=>s.cleanup?.())};
}
test('the cold mark is the existing P only, with no visible text, disk or spinner',()=>{
 const h=harness();assert.equal(h.tree().props.accessibilityLabel,'PhonePad');const image=h.tree().props.children;
 assert.equal(image.type,'AnimatedImage');assert.equal(image.props.source,'current-brand');assert.equal(image.props.style[0].width,192);
 assert.equal(h.animations.length,0);image.props.onLoad();assert.equal(h.timings[0].shown,true);h.unmount();
});
test('readiness waits for the hold; a completed native reveal removes the mark once',()=>{
 const h=harness();h.ready();assert.equal(h.timings[0].ready,true);assert.equal(h.animations.length,0);
 h.timings[0].exit();h.render();const a=h.animations.at(-1);assert.equal(a.config.duration,320);a.done(false);assert.equal(h.completions(),0);a.done(true);a.done(true);assert.equal(h.completions(),1);h.unmount();
});
test('reduced motion uses a short fade and never enlarges the P, including live preference changes',()=>{
 const h=harness();h.ready();h.timings[0].exit();h.render();h.listeners.reduceMotionChanged(true);h.render();
 assert.equal(h.animations.at(-1).config.duration,160);assert.equal(h.styles[1]().transform[0].scale,1);h.unmount();
});
test('inactive transitions cancel the reveal; disposal removes listeners and rejects queued completion',()=>{
 const h=harness();h.timings[0].exit();h.render();const before=h.cancelled.length;h.listeners.change('inactive');h.render();assert.ok(h.cancelled.length>before);assert.equal(h.timings[0].active,false);
 h.listeners.change('active');h.render();const a=h.animations.at(-1);h.unmount();a.done(true);assert.equal(h.completions(),0);assert.equal(h.timings[0].disposed,true);assert.deepEqual(Object.keys(h.listeners),[]);
});
