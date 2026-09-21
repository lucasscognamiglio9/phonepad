"use strict";
(() => {
 const C=window.PhonepadCore,N=window.PhonepadNet,$=id=>document.getElementById(id);
 const literal=new C.LiteralTransfer(location.origin,()=>N.inputCaps,()=>N.capabilities?.sessionEpoch??null);
 const draft=$('web-draft'),status=$('text-result'),options=$('receiver-options'),result=$('receiver-result');
 let composing=false,activeKey=null,keyTimer=null,keyRepeat=null,transfer=null,batch=null,files=[],bytes=[],busy=false,wake=null,wakeGeneration=0;
 const prefs=(()=>{try{return JSON.parse(localStorage.getItem('phonepad-controls-v1'))||{}}catch{return {}}})();
 let mode=prefs.mode==='direct'?'direct':'trackpad',gain=Number.isFinite(prefs.gain)?Math.max(.5,Math.min(2,prefs.gain)):1;
 $('pointer-mode').value=mode;$('pointer-gain').value=gain;
 function savePreferences(){localStorage.setItem('phonepad-controls-v1',JSON.stringify({mode,gain}));}
 function notice(error){result.textContent=error?.message??String(error);}
 function state(){
  const connected=N.isConnected(),input=connected&&C.allowsInput(N.capabilities,'k');
  $('send-text').disabled=!input||literal.busy||!!literal.pending||composing;
  $('review-text').disabled=!connected||literal.busy||!literal.pending;
  $('resolve-text').disabled=!connected||literal.busy||!literal.pending;
  draft.readOnly=literal.busy;
  const directAvailable=connected&&N.capabilities?.input.actions.includes('p');
  $('pointer-mode').querySelector('option[value=direct]').disabled=!directAvailable;
  $('clipboard-phone').disabled=$('clipboard-host').disabled=!connected||!C.allowsPermission(N.capabilities,'clipboard');
  for(const el of document.querySelectorAll('.key--special,.key--mod'))el.disabled=!input||!!literal.pending||literal.busy;
 }
 function outcome(receipt,sent){
  status.textContent=({dispatched:'Texto aplicado.',uncertain:'Resultado incierto. Revisá el equipo antes de volver a enviar.',rejected:'Texto rechazado. Se conserva el borrador.',cancelled:'Envío cancelado.',receiving:'Texto preparado; todavía no aplicado.',dispatching:'El equipo está procesando el texto.'})[receipt.state]??receipt.state;
  if(receipt.state==='dispatched'&&draft.value===sent)draft.value='';
  literal.acknowledged();state();
 }
 draft.addEventListener('compositionstart',()=>{composing=true;state();});draft.addEventListener('compositionend',()=>{composing=false;state();});
 draft.addEventListener('input',()=>{literal.draft=draft.value;state();});
 $('send-text').onclick=async()=>{if(composing)return;const text=draft.value;try{const work=literal.send(text);state();outcome(await work,text);}catch(e){status.textContent=e.message;}finally{state();}};
 $('review-text').onclick=async()=>{try{outcome(await literal.status(),literal.pending?.text);}catch(e){status.textContent=e.message;}finally{state();}};
 $('resolve-text').onclick=async()=>{if(!confirm('¿Ya revisaste en la computadora si el texto llegó? No se reenviará automáticamente.'))return;try{if(await literal.reviewed())status.textContent='Resultado revisado. Se conserva el borrador para que decidas.';}catch(e){status.textContent=e.message;}state();};
 const mods=new Set();
 function cancelKey(){clearTimeout(keyTimer);clearInterval(keyRepeat);if(activeKey)N.send({t:'k',a:'cancel',operationId:activeKey.id,phase:'cancel'});activeKey=null;}
 function pressKey(command,repeat=false){
  cancelKey();if(literal.pending||literal.busy||!N.isConnected())return;
  const id=crypto.randomUUID(),op={id,sequence:1,command};
  if(!N.send({...command,operationId:id,phase:'press',actionSequence:op.sequence++}))return;
  activeKey=op;status.textContent='Esperando confirmación de la tecla…';
  if(repeat)keyTimer=setTimeout(()=>{keyRepeat=setInterval(()=>{if(activeKey!==op)return;if(!N.send({...command,operationId:id,phase:'repeat',actionSequence:op.sequence++}))cancelKey();},80);},380);
 }
 document.querySelectorAll('.key--mod').forEach(el=>el.onclick=()=>{const mod=el.dataset.mod;mods.has(mod)?mods.delete(mod):mods.add(mod);el.classList.toggle('is-armed',mods.has(mod));el.setAttribute('aria-pressed',String(mods.has(mod)));});
 document.querySelectorAll('.key--special').forEach(el=>{
  el.onpointerdown=e=>{e.preventDefault();el.setPointerCapture(e.pointerId);const key=el.dataset.key;pressKey(mods.size?{t:'k',a:'combo',mods:[...mods],key}:{t:'k',a:'special',key},key.startsWith('Arrow')||key==='Backspace');};
  el.onpointerup=el.onpointercancel=el.onlostpointercapture=cancelKey;
 });
 for(const [id,key] of [['copy','c'],['paste','v']])$(id).onclick=()=>{pressKey({t:'k',a:'combo',mods:['ctrl'],key});};
 window.addEventListener('phonepad-receipt',e=>{const r=e.detail;if(r.operationId!==activeKey?.id)return;status.textContent=r.state==='executed'?'Tecla ejecutada.':r.state==='admitted'?'Tecla admitida; no se observó el resultado.':r.state==='cancelled'?'Repetición detenida.':'Tecla rechazada o incierta. Revisá el equipo.';if(['rejected','uncertain','cancelled'].includes(r.state))cancelKey();});
 $('open-options').onclick=()=>{cancelKey();options.showModal();};$('close-options').onclick=()=>options.close();
 $('pointer-mode').onchange=()=>{mode=$('pointer-mode').value;resetPointer();try{savePreferences()}catch(e){notice(e)}};
 $('pointer-gain').oninput=()=>{gain=Number($('pointer-gain').value);try{savePreferences()}catch(e){notice(e)}};
 async function clipboard(direction){
  const epoch=N.capabilities?.sessionEpoch;if(!epoch||!C.allowsPermission(N.capabilities,'clipboard'))throw Error('El clipboard no está disponible.');
  const text=direction==='host'?await navigator.clipboard.readText():undefined;
  if(text!==undefined&&(new TextEncoder().encode(text).length>131072||text.includes('\0')))throw Error('El límite es 128 KiB de texto.');
  if(epoch!==N.capabilities?.sessionEpoch)throw Error('La sesión cambió.');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10000);
  try{
   const response=await fetch('/api/clipboard',{method:direction==='host'?'POST':'GET',headers:{'Content-Type':'application/json','X-PhonePad-Session':epoch},body:text===undefined?undefined:JSON.stringify({text}),signal:abort.signal});
   if(!response.ok)throw Error('No se confirmó la copia. Revisá permisos y compatibilidad.');
   const value=await response.json();if(value.sessionEpoch!==epoch||epoch!==N.capabilities?.sessionEpoch)throw Error('La sesión cambió. Revisá la copia.');
   if(direction==='phone'){if(typeof value.text!=='string'||new TextEncoder().encode(value.text).length>131072)throw Error('Respuesta inválida.');await navigator.clipboard.writeText(value.text);}
   notice(direction==='phone'?'Texto copiado al teléfono.':'Texto copiado al equipo.');
  }finally{clearTimeout(timer);}
 }
 $('clipboard-phone').onclick=()=>clipboard('phone').catch(notice);$('clipboard-host').onclick=()=>clipboard('host').catch(notice);
 function storage(value){return new Promise((resolve,reject)=>{const opening=indexedDB.open('phonepad-transfer-v1',1);opening.onupgradeneeded=()=>opening.result.createObjectStore('pending');opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('pending',value===undefined?'readonly':'readwrite'),store=tx.objectStore('pending');const request=value===undefined?store.get('batch'):value===null?store.delete('batch'):store.put(value,'batch');let answer;request.onsuccess=()=>answer=request.result;tx.oncomplete=()=>{db.close();resolve(answer)};tx.onerror=()=>{db.close();reject(tx.error)};};});}
 function review(){
  $('file-review').replaceChildren();files.forEach((file,index)=>{const li=document.createElement('li');li.textContent=`${index+1}. ${file.name} · ${(file.size/1048576).toFixed(1)} MB `;
   for(const [label,action] of [['Subir',()=>{if(index>0){[files[index-1],files[index]]=[files[index],files[index-1]];bytes=[];review();}}],['Quitar',()=>{files.splice(index,1);bytes=[];review();}]]){const button=document.createElement('button');button.textContent=label;button.disabled=busy||!!batch;button.onclick=action;li.append(button);}$('file-review').append(li);});
  $('cancel-files').disabled=busy;$('pause-files').disabled=!busy;
  $('file-picker').disabled=busy||!!batch;$('send-files').disabled=busy||!files.length;$('send-files').textContent=batch?'Reanudar mismo lote':'Enviar lote';$('copy-files').disabled=busy||!batch;
 }
 $('file-picker').onchange=()=>{bytes=[];files=Array.from($('file-picker').files);if(files.length>20){files=[];notice('El máximo es 20 archivos.');}review();};
 async function runTransfer(work){if(busy)return;busy=true;transfer=new AbortController();review();try{await work(transfer.signal);}catch(e){notice(transfer.signal.aborted?'Envío pausado. Conservamos el lote.':e);}finally{busy=false;transfer=null;review();}}
 $('send-files').onclick=()=>runTransfer(async signal=>{
  const epoch=N.capabilities?.sessionEpoch;if(!N.isConnected()||!epoch||!C.allowsPermission(N.capabilities,'files'))throw Error('El equipo no permite recibir archivos.');
  const limits=await C.transferLimits(location.origin,signal,epoch);
  if(files.length>limits.maxFiles||files.reduce((sum,f)=>sum+f.size,0)>limits.maxBytes)throw Error('El lote supera los límites del equipo.');
  for(let i=0;i<files.length;i++){if(signal.aborted)throw Error('Cancelado');if(!bytes[i])bytes[i]=new Uint8Array(await files[i].arrayBuffer());}
  if(!batch){batch={origin:location.origin,createdAt:Date.now(),manifest:{version:2,id:crypto.randomUUID(),files:files.map((f,i)=>({name:f.name,type:f.type||'application/octet-stream',bytes:f.size,sha256:C.checksum(bytes[i])}))}};}
  await storage({batch,files});
  if(signal.aborted||epoch!==N.capabilities?.sessionEpoch)throw Error('La sesión cambió.');
  batch={...batch,sessionEpoch:epoch};
  const receipt=await C.sendPreparedBatch(batch,limits,(_,i,offset,count)=>bytes[i].subarray(offset,offset+count),signal,p=>notice(`Enviando ${p}%`));
  notice(receipt.state==='stored'?'Lote completo guardado. Podés preparar el portapapeles y pegarlo en un destino compatible.':'Lote pendiente.');
 });
 $('pause-files').onclick=()=>transfer?.abort();
 $('cancel-files').onclick=()=>runTransfer(async signal=>{if(batch)await C.cancelPreparedBatch({...batch,sessionEpoch:N.capabilities?.sessionEpoch},signal);await storage(null);batch=null;files=[];bytes=[];notice('Lote cancelado. Los archivos ya publicados, si los había, permanecen en el equipo.');});
 $('copy-files').onclick=()=>runTransfer(async signal=>{if(!batch)throw Error('No hay un lote completo.');const r=await C.copyPreparedBatch({...batch,sessionEpoch:N.capabilities?.sessionEpoch},signal);notice(r.clipboard?.state==='ready'?'Lote preparado para pegar.':'No se confirmó el clipboard. Los archivos siguen guardados.');});
 storage().then(saved=>{if(saved?.batch&&Array.isArray(saved.files)){batch=saved.batch;files=saved.files;review();notice('Hay un lote pendiente. Podés reanudarlo.');}}).catch(()=>notice('El navegador no permite conservar lotes entre aperturas.'));
 // Use the same geometry and button state machine as native Direct mode.
 const video=$('desktop-preview'),points=new Map(),direct=new C.DirectPointerSequence(c=>N.send(c));let scale=1,pan={x:0,y:0},base=null,zoom=false,pointerEpoch=null;
 function transform(){video.style.transform=`translate(${pan.x}px,${pan.y}px) scale(${scale})`;}
 function resetPointer(){direct.cancel();points.clear();base=null;zoom=false;}
 $('zoom-reset').onclick=()=>{resetPointer();scale=1;pan={x:0,y:0};transform();};
 function position(e){const rect=video.parentElement.getBoundingClientRect();return {id:e.pointerId,x:e.clientX-rect.left,y:e.clientY-rect.top};}
 function mapped(){const rect=video.parentElement.getBoundingClientRect();return [...points.values()].map(p=>C.directPoint(p.x,p.y,rect.width,rect.height,video.videoWidth,video.videoHeight,scale,pan.x,pan.y)).filter(Boolean);}
 for(const name of ['pointerdown','pointermove','pointerup','pointercancel'])video.addEventListener(name,e=>{
  const directAllowed=mode==='direct'&&N.capabilities?.input.actions.includes('p');
  if(!directAllowed&&scale===1&&points.size===0&&name!=='pointerdown')return;
  if(name==='pointerdown'){
   if(!points.size)pointerEpoch=N.capabilities?.sessionEpoch;
   points.set(e.pointerId,position(e));if(points.size===2){const [a,b]=[...points.values()];base={distance:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2,scale,pan:{...pan}};}
   if(directAllowed)video.setPointerCapture(e.pointerId);
  }else if(name==='pointermove'&&points.has(e.pointerId))points.set(e.pointerId,position(e));
  if(pointerEpoch!==N.capabilities?.sessionEpoch){resetPointer();return;}
  if(points.size===2&&base&&name==='pointermove'){
   const [a,b]=[...points.values()],ratio=Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,base.distance);
   if(zoom||scale>1||Math.abs(ratio-1)>.08){zoom=true;direct.cancel();Pad.reset();scale=C.clampPreviewScale(base.scale*ratio);const rect=video.parentElement.getBoundingClientRect();pan=C.clampPreviewPan({x:base.pan.x+(a.x+b.x)/2-base.x,y:base.pan.y+(a.y+b.y)/2-base.y},{width:rect.width,height:rect.height},scale);transform();}
  }
  if(directAllowed||zoom||scale>1){e.stopImmediatePropagation();e.preventDefault();if(!zoom&&name!=='pointercancel')direct.frame(mapped());}
  if(name==='pointerup'||name==='pointercancel'){points.delete(e.pointerId);if(name==='pointercancel')direct.cancel();else if(directAllowed&&!zoom)direct.frame(mapped());if(!points.size){base=null;zoom=false;}}
 },{capture:true,passive:false});
 async function updateAwake(){const gen=++wakeGeneration;if(document.hidden||!N.isConnected()){await wake?.release();wake=null;return;}if(!wake&&navigator.wakeLock)try{const lease=await navigator.wakeLock.request('screen');if(gen!==wakeGeneration)await lease.release();else{wake=lease;lease.addEventListener('release',()=>{if(wake===lease)wake=null;});}}catch{}}
 function cancelInteraction(){cancelKey();resetPointer();transfer?.abort();}
 window.addEventListener('blur',cancelKey);window.addEventListener('pagehide',cancelInteraction);window.addEventListener('orientationchange',cancelInteraction);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelInteraction();void updateAwake();});
 let lastEpoch=null,lastInput=false,lastFiles=false;
 window.addEventListener('phonepad-capabilities',()=>{const epoch=N.capabilities?.sessionEpoch,input=C.allowsInput(N.capabilities),allowFiles=C.allowsPermission(N.capabilities,'files');if(epoch!==lastEpoch||input!==lastInput||allowFiles!==lastFiles)cancelInteraction();lastEpoch=epoch;lastInput=input;lastFiles=allowFiles;setTimeout(()=>{state();void updateAwake();},0);});
 window.addEventListener('beforeunload',e=>{if(draft.value||literal.pending){e.preventDefault();e.returnValue='';}});
 window.PhonepadControlGain=()=>gain;
 window.PhonepadHasPendingWork=()=>!!draft.value||!!literal.pending||literal.busy||busy||files.length>0;
 state();review();
})();
