const test=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const appearance=require('./appearance-fixture.cjs');
function fixture(){
 let responder,tree,closed=0,at=0;const refs=[];const jsx=(type,props)=>({type,props});
 const {DismissibleNotice}=load('components/dismissible-notice.tsx',{react:{useMemo:fn=>refs[at++]??=fn(),useRef:value=>refs[at++]??={current:value}},'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{View:'View',Text:'Text',PanResponder:{create:handlers=>{responder=handlers;return {panHandlers:handlers};}}},'./appearance':appearance,'./glass-surface':{GlassSurface:'GlassSurface'},'./glass-button':{GlassButton:'GlassButton'}});
 const props={message:'Revisá el envío',dismiss:()=>closed++};function render(){at=0;tree=DismissibleNotice(props);}render();
 return {props,render,closed:()=>closed,swipe:(dx,dy)=>{if(responder.onMoveShouldSetPanResponder(null,{dx,dy}))responder.onPanResponderRelease(null,{dx,dy});},close:()=>tree.props.children[0].props.children[2].props.onPress()};
}
test('a notice closes with its accessible button or a deliberate swipe, without requiring an app restart',()=>{
 const h=fixture();h.swipe(4,0);assert.equal(h.closed(),0);h.swipe(50,0);assert.equal(h.closed(),1);h.swipe(0,-50);assert.equal(h.closed(),2);h.close();assert.equal(h.closed(),3);
});
test('a held swipe calls the current dismissal callback after a new notice is shown',()=>{
 const h=fixture();let current=0;h.props.dismiss=()=>current++;h.render();h.swipe(60,0);assert.equal(current,1);assert.equal(h.closed(),0);
});
