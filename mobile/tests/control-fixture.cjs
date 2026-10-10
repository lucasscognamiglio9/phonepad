const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load(file, modules={}) {
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{compilerOptions:{module:1,target:9,jsx:4}}).outputText,{exports,require:name=>modules[name],AbortController});return exports;
}
const control=load('lib/control-layout.ts',{'../components/appearance':require('./appearance-fixture.cjs')});
// Render the actual toolbar keys. Keep native recognizer configuration visible to tests.
function recognizer(kind) {
 const gesture={kind};
 for(const method of ['activeOffsetY','failOffsetX','simultaneousWithExternalGesture','onEnd']) gesture[method]=value=>{gesture[method+'Value']=value;return gesture;};
 return gesture;
}
const gestureModule={Gesture:{Native:()=>recognizer('Native'),Pan:()=>recognizer('Pan')},GestureDetector:'GestureDetector'};
function install(modules, jsx) {
 modules['../lib/native-caret']=load('lib/native-caret.ts');
 modules['../lib/notice-message']=load('lib/notice-message.ts');
 const native={'react-native':{Pressable:'Pressable',Text:'Text',View:'View',ScrollView:'ScrollView'},'react/jsx-runtime':{jsx,jsxs:jsx},'./appearance':require('./appearance-fixture.cjs'),'./action-icon':{ActionIcon:'ActionIcon'}};
 const key=load('components/shortcut-key.tsx',native);
 const panel=load('components/shortcut-panel.tsx',{...native,react:modules.react,'./shortcut-key':key,'./glass-surface':{GlassSurface:'GlassSurface'},'react-native-worklets':{scheduleOnRN:(fn,...args)=>fn(...args)},'react-native-gesture-handler':gestureModule,'../lib/control-layout':control});
 modules['./dismissible-notice']={DismissibleNotice:props=>jsx('Notice',{...props,children:[jsx('Text',{children:props.message}),props.children,props.action&&jsx('GlassButton',{label:props.action.label,onPress:props.action.run}),jsx('GlassButton',{label:'Cerrar aviso',onPress:props.dismiss})]})};
 modules['./shortcut-panel']=panel;modules['../lib/control-layout']=control;
 modules['../lib/text-delivery']=load('lib/text-delivery.ts',{'./clipboard-transfer':modules['../lib/clipboard-transfer'],'./control-layout':control});
}
function find(nodes,tree,type,label) {
 const all=nodes(tree), node=all.find(n=>n.type===type&&(!label||n.props.label===label));if(node)return node;
 if(type!=='GlassButton')return;
 const key=all.find(n=>n.type==='Pressable'&&n.props.accessibilityLabel===label);if(key)return {...key,props:{...key.props,label,selected:key.props.accessibilityState?.selected}};

}
module.exports={load,control,install,find};
