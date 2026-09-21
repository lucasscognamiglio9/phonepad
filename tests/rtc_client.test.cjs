const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(rejectStart = false) {
  const calls = [], peers = [];
  class Peer extends EventTarget {
    constructor() { super(); this.iceGatheringState='complete'; this.connectionState='connected'; peers.push(this); }
    async setRemoteDescription() { this.ontrack({track:{}}); }
    async createAnswer() { return {type:'answer',sdp:'answer'}; }
    async setLocalDescription(description) { this.localDescription=description; }
    async getStats() { return new Map(); }
    close() { this.closed=true; }
  }
  class Video extends EventTarget {
    set srcObject(value) { this.stream=value; if(value) queueMicrotask(()=>this.dispatchEvent(new Event('loadeddata'))); }
    play() { return Promise.resolve(); }
  }
  const context = {window:{},CustomEvent:class extends Event {constructor(type,options){super(type);this.detail=options.detail;}},RTCPeerConnection:Peer,MediaStream:class{},DOMException,
    setTimeout,clearTimeout,fetch:async (_,options)=>{
      const body=JSON.parse(options.body); calls.push(body);
      return {ok:!(rejectStart && body.op==='start'),json:async()=>({id:'session',type:'offer',sdp:'offer'})};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../daemon/web/phonepad-core.js'),'utf8'),context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../daemon/web/rtc.js'),'utf8'),context);
  return {open:context.window.PhonepadRTC,video:new Video(),peers,calls};
}

test('signalling failure closes peer so HTTP fallback can start',async()=>{
  const h=harness(true);
  await assert.rejects(h.open(h.video,new AbortController().signal,800),/rtc-signalling/);
  assert.equal(h.peers[0].closed,true);
});

test('closing preview stops peer, media and native session',async()=>{
  const h=harness(),controller=new AbortController();
  const session=await h.open(h.video,controller.signal,800);
  controller.abort();
  await assert.rejects(session.ended,{name:'AbortError'});
  assert.equal(h.peers[0].closed,true);
  assert.equal(h.video.stream,null);
  assert.equal(h.calls.filter(c=>c.op==='stop').length,1);
  assert.equal(h.calls.find(c=>c.op==='start').width,800);
});

test('already aborted preview never starts native capture',async()=>{
  const h=harness(),controller=new AbortController();controller.abort();
  await assert.rejects(h.open(h.video,controller.signal,800),{name:'AbortError'});
  assert.equal(h.calls.length,0);
  assert.equal(h.peers[0].closed,true);
});
