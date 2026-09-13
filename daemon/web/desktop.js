/* Native WebRTC, LAN only: no STUN/TURN, accounts, recording or paid relay. */
"use strict";
(() => {
  const publisher = !!document.getElementById("share-start");
  const status = document.getElementById(publisher ? "share-status" : "video-status");
  const video = document.getElementById(publisher ? "preview" : "remote-video");
  let socket, pc, stream, timer, candidates = [], generation = 0, frames = -1, lastFrame = 0;
  const profiles = {
    fast: {width:1920,height:1080,fps:60,bitrate:12000000},
    light: {width:1280,height:720,fps:60,bitrate:6000000},
    eco: {width:1280,height:720,fps:30,bitrate:3000000},
  };
  let profile = profiles.fast;
  let previousStats = new Map();
  window.PhonepadVideoDiagnostics = {state:"idle"};
  let chain = Promise.resolve();
  async function sampleStats(current) {
    const stats = await current.getStats();
    if (current !== pc) return;
    const result = {role:publisher ? "sender" : "receiver",timestamp:new Date().toISOString(),target:publisher ? profile : null};
    if (stream) {
      const settings = stream.getVideoTracks()[0]?.getSettings();
      result.capture = settings ? {width:settings.width,height:settings.height,fps:settings.frameRate} : null;
    }
    stats.forEach(r => {
      if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) result.networkRTTms = r.currentRoundTripTime == null ? null : Math.round(r.currentRoundTripTime*1000);
      if ((r.type !== "outbound-rtp" && r.type !== "inbound-rtp") || (r.kind || r.mediaType) !== "video") return;
      const prev = previousStats.get(r.id);
      const count = publisher ? r.framesEncoded : r.framesDecoded;
      const oldCount = prev ? (publisher ? prev.framesEncoded : prev.framesDecoded) : 0;
      const total = publisher ? r.totalEncodeTime : r.totalDecodeTime;
      const oldTotal = prev ? (publisher ? prev.totalEncodeTime : prev.totalDecodeTime) : 0;
      const processingMs = count > oldCount && total != null ? +(1000*(total-(oldTotal || 0))/(count-oldCount)).toFixed(2) : null;
      const bytes = publisher ? r.bytesSent : r.bytesReceived;
      const oldBytes = prev ? (publisher ? prev.bytesSent : prev.bytesReceived) : 0;
      result.video = {
        width:r.frameWidth,height:r.frameHeight,fps:r.framesPerSecond,
        codec:stats.get(r.codecId)?.mimeType,processingMs,
        bitrateMbps:prev && r.timestamp > prev.timestamp ? +((bytes-oldBytes)*8/(r.timestamp-prev.timestamp)/1000).toFixed(2) : null,
        limitation:r.qualityLimitationReason || null,
        encoder:r.encoderImplementation || null, decoder:r.decoderImplementation || null,
        framesDropped:r.framesDropped ?? null, packetsLost:r.packetsLost ?? null,
        jitterBufferMs:r.jitterBufferEmittedCount > (prev?.jitterBufferEmittedCount || 0) ? +(1000*(r.jitterBufferDelay-(prev?.jitterBufferDelay || 0))/(r.jitterBufferEmittedCount-(prev?.jitterBufferEmittedCount || 0))).toFixed(2) : null,
      };
      previousStats.set(r.id,r);
    });
    window.PhonepadVideoDiagnostics = result;
    const output = document.getElementById("video-diagnostics");
    if (output) output.textContent = JSON.stringify(result,null,2);
    return stats;
  }
  const say = text => { status.textContent = text; };
  const send = msg => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg)); };
  function closePeer() {
    generation++;
    clearInterval(timer);
    if (pc) pc.close();
    pc = null; candidates = []; frames = -1; previousStats.clear();
    window.PhonepadVideoDiagnostics = {state:"stopped"};
    if (!publisher) video.srcObject = null;
  }
  function stop() {
    send({type:"stop"});
    closePeer();
    if (socket) { const old = socket; socket = null; old.close(); }
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    say("Vista detenida");
    if (publisher) { document.getElementById("share-start").disabled = false; document.getElementById("share-stop").disabled = true; document.getElementById("video-profile").disabled = false; }
  }
  function peer() {
    pc = new RTCPeerConnection({iceServers: []});
    const current = pc;
    pc.onicecandidate = e => { if (pc === current && e.candidate) send({type:"candidate", candidate:e.candidate}); };
    pc.onconnectionstatechange = () => {
      if (pc !== current) return;
      if (pc.connectionState === "connected") say(publisher ? "Compartiendo con tu teléfono" : "En vivo");
      if (["failed", "disconnected"].includes(pc.connectionState)) {
        say("Video interrumpido · detené y volvé a iniciar la vista");
        if (!publisher) video.srcObject = null;
      }
    };
    pc.ontrack = e => {
      // A preference, not a promise: browsers retain congestion/jitter control.
      if (e.receiver && "jitterBufferTarget" in e.receiver) {
        try { e.receiver.jitterBufferTarget = 20; } catch {}
      }
      video.srcObject = new MediaStream([e.track]);
      video.play().catch(() => say("Tocá el video para reproducir"));
      lastFrame = performance.now();
      timer = setInterval(async () => {
        try {
          const stats = await sampleStats(current);
          if (!stats || pc !== current) return;
          stats.forEach(r => {
            if (r.type !== "inbound-rtp" || r.kind !== "video") return;
            if (r.framesDecoded !== frames) { frames = r.framesDecoded; lastFrame = performance.now(); }
            const age = performance.now() - lastFrame;
            say(age > 4000 ? "Sin nuevos fotogramas · pantalla quieta o video interrumpido" : `En vivo · ${Math.round(r.framesPerSecond || 0)} fps · ${r.frameWidth || "—"} × ${r.frameHeight || "—"}`);
            video.style.opacity = age > 4000 ? ".65" : "1";
          });
        } catch {}
      }, 1000);
    };
    return current;
  }
  async function offer() {
    if (!stream) return;
    closePeer();
    const current = peer(), gen = generation;
    for (const track of stream.getTracks()) {
      const sender = current.addTrack(track, stream);
      if (track.kind === "video") {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = profile.bitrate;
        params.encodings[0].maxFramerate = profile.fps;
        params.degradationPreference = "maintain-framerate";
        try { await sender.setParameters(params); } catch { /* Browser adaptation remains available. */ }
      }
    }
    const description = await current.createOffer();
    if (gen !== generation) return;
    await current.setLocalDescription(description);
    send({type:"offer", description:current.localDescription});
    timer = setInterval(() => sampleStats(current).catch(() => {}), 1000);
  }
  async function receive(msg) {
    if (msg.type === "ready") { if (publisher) await offer(); else send({type:"ready"}); }
    if (msg.type === "stop") { closePeer(); say(publisher ? "Esperando al teléfono · captura activa" : "La laptop dejó de compartir"); }
    if (msg.type === "offer" && !publisher) {
      closePeer();
      const current = peer(), gen = generation;
      await current.setRemoteDescription(msg.description);
      const answer = await current.createAnswer();
      if (gen !== generation) return;
      await current.setLocalDescription(answer);
      send({type:"answer", description:current.localDescription});
    }
    if (msg.type === "answer" && publisher && pc) {
      await pc.setRemoteDescription(msg.description);
      for (const candidate of candidates) await pc.addIceCandidate(candidate);
      candidates = [];
    }
    if (msg.type === "candidate" && pc) {
      if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
      else candidates.push(msg.candidate);
    }
  }
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const query = publisher ? "role=publisher" : "role=viewer";
    const current = new WebSocket(`${proto}//${location.host}/api/desktop?${query}`);
    socket = current;
    current.onopen = () => { if (socket === current) say(publisher ? "Captura activa · esperando al teléfono" : "En la laptop, abrí Compartir escritorio e iniciá la captura"); };
    current.onmessage = e => {
      chain = chain.then(async () => { if (socket === current) await receive(JSON.parse(e.data)); }).catch(() => { closePeer(); say("No se pudo negociar el video · reiniciá la vista"); });
    };
    current.onclose = () => { if (socket === current) { stop(); say("Vista desconectada · volvé a iniciarla"); } };
  }
  video.addEventListener("click", () => video.play().catch(() => {}));
  if (publisher) {
    document.getElementById("save-diagnostics").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(window.PhonepadVideoDiagnostics,null,2)],{type:"application/json"}));
      const a = document.createElement("a"); a.href=url; a.download="phonepad-video-diagnostic.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    });
    document.getElementById("share-start").addEventListener("click", async () => {
      if (!navigator.mediaDevices?.getDisplayMedia || !window.RTCPeerConnection) { say("Este navegador no permite capturar. Abrí esta página en Chrome o Firefox de la laptop, con HTTPS."); return; }
      document.getElementById("share-start").disabled = true;
      document.getElementById("video-profile").disabled = true;
      say("Elegí una pantalla en el selector del sistema…");
      try {
        // Must be called directly inside this click, before any network await.
        profile = profiles[document.getElementById("video-profile").value] || profiles.fast;
        stream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:profile.fps,max:profile.fps},width:{ideal:profile.width,max:profile.width},height:{ideal:profile.height,max:profile.height}},audio:false});
        stream.getVideoTracks()[0].contentHint = "detail";
        stream.getVideoTracks()[0].onended = stop;
        video.srcObject = stream;
        document.getElementById("share-stop").disabled = false;
        connect();
      } catch (e) { stop(); say(e.name === "NotAllowedError" ? "Captura cancelada o sin permiso. Podés volver a intentarlo." : `No se pudo capturar: ${e.name}`); }
    });
    document.getElementById("share-stop").addEventListener("click", stop);
  } else {
    let showing = false;
    const toggle = document.getElementById("view-toggle"), desktop = document.getElementById("desktop");
    toggle.addEventListener("click", () => {
      showing = !showing; desktop.hidden = !showing;
      toggle.textContent = showing ? "Ocultar escritorio" : "Ver escritorio";
      Pad.reset();
      if (!showing) stop();
      else if (!window.RTCPeerConnection) say("Tu navegador no admite video WebRTC");
      else if (!Net.isConnected()) say("Conectá el control antes de iniciar la vista");
      else connect();
    });
    document.getElementById("video-fit").addEventListener("click", e => {
      const zoom = document.getElementById("video-frame").classList.toggle("zoomed");
      e.target.textContent = zoom ? "Ajustar" : "Ampliar";
    });
    window.addEventListener("phonepad-disconnected", () => { stop(); showing=false; desktop.hidden=true; toggle.textContent="Ver escritorio"; });
    fetch("/api/mode", {cache:"no-store"}).then(r=>r.json()).then(m=>{ if(m.demo) document.getElementById("mode-label").textContent="DEMO · sin control físico"; }).catch(()=>{});
  }
  window.addEventListener("pagehide", stop);
})();
