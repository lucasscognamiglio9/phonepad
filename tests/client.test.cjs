const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function client(options={}){
 const elements=new Map(),timers=new Map(),events=[],requests=[],removed=[],docEvents={},winEvents={},styles={}; let next=0;
 const on=(map,n,f)=>{(map[n]??=[]).push(f)};
 function element(id){if(!elements.has(id))elements.set(id,{textContent:'',classList:{add(){},remove(){},toggle(){}},listeners:{},addEventListener(n,f){this.listeners[n]=f},contains(){return false},getBoundingClientRect(){return {left:0,top:0,width:300,height:400}},value:"",focus(){},blur(){},setSelectionRange(){},setAttribute(){},setPointerCapture(){},releasePointerCapture(){}});return elements.get(id)}
 class Socket {static OPEN=1;static instances=[];constructor(url){this.url=url;this.readyState=0;this.bufferedAmount=0;this.sent=[];Socket.instances.push(this)} send(s){this.sent.push(JSON.parse(s))} close(){this.readyState=3;this.onclose?.({code:1000})} open(){this.readyState=1;this.onopen?.()} message(t){this.onmessage?.({data:JSON.stringify({t})})}}
 const context=vm.createContext({URL,URLSearchParams,AbortController,Intl,Map,Set,WebSocket:Socket,fetch:async(url,init)=>{requests.push({url,init});return {status:204}},location:{search:options.cookieOnly?'':'?token=test',hash:options.hash||'',protocol:'https:',host:'localhost',href:'https://localhost/?token=test',reload:options.reload||(()=>{})},history:{replaceState(){}},localStorage:{setItem(){},getItem(){return options.cookieOnly?'':'test'},removeItem(key){removed.push(key)}},document:{readyState:'loading',hidden:false,body:element('body'),documentElement:{style:{setProperty(k,v){styles[k]=v}}},querySelectorAll(){return []},getElementById:element,addEventListener(n,f){on(docEvents,n,f)}},window:{SpeechRecognition:options.SR,isSecureContext:true,innerHeight:852,visualViewport:options.viewport,addEventListener(n,f){on(winEvents,n,f)},dispatchEvent(e){events.push(e.type);for(const f of winEvents[e.type]||[])f(e)}},navigator:options.navigator||{},Event:class{constructor(type){this.type=type}},setTimeout(f){timers.set(++next,f);return next},clearTimeout(id){timers.delete(id)},setInterval(){return ++next},clearInterval(){},requestAnimationFrame(){return ++next},cancelAnimationFrame(){},console});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../daemon/web/app.js'),'utf8'),context);
 return {run:s=>vm.runInContext(s,context),Socket,elements,timers,events,requests,removed,styles,context,fireDoc:(n,e={})=>(docEvents[n]||[]).forEach(f=>f(e)),fireWin:(n,e={})=>(winEvents[n]||[]).forEach(f=>f(e))};
}
test('handshake must confirm before any touch or keyboard input',async()=>{
 const c=client();await c.run('Net.connect()');const ws=c.Socket.instances[0];ws.open();
 assert.equal(c.run('Net.isConnected()'),false);c.run('Net.send({t:"k",a:"text",text:"x"})');assert.equal(ws.sent.length,0);
 ws.message('ok');assert.equal(c.run('Net.isConnected()'),true);c.run('Net.send({t:"k",a:"text",text:"x"})');assert.equal(ws.sent.at(-1).text,'x');
});
test('pause clears pointers; stale socket close cannot destroy resumed connection',async()=>{
 const c=client();c.run('Pad.init()');await c.run('Net.connect()');const old=c.Socket.instances[0];old.open();old.message('ok');
 c.elements.get('pad').listeners.pointerdown({pointerId:4,clientX:30,clientY:40});
 c.run('Net.pause()');await c.run('Net.resume()');const fresh=c.Socket.instances.at(-1);fresh.open();fresh.message('ok');old.onclose({code:1000});
 assert.equal(c.run('Net.isConnected()'),true);const before=fresh.sent.length;
 c.elements.get('pad').listeners.pointermove({pointerId:4,clientX:100,clientY:100});assert.equal(fresh.sent.length,before);
});
test('replaced client stops automatically instead of fighting for control',async()=>{
 const c=client();await c.run('Net.connect()');const ws=c.Socket.instances[0];ws.open();ws.message('ok');ws.onclose({code:1008});
 assert.equal(c.run('Net.isConnected()'),false);assert.ok(c.events.includes('phonepad-paused'));await c.run('Net.connect()');assert.equal(c.Socket.instances.length,1);
});
test('backpressure closes stale control transport instead of buffering gestures',async()=>{
 const c=client();await c.run('Net.connect()');const ws=c.Socket.instances[0];ws.open();ws.message('ok');ws.bufferedAmount=65537;
 c.run('Net.send({t:"t",c:[]})');assert.equal(ws.readyState,3);assert.equal(c.run('Net.isConnected()'),false);
});

test('cookie-only session reconnects without credentials in WebSocket URL',async()=>{
 const c=client({cookieOnly:true});await c.run('Net.connect()');
 assert.equal(c.requests[0].url,'/api/auth');assert.equal(c.Socket.instances[0].url,'wss://localhost/ws');
});
test('invitation is claimed once; subsequent authentication uses cookie',async()=>{
 const code='a'.repeat(32),c=client({cookieOnly:true,hash:'#pair='+code});await c.run('Net.connect()');
 assert.equal(c.requests[0].url,'/api/claim');assert.equal(c.requests[0].init.method,'POST');assert.equal(JSON.parse(c.requests[0].init.body).code,code);
 c.run('Net.pause()');await c.run('Net.resume()');assert.equal(c.requests[1].url,'/api/auth');
 assert.ok(c.removed.length>0);assert.equal(c.Socket.instances.at(-1).url,'wss://localhost/ws');
});


function gestureClient(){const c=client();c.run('Pad.init()');return c;}
test('relative pointer, right tap and consecutive upward swipes',async()=>{
 const c=gestureClient();await c.run('Net.connect()');const ws=c.Socket.instances[0];ws.open();ws.message('ok');const p=c.elements.get('pad').listeners;
 const e=(id,x,y)=>({pointerId:id,clientX:x,clientY:y});
 p.pointerdown(e(1,100,200));p.pointermove(e(1,120,210));p.pointerup(e(1,120,210));assert.ok(ws.sent.some(m=>m.t==='m'&&m.dx===40&&m.dy===20));assert.ok(!ws.sent.some(m=>m.t==='b'));
 p.pointerdown(e(1,100,200));p.pointerdown(e(2,130,200));p.pointerup(e(1,100,200));p.pointerup(e(2,130,200));assert.deepEqual(ws.sent.filter(m=>m.t==='b').map(m=>[m.btn,m.a]),[['r','down'],['r','up']]);
 for(let repeat=0;repeat<2;repeat++){for(let id=1;id<=3;id++)p.pointerdown(e(id,100+id*20,250));for(let id=1;id<=3;id++)p.pointermove(e(id,100+id*20,150));for(let id=1;id<=3;id++)p.pointerup(e(id,100+id*20,150));}
 assert.deepEqual(ws.sent.filter(m=>m.t==='g').map(m=>m.name),['overview','apps']);
});

test('keyboard opens shortcuts directly, follows viewport and closes compactly',()=>{
 const listeners={},viewport={height:500,offsetTop:20,addEventListener(n,f){listeners[n]=f}};
 const c=client({viewport});c.run('Sheet.init()');c.elements.get('kbd-toggle').listeners.click();
 assert.equal(c.elements.get('keyboard-extras').hidden,false);
 assert.equal(c.styles['--visible-height'],'500px');assert.equal(c.styles['--visible-top'],'20px');
 viewport.height=330;listeners.resize();assert.equal(c.styles['--visible-height'],'330px');
 c.elements.get('keyboard-extras').hidden=false;c.elements.get('sheet-handle').listeners.click();assert.equal(c.elements.get('keyboard-extras').hidden,true);
});
test('drag releases on cancellation and never becomes a tap',async()=>{
 const c=client();c.run('Pad.init()');await c.run('Net.connect()');const ws=c.Socket.instances[0];ws.open();ws.message('ok');const p=c.elements.get('pad').listeners;
 p.pointerdown({pointerId:1,clientX:100,clientY:100});const timer=[...c.timers.values()].at(-1);timer();
 assert.equal(ws.sent.at(-1).a,'down');p.pointercancel({pointerId:1});assert.equal(ws.sent.at(-1).a,'up');
 const before=ws.sent.length;p.pointerup({pointerId:1});assert.equal(ws.sent.length,before);
});
test('returning from background reconnects; explicit recovery clears replaced-session pause',async()=>{
 const c=client();c.run('main()');await new Promise(setImmediate);
 let ws=c.Socket.instances.at(-1);ws.open();ws.message('ok');
 c.context.document.hidden=true;c.fireDoc('visibilitychange');assert.equal(c.run('Net.isConnected()'),false);
 c.context.document.hidden=false;c.fireDoc('visibilitychange');await new Promise(setImmediate);
 ws=c.Socket.instances.at(-1);ws.open();ws.message('ok');ws.onclose({code:1008});
 c.elements.get('refresh-control').listeners.click();await new Promise(setImmediate);
 ws=c.Socket.instances.at(-1);ws.open();ws.message('ok');c.context.document.hidden=true;c.fireDoc('visibilitychange');c.context.document.hidden=false;c.fireDoc('visibilitychange');await new Promise(setImmediate);assert.notEqual(c.Socket.instances.at(-1),ws);
});

test('updates wait for keyboard focus and active touches',async()=>{
 const listeners={};let reloads=0;const serviceWorker={addEventListener(n,f){listeners[n]=f},register:async()=>({update:async()=>{}})};
 const c=client({navigator:{serviceWorker},reload(){reloads++}});c.run('Updates.init()');await new Promise(setImmediate);
 listeners.controllerchange();c.context.document.activeElement={id:'hidden-input'};[...c.timers.values()].at(-1)();assert.equal(reloads,0);
 c.context.document.activeElement=null;c.fireDoc('pointerdown',{pointerId:1});[...c.timers.values()].at(-1)();assert.equal(reloads,0);
 c.fireDoc('pointerup',{pointerId:1});[...c.timers.values()].at(-1)();assert.equal(reloads,1);
});

test('version handshake recovers a missed controller-change event',async()=>{
 const listeners={},messages=[];let reloads=0;
 const serviceWorker={controller:{postMessage(m){messages.push(m)}},addEventListener(n,f){listeners[n]=f},register:async()=>({update:async()=>{}})};
 const c=client({navigator:{serviceWorker},reload(){reloads++}});c.run('Updates.init()');await new Promise(setImmediate);
 assert.equal(messages[0].type,'PHONEPAD_VERSION');
 listeners.message({data:{type:'PHONEPAD_VERSION',build:'20'}});assert.equal(reloads,0);
 listeners.message({data:{type:'PHONEPAD_VERSION',build:'21'}});[...c.timers.values()].at(-1)();assert.equal(reloads,1);
});


test('native keyboard dismissal restores the initial actions',()=>{
 const c=client();c.run('Sheet.init()');c.elements.get('kbd-toggle').listeners.click();
 c.context.document.activeElement=null;c.elements.get('hidden-input').listeners.blur();
 [...c.timers.values()].at(-1)();assert.equal(c.elements.get('keyboard-extras').hidden,true);
});

test('live preview is also a relative touchpad surface',async()=>{
 const c=gestureClient();await c.run('Net.connect()');const ws=c.Socket.instances[0];ws.open();ws.message('ok');
 const p=c.elements.get('desktop-preview').listeners;
 p.pointerdown({pointerId:1,clientX:100,clientY:100});p.pointermove({pointerId:1,clientX:120,clientY:110});p.pointerup({pointerId:1});
 assert.ok(ws.sent.some(m=>m.t==='m'&&m.dx===40&&m.dy===20));
});


test('explicit recovery revalidates authorization after an earlier rejection',async()=>{
 const c=client({cookieOnly:true});let attempts=0;
 c.context.fetch=async()=>({status:++attempts===1?401:204});
 await c.run('Net.connect()');assert.equal(c.Socket.instances.length,0);
 await c.run('Net.connect()');assert.equal(attempts,1);
 await c.run('Net.resume()');assert.equal(attempts,2);assert.equal(c.Socket.instances.length,1);
});
