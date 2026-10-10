const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs'),appearance=require('./appearance-fixture.cjs');
const actions=load('lib/actions.ts');
const {getActionMenuLayout}=load('components/action-menu.tsx',{'react-native':{StyleSheet:{absoluteFill:{position:'absolute'},create:x=>x}},'../lib/actions':actions,'./appearance':appearance});
function render(width,height,bottom,ios=true,popupWidth){
 const timings=[],effects=[],jsx=(type,props)=>({type,props});
 const {GlassPopup}=load('components/glass-popup.tsx',{
  react:{useEffect:fn=>effects.push(fn)},'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{Platform:{OS:ios?'ios':'android'},Modal:'Modal',View:'View',Pressable:'Pressable',ScrollView:'ScrollView',StyleSheet:{absoluteFill:{position:'absolute'}},useWindowDimensions:()=>({width,height})},
  'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,left:47,right:47,bottom:21})},
  'react-native-screens':{FullWindowOverlay:'FullWindowOverlay'},
  'react-native-reanimated':{__esModule:true,default:{View:'AnimatedView'},Easing:{out:x=>x,cubic:'cubic'},ReduceMotion:{System:'system'},useSharedValue:value=>({value}),useAnimatedStyle:fn=>fn(),withTiming:(v,config)=>{timings.push(config);return v;}},
  './action-menu':{getActionMenuLayout},'./glass-surface':{GlassSurface:'GlassSurface'},'./appearance':appearance});
 const props={anchor:{x:width-47-52,y:8,width:44,height:44},rowCount:4,width:popupWidth,bottomInset:bottom,close:()=>{},children:'items'};
 const tree=GlassPopup(props);effects.forEach(fn=>fn());
 const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
 return {tree,nodes:nodes(tree),timings};
}
test('short landscape options stay above the keyboard with scrolling rows and no native focus replacement',()=>{
 const h=render(844,390,200);assert.equal(h.tree.type,'FullWindowOverlay');
 const frame=h.nodes.find(n=>n.type==='AnimatedView').props.style[0],surface=h.nodes.find(n=>n.type==='GlassSurface');
 assert.ok(frame.top+surface.props.style.height<=390-200);
 const scroll=h.nodes.find(n=>n.type==='ScrollView');assert.equal(scroll.props.keyboardShouldPersistTaps,'always');assert.equal(scroll.props.keyboardDismissMode,'none');
 assert.equal(h.timings[0].reduceMotion,'system');assert.equal(h.timings[0].duration,180);
});
test('fallback modal supports both orientations and system back dismissal',()=>{
 const h=render(390,844,0,false);assert.equal(h.tree.type,'Modal');assert.deepEqual(Array.from(h.tree.props.supportedOrientations),['portrait','landscape']);assert.equal(typeof h.tree.props.onRequestClose,'function');
});

test('icon dropdown stays narrow, anchored to the options control and within the free keyboard rectangle',()=>{
 for(const [width,height,bottom] of [[390,844,0],[844,390,200]]){
  const h=render(width,height,bottom,true,68);
  const frame=h.nodes.find(n=>n.type==='AnimatedView').props.style[0];
  const surface=h.nodes.find(n=>n.type==='GlassSurface').props.style;
  assert.equal(frame.width,68);assert.ok(frame.left+frame.width<=width-47);
  assert.ok(frame.top+surface.height<=height-bottom);
 }
});

test('attached controls expand from their original frame with no extra padding or gap',()=>{
 const anchor={x:338,y:62,width:44,height:44};
 const frame=getActionMenuLayout(anchor,{width:390,height:844},{top:54,left:0,right:0,bottom:34},0,5,44,{rowHeight:44,padding:0,attachToAnchor:true});
 assert.equal(frame.left,338);assert.equal(frame.top,62);assert.equal(frame.width,44);assert.equal(frame.height,220);
 const short=getActionMenuLayout({x:733,y:8,width:44,height:44},{width:844,height:390},{top:0,left:59,right:59,bottom:21},260,5,44,{rowHeight:44,padding:0,attachToAnchor:true});
 assert.equal(short.top,8);assert.ok(short.height<=114);
});
