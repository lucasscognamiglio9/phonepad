"use strict";
(() => {
 const toggle=document.getElementById('show-desktop'),panel=document.getElementById('desktop'),video=document.getElementById('desktop-preview'),status=document.getElementById('preview-status');
 let showing=false,expanded=false,epoch=0,timer,resizeTimer,controller,objectURL,source,frames=0,lastFrameTime=0,requestedWidth=0;
 const expand=document.getElementById('expand-preview');
 // Preserve desktop text at source resolution, independent of the CSS thumbnail.
 const desiredWidth=()=>1920;
 function fitStream(){
  clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{
   if(!showing||document.hidden||!requestedWidth)return;
   const next=desiredWidth();
   if(next/requestedWidth>1.25||next/requestedWidth<.75){clear();say('Ajustando la pantalla…');stream(epoch);}
  },250);
 }
 function setExpanded(next){
  expanded=next;document.body.classList.toggle('preview-expanded',expanded);
  expand.setAttribute('aria-pressed',String(expanded));
  expand.setAttribute('aria-label',expanded?'Reducir pantalla':'Ampliar pantalla');
  Pad.reset();fitStream();
 }
 const messages={'idle':'Preparando tu pantalla…','selecting-screen':'Elegí la pantalla en la laptop para autorizar la captura.','permission-required':'La captura no fue autorizada en la laptop.','unavailable':'El servicio de pantalla no está disponible.','capture-error':'No se pudo iniciar la captura de pantalla.'};
 const say=text=>{status.textContent=text;status.hidden=false;};
 function clear(){epoch++;clearTimeout(timer);clearTimeout(resizeTimer);controller?.abort();video.pause();video.srcObject=null;video.removeAttribute('src');video.load();if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;source=null;video.hidden=true;window.PhonepadVideoDiagnostics={state:'stopped'};}
 function until(target,event,signal){return new Promise((resolve,reject)=>{
  const done=()=>{cleanup();resolve();},bad=()=>{cleanup();reject(new Error('media-error'));},abort=()=>{cleanup();reject(new DOMException('Stopped','AbortError'));};
  const cleanup=()=>{target.removeEventListener(event,done);target.removeEventListener('error',bad);signal.removeEventListener('abort',abort);};
  if(signal.aborted){abort();return;}target.addEventListener(event,done,{once:true});target.addEventListener('error',bad,{once:true});signal.addEventListener('abort',abort,{once:true});
 });}
 async function stream(attempt){
  if(!showing||document.hidden||attempt!==epoch)return;
  controller=new AbortController();const signal=controller.signal;
  try{
   const r=await fetch('/api/preview/status',{cache:'no-store',signal});const info=await r.json();
   if(attempt!==epoch)return;
   if(!['ready','live'].includes(info.state)){say(messages[info.state]||'Conectando la pantalla…');timer=setTimeout(()=>stream(attempt),1000);return;}
   if(info.webrtc && window.RTCPeerConnection && window.PhonepadRTC){
    try{
     const target=desiredWidth();requestedWidth=target;
     const codecs=window.RTCRtpReceiver?.getCapabilities?.('video')?.codecs||[];
     const hevc=codecs.some(c=>c.mimeType?.toLowerCase()==='video/h265');
     let rtc;
     if(hevc){
      try{rtc=await PhonepadRTC(video,signal,target,'H265');}
      catch(error){if(signal.aborted)throw error;}
     }
     if(!rtc)rtc=await PhonepadRTC(video,signal,target,'H264');
     status.hidden=true;
     await rtc.ended;
     return;
    }catch(error){if(signal.aborted)throw error;video.srcObject=null;say('Ajustando la conexión…');}
   }
   const MS=window.ManagedMediaSource||window.MediaSource,mime='video/mp4; codecs="avc1.42E02A"';
   if(!MS||!MS.isTypeSupported(mime)){say('Este navegador no admite la preview H.264.');return;}
   source=new MS();const opened=until(source,'sourceopen',signal);objectURL=URL.createObjectURL(source);video.src=objectURL;video.muted=true;video.disableRemotePlayback=true;video.hidden=false;video.play().catch(()=>{});await opened;
   const buffer=source.addSourceBuffer(mime);
   const response=await fetch('/api/preview/video',{cache:'no-store',signal});if(!response.ok)throw Error('capture');
   const reader=response.body.getReader();let bytes=0,start=performance.now();
   while(!signal.aborted&&attempt===epoch){
    const {done,value}=await reader.read();if(done)throw Error('ended');
    if(buffer.buffered.length && video.currentTime>3){const end=video.currentTime-2;if(buffer.buffered.start(0)<end){const removed=until(buffer,'updateend',signal);buffer.remove(0,end);await removed;}}
    const updated=until(buffer,'updateend',signal);buffer.appendBuffer(value);await updated;bytes+=value.byteLength;
    if(buffer.buffered.length){const edge=buffer.buffered.end(buffer.buffered.length-1),behind=edge-video.currentTime;if(behind>.35)video.currentTime=Math.max(buffer.buffered.start(0),edge-.12);video.play().catch(()=>{});}
    window.PhonepadVideoDiagnostics={state:'streaming',codec:'H.264 / VA-API',width:video.videoWidth,height:video.videoHeight,averageMbps:bytes*8/(performance.now()-start)/1000,bufferSeconds:buffer.buffered.length?buffer.buffered.end(buffer.buffered.length-1)-video.currentTime:0,frames};
   }
  }catch(e){if(e.name!=='AbortError'&&showing&&attempt===epoch){controller.abort();video.removeAttribute('src');video.load();if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;say('Reconectando la pantalla…');timer=setTimeout(()=>stream(attempt),1500);}}
 }
 video.addEventListener('playing',()=>{status.hidden=true;});
 if(video.requestVideoFrameCallback){const tick=(now)=>{frames++;lastFrameTime=now;video.requestVideoFrameCallback(tick);};video.requestVideoFrameCallback(tick);}
 toggle.addEventListener('click',()=>{showing=!showing;clear();if(!showing)setExpanded(false);panel.hidden=!showing;toggle.setAttribute('aria-pressed',String(showing));document.body.classList.toggle('preview-open',showing);Pad.reset();if(showing){Sheet.close();setExpanded(true);say('Conectando con tu pantalla…');stream(epoch);}});
 document.addEventListener('visibilitychange',()=>{clear();if(showing&&!document.hidden)stream(epoch);});
 window.addEventListener('phonepad-recover',()=>{clear();if(showing&&!document.hidden){say('Reconectando la pantalla…');stream(epoch);}});
 expand.addEventListener('click',()=>setExpanded(!expanded));
 window.addEventListener('resize',fitStream);
 window.visualViewport?.addEventListener('resize',fitStream);
 window.addEventListener('pagehide',clear);
})();
