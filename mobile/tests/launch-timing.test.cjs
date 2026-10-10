const test=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('./control-fixture.cjs');
const {LaunchTiming}=load('lib/launch-timing.ts');
function harness(){
 let now=0,exits=0,next=0;const pending=new Map(),callbacks=[];
 const clock={now:()=>now,wait:(fn,ms)=>{const id=next++;pending.set(id,{fn,at:now+ms});callbacks.push(fn);return id;},cancel:id=>pending.delete(id)};
 const timing=new LaunchTiming(1000,()=>exits++,clock);
 const advance=ms=>{now+=ms;for(const[id,p]of [...pending])if(p.at<=now){pending.delete(id);p.fn();}};
 return{timing,advance,pending,callbacks,exits:()=>exits};
}
test('a fast ready result holds the decoded mark for one visible second',()=>{
 const h=harness();h.timing.markReady();h.advance(900);assert.equal(h.exits(),0);h.timing.show();h.advance(999);assert.equal(h.exits(),0);h.advance(1);assert.equal(h.exits(),1);
});
test('a slow start reveals immediately after readiness once the visible hold has already elapsed',()=>{
 const h=harness();h.timing.show();h.advance(2000);assert.equal(h.exits(),0);h.timing.markReady();assert.equal(h.exits(),1);assert.equal(h.pending.size,0);
});
test('repeat layout and ready callbacks cannot restart the hold or create duplicate exits',()=>{
 const h=harness();h.timing.show();h.timing.markReady();h.advance(700);h.timing.show();h.timing.markReady();assert.equal(h.pending.size,1);h.advance(300);h.timing.markReady();assert.equal(h.exits(),1);
});
test('time in an inactive permission dialog does not count as foreground presentation',()=>{
 const h=harness();h.timing.show();h.timing.markReady();h.advance(400);h.timing.setActive(false);assert.equal(h.pending.size,0);h.advance(5000);h.timing.setActive(true);h.advance(599);assert.equal(h.exits(),0);h.advance(1);assert.equal(h.exits(),1);
});
test('disposal cancels the hold and ignores a timer callback already queued before unmount',()=>{
 const h=harness();h.timing.show();h.timing.markReady();h.timing.dispose();assert.equal(h.pending.size,0);h.advance(1000);h.callbacks[0]();h.timing.markReady();h.timing.setActive(true);assert.equal(h.exits(),0);
});
test('a logo decoded while inactive waits for actual foreground visibility',()=>{
 const h=harness();h.timing.setActive(false);h.timing.show();h.timing.markReady();h.advance(10000);assert.equal(h.pending.size,0);h.timing.setActive(true);h.advance(1000);assert.equal(h.exits(),1);
});

 test('a canceled inactive timer cannot replace the new foreground timer',()=>{
 const h=harness();h.timing.show();h.timing.markReady();h.advance(200);const old=h.callbacks[0];h.timing.setActive(false);h.advance(3000);h.timing.setActive(true);old();assert.equal(h.pending.size,1);h.advance(799);assert.equal(h.exits(),0);h.advance(1);assert.equal(h.exits(),1);
 });
