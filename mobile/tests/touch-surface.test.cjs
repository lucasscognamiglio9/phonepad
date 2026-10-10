const test = require('node:test');
const cursorModule = {};
require('node:vm').runInNewContext(require('typescript').transpileModule(require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/lib/cursor.ts'),'utf8'),{compilerOptions:{module:1,target:9}}).outputText,{exports:cursorModule});
const directPointer = {};
require('node:vm').runInNewContext(require('typescript').transpileModule(require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/lib/direct-pointer.ts'),'utf8'),{compilerOptions:{module:1,target:9}}).outputText,{exports:directPointer,setTimeout,clearTimeout});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

let pointerGeometryModule;
let previewZoomModule;

function loadTouchSurface() {
  const geometry = {};
  pointerGeometryModule = geometry;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/lib/pointer-geometry.ts'), 'utf8',
  ), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: geometry, Number, Math });
  const zoom = {};
  previewZoomModule = zoom;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/lib/preview-zoom.ts'), 'utf8',
  ), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: zoom, Number, Math });
  const source = ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/components/touch-surface.tsx'), 'utf8',
  ), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: name => name === '../lib/pointer-geometry' ? geometry : name === '../lib/preview-zoom' ? zoom : undefined,
    Number,
    Math,
  });
  return exports;
}

const {
  mapTouchToContact,
  mapTouchSnapshot,
  mapTouchReleaseSnapshot,
  removeChangedTouchContacts,
  SQUARE_POINTER_GEOMETRY,
} = loadTouchSurface();

function point(id, x, y) {
  return { id, x, y, absoluteX: x, absoluteY: y };
}

function render({ dismissKeyboard, touchResult, defer = false, animate = false } = {}) {
  let now = 0, timerSequence = 0, recoveries=0;
  const timers=new Map();
  const setTimer=(fn,delay)=>{const id=++timerSequence;timers.set(id,{fn,at:now+delay});return id;};
  const clearTimer=id=>timers.delete(id);
  const slots = [];
  const pendingEffects = [];
  const cleanups = [];
  const gestures = [];
  const appStateListeners = [];
  const calls = [], directCommands = [];
  const cancelCalls = [];
  const fences = [];
  const queue = [];
  let hookIndex = 0;
  let tree;
  let props = { connection: null, children: 'video', preview: false, dismissKeyboard };
  let dimensions = { width: 100, height: 70 };
  let epoch = 1;

  const sameDeps = (left, right) => left && right && left.length === right.length
    && left.every((value, index) => value === right[index]);
  const useRef = initial => {
    const at = hookIndex++;
    return slots[at] ??= { current: initial };
  };
  let dirty = false;
  const useState = initial => {
    const at = hookIndex++;
    const slot = slots[at] ??= { value: initial };
    return [slot.value, next => { if (slot.value !== next) { slot.value = next; dirty = true; } }];
  };
  const useSharedValue = initial => {
    const at = hookIndex++;
    return slots[at] ??= animate ? {
      current:initial, tween:null,
      get value(){ const t=this.tween;return t ? t.from+(t.to-t.from)*Math.min(1,(now-t.at)/t.duration) : this.current; },
      set value(next){ if(next?.__tween){this.tween={from:this.value,to:next.to,at:now,duration:next.duration};}else{this.tween=null;this.current=next;} },
    } : { value: initial };
  };
  const useEffect = (fn, deps) => {
    const at = hookIndex++;
    const old = slots[at];
    if (!old || !sameDeps(old.deps, deps)) {
      old?.cleanup?.();
      slots[at] = { deps, cleanup: null };
      pendingEffects.push({ at, fn });
    }
  };
  const useMemo = (fn, deps) => {
    const at = hookIndex++;
    const old = slots[at];
    if (!old || !sameDeps(old.deps, deps)) slots[at] = { deps, value: fn() };
    return slots[at].value;
  };
  const gesture = kind => {
    const handlers = {};
    const value = new Proxy({ kind, handlers }, {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => {
          if (String(key).startsWith('on')) handlers[key] = args[0];
          return value;
        };
      },
    });
    gestures.push(value);
    return value;
  };
  const jsx = (type, nodeProps) => ({ type, props: nodeProps });
  const connection = {
    recoverPointer:()=>{recoveries++;},
    requestPointerFence: callback=>{fences.push(callback);return fences.length;},
    send: command => { directCommands.push(command); return true; },
    get inputEpoch() { return epoch; },
    touch: (inputEpoch, contacts) => {
      const copy = contacts.map(contact => ({ ...contact }));
      calls.push({ epoch: inputEpoch, contacts: copy });
      return touchResult ? touchResult(inputEpoch, copy) : true;
    },
    cancelTouch: inputEpoch => {
      cancelCalls.push({ epoch: inputEpoch });
      return true;
    },
  };
  props.connection = connection;
  const modules = {
    react: { useEffect, useMemo, useRef, useState },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {
      AppState: {
        addEventListener: (_, listener) => {
          appStateListeners.push(listener);
          return { remove: () => { const at = appStateListeners.indexOf(listener); if (at >= 0) appStateListeners.splice(at, 1); } };
        },
      },
      View: 'View', Image: 'Image',
    },
    'react-native-gesture-handler': {
      GestureDetector: 'GestureDetector',
      Gesture: {
        Manual: () => gesture('Manual'), Pinch: () => gesture('Pinch'), Pan: () => gesture('Pan'),
        Simultaneous: (...items) => ({ kind: 'Simultaneous', items }),
      },
    },
    'react-native-reanimated': { __esModule:true, default: { View: 'AnimatedView' }, useSharedValue, useDerivedValue: fn => {const ref=useRef(null); ref.current ??= {get value(){return this.fn();}}; ref.current.fn=fn; return ref.current;}, useAnimatedStyle: fn => fn(), withTiming:(value,config)=>animate ? {__tween:true,to:value,duration:config.duration}:value, cancelAnimation:shared=>{if(animate)shared.value=shared.value;}, Easing:{linear:value=>value} },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => defer ? queue.push([fn, args]) : fn(...args) },
    './glass-reflection': require('./control-fixture.cjs').load('components/glass-reflection.ts', {'./appearance':require('./appearance-fixture.cjs')}),
    '../lib/cursor': cursorModule, '../lib/direct-pointer': directPointer, '../lib/connection': {},
    '../lib/protocol': {}, '../lib/pointer-geometry': pointerGeometryModule, '../lib/preview-zoom': previewZoomModule,
  };
  const componentExports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/components/touch-surface.tsx'), 'utf8',
  ), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText, { exports: componentExports, require: name => modules[name], Date:class extends Date { static now(){return now;} }, performance:{now:()=>now}, setTimeout:setTimer, clearTimeout:clearTimer });

  const runEffects = () => {
    while (pendingEffects.length) {
      const effect = pendingEffects.shift();
      slots[effect.at].cleanup = effect.fn();
    }
  };
  const renderAgain = () => {
    do {
      dirty = false;
      hookIndex = 0;
      tree = componentExports.TouchSurface(props);
      runEffects();
    } while (dirty);
  };
  const nodes = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  };
  const root = () => nodes(tree).find(node => node.type === 'View' && node.props?.onLayout);
  const manual = () => gestures.findLast(value => value.kind === 'Manual');
  const layout = (width, height) => root().props.onLayout({ nativeEvent: { layout: { width, height } } });
  renderAgain();
  return {
    calls, fences, connection,
    tick:ms=>{now+=ms;for(const [id,timer] of [...timers]) if(timer.at<=now){timers.delete(id);timer.fn();}renderAgain();},
    get recoveries(){return recoveries;},
    nodes: () => nodes(tree),
    directCommands,
    cancelCalls,
    gestures,
    manual,
    layout,
    appState: state => appStateListeners.slice().forEach(listener => listener(state)),
    drain: () => { while (queue.length) { const [fn, args] = queue.shift(); fn(...args); } },
    runQueued: index => { const [fn, args] = queue.splice(index, 1)[0]; fn(...args); },
    rerender: next => { props = { ...props, ...next }; renderAgain(); },
    resize: next => { dimensions = { ...dimensions, ...next }; renderAgain(); },
    setEpoch: next => { epoch = next; },
    unmount: () => slots.forEach(slot => slot?.cleanup?.()),
    get dimensions() { return dimensions; },
  };
}

test('maps a centered physical 100x70 surface without stretching either axis', () => {
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(mapTouchToContact(point(4, 100, 100), { width: 200, height: 200 })), { id: 4, x: .5, y: .5 });
  const portraitTop = mapTouchToContact(point(4, 0, 0), { width: 200, height: 200 });
  const portraitBottom = mapTouchToContact(point(4, 200, 200), { width: 200, height: 200 });
  assert.ok(portraitBottom.y > portraitTop.y, 'the whole portrait height remains sensitive');
  assert.ok(portraitTop.x > 0 && portraitBottom.x < 1, 'letterboxing is centered in the physical pad');
  assert.deepEqual(plain(mapTouchToContact(point(4, 150, 50), { width: 300, height: 100 })), { id: 4, x: .5, y: .5 });
  assert.deepEqual(plain(mapTouchToContact(point(4, -100, 240), { width: 200, height: 200 })), { id: 4, x: 0, y: 1 });
  assert.deepEqual(plain(mapTouchToContact({ id: 4, x: Number.NaN, y: Number.POSITIVE_INFINITY }, { width: 200, height: 200 })), { id: 4, x: .15, y: 0 });
});

test('square candidate keeps screen axes, subpixel gain and orientation on one frame', () => {
  const portrait = mapTouchToContact(point(4, 0, 0), { width: 390, height: 844 }, SQUARE_POINTER_GEOMETRY);
  const portraitX100 = mapTouchToContact(point(4, 100, 0), { width: 390, height: 844 }, SQUARE_POINTER_GEOMETRY);
  const portraitY100 = mapTouchToContact(point(4, 0, 100), { width: 390, height: 844 }, SQUARE_POINTER_GEOMETRY);
  const landscape = mapTouchToContact(point(4, 0, 0), { width: 844, height: 390 }, SQUARE_POINTER_GEOMETRY);
  const landscapeX100 = mapTouchToContact(point(4, 100, 0), { width: 844, height: 390 }, SQUARE_POINTER_GEOMETRY);
  const landscapeY100 = mapTouchToContact(point(4, 0, 100), { width: 844, height: 390 }, SQUARE_POINTER_GEOMETRY);
  const gain = SQUARE_POINTER_GEOMETRY.gainMmPerPoint * 100 / SQUARE_POINTER_GEOMETRY.sideMm;
  assert.ok(portrait.x > 0 && portrait.y === 0, 'portrait margins stay explicit on the short X axis');
  assert.ok(landscape.x === 0 && landscape.y > 0, 'landscape keeps the short-axis margin on Y');
  assert.ok(Math.abs((portraitX100.x - portrait.x) - gain) < 1e-12);
  assert.ok(Math.abs((portraitY100.y - portrait.y) - gain) < 1e-12);
  assert.ok(Math.abs((landscapeX100.x - landscape.x) - gain) < 1e-12);
  assert.ok(Math.abs((landscapeY100.y - landscape.y) - gain) < 1e-12);
  assert.ok(portraitX100.x > portrait.x && portraitY100.y > portrait.y);
  assert.ok(landscapeX100.x > landscape.x && landscapeY100.y > landscape.y);
});

test('forwards only raw touch snapshots from a Manual gesture', () => {
  const h = render();
  assert.deepEqual(h.manual().kind, 'Manual');
  h.layout(100, 70);
  const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(7, 10, 20)], changedTouches: [point(7, 10, 20)] });
  g.onTouchesMove({ allTouches: [point(7, 20, 24)], changedTouches: [point(7, 20, 24)] });
  g.onTouchesUp({ allTouches: [], changedTouches: [point(7, 20, 24)] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.map(call => call.contacts))), [
    [{ id: 7, x: .1, y: 20 / 70 }],
    [{ id: 7, x: .2, y: 24 / 70 }],
    [],
  ]);
  assert.ok(h.calls.every(call => call.contacts.every(contact => contact.id === 7)));
});

test('keeps stable ids and filters every changed id from an up snapshot', () => {
  const h = render(); h.layout(100, 70); const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(9, 90, 20), point(2, 20, 30)], changedTouches: [point(9, 90, 20), point(2, 20, 30)] });
  g.onTouchesMove({ allTouches: [point(9, 80, 20), point(2, 30, 30)], changedTouches: [point(2, 30, 30)] });
  g.onTouchesUp({ allTouches: [point(9, 80, 20), point(2, 30, 30)], changedTouches: [point(2, 30, 30)] });
  g.onTouchesUp({ allTouches: [point(9, 80, 20)], changedTouches: [point(9, 80, 20)] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.map(call => call.contacts))), [
    [{ id: 2, x: .2, y: 30 / 70 }, { id: 9, x: .9, y: 20 / 70 }],
    [{ id: 2, x: .3, y: 30 / 70 }, { id: 9, x: .8, y: 20 / 70 }],
    [{ id: 9, x: .8, y: 20 / 70 }],
    [],
  ]);
});

test('a tap and drag stay raw: no synthesized button, cursor, scroll, or gesture commands', () => {
  const h = render(); h.layout(100, 70); const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(1, 20, 20)], changedTouches: [point(1, 20, 20)] });
  g.onTouchesUp({ allTouches: [], changedTouches: [point(1, 20, 20)] });
  g.onTouchesDown({ allTouches: [point(2, 20, 20)], changedTouches: [point(2, 20, 20)] });
  g.onTouchesMove({ allTouches: [point(2, 80, 50)], changedTouches: [point(2, 80, 50)] });
  g.onTouchesUp({ allTouches: [], changedTouches: [point(2, 80, 50)] });
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every(call => call.contacts.length === 0 || call.contacts[0].id === 1 || call.contacts[0].id === 2));
  assert.equal(h.calls.filter(call => call.contacts.length === 0).length, 2, 'each physical sequence releases exactly once');
});

test('a failed sequence is blocked until release, then a new sequence captures the new epoch', () => {
  let first = true;
  const h = render({ touchResult: (_, contacts) => contacts.length === 0 || !first ? true : (first = false, false) });
  h.layout(100, 70); const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(1, 10, 10)], changedTouches: [point(1, 10, 10)] });
  g.onTouchesMove({ allTouches: [point(1, 20, 20)], changedTouches: [point(1, 20, 20)] });
  const beforeRelease = h.calls.length;
  g.onTouchesUp({ allTouches: [], changedTouches: [point(1, 20, 20)] });
  assert.equal(h.calls.length, beforeRelease + 1);
  h.setEpoch(2);
  g.onTouchesDown({ allTouches: [point(3, 30, 30)], changedTouches: [point(3, 30, 30)] });
  assert.equal(h.calls.at(-1).epoch, 2);
});

test('a queued release from an older sequence cannot clear a newly captured epoch', () => {
  const h = render({ defer: true });
  h.layout(100, 70);
  const g = h.manual().handlers;

  g.onTouchesDown({ allTouches: [point(1, 10, 10)], changedTouches: [point(1, 10, 10)] });
  h.drain();
  g.onTouchesUp({ allTouches: [], changedTouches: [point(1, 10, 10)] });
  h.setEpoch(2);
  g.onTouchesDown({ allTouches: [point(2, 20, 20)], changedTouches: [point(2, 20, 20)] });

  // The new down can reach JS before the older queued release. It must cancel
  // the old epoch and capture the new one, while the stale release is ignored.
  h.runQueued(1);
  assert.equal(h.cancelCalls.at(-1).epoch, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), {
    epoch: 2,
    contacts: [{ id: 2, x: .2, y: 20 / 70 }],
  });
  h.drain();
  assert.equal(h.calls.length, 2);
});

test('a late native up for an old id cannot release a newer contact sequence', () => {
  const h = render();
  h.layout(100, 70);
  const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(1, 10, 10)], changedTouches: [point(1, 10, 10)] });
  g.onTouchesCancelled({});
  h.setEpoch(2);
  g.onTouchesDown({ allTouches: [point(2, 80, 50)], changedTouches: [point(2, 80, 50)] });
  const beforeLateUp = h.calls.length;

  // This callback belongs to the cancelled id=1 sequence, but the shared
  // generation now belongs to id=2. It must be ignored by id overlap.
  g.onTouchesUp({ allTouches: [], changedTouches: [point(1, 10, 10)] });
  assert.equal(h.calls.length, beforeLateUp);
  assert.equal(h.cancelCalls.length, 1);
  assert.equal(h.cancelCalls[0].epoch, 1);
  assert.equal(h.calls.at(-1).epoch, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).contacts)), [{ id: 2, x: .8, y: 50 / 70 }]);
});

test('cancellation, background, layout, and unmount all release active contacts', () => {
  const h = render(); h.layout(100, 70); const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(1, 10, 10)], changedTouches: [point(1, 10, 10)] });
  g.onTouchesCancelled({});
  assert.equal(h.cancelCalls.at(-1).epoch, 1);

  g.onTouchesDown({ allTouches: [point(2, 10, 10)], changedTouches: [point(2, 10, 10)] });
  h.appState('background');
  assert.equal(h.cancelCalls.at(-1).epoch, 1);

  g.onTouchesDown({ allTouches: [point(3, 10, 10)], changedTouches: [point(3, 10, 10)] });
  h.layout(120, 70);
  assert.equal(h.cancelCalls.at(-1).epoch, 1);

  g.onTouchesDown({ allTouches: [point(4, 10, 10)], changedTouches: [point(4, 10, 10)] });
  h.unmount();
  assert.equal(h.cancelCalls.at(-1).epoch, 1);
});

test('an applied geometry epoch interrupts the old touch sequence before new contacts', () => {
  const h = render(); h.layout(100, 70); const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(1, 10, 10)], changedTouches: [point(1, 10, 10)] });
  h.rerender({ pointerGeometry: SQUARE_POINTER_GEOMETRY, pointerGeometryEpoch: 7 });
  assert.equal(h.cancelCalls.at(-1).epoch, 1);
  g.onTouchesDown({ allTouches: [point(2, 10, 10)], changedTouches: [point(2, 10, 10)] });
  assert.equal(h.calls.at(-1).epoch, 1);
  assert.equal(h.calls.at(-1).contacts[0].id, 2);
});

test('keyboard mode consumes the touch to dismiss input without touching the remote computer', () => {
  let dismissed = 0;
  const h = render({ dismissKeyboard: () => { dismissed += 1; } }); h.layout(100, 70);
  const g = h.manual().handlers;
  g.onTouchesDown({ allTouches: [point(1, 10, 10)], changedTouches: [point(1, 10, 10)] });
  g.onTouchesMove({ allTouches: [point(1, 40, 40)], changedTouches: [point(1, 40, 40)] });
  g.onTouchesUp({ allTouches: [], changedTouches: [point(1, 40, 40)] });
  assert.equal(dismissed, 1);
  assert.deepEqual(h.calls, []);
});

test('preview composes local pinch and two-finger pan without replacing the manual input gesture', () => {
  const h = render();
  h.rerender({ preview: true });
  assert.ok(h.gestures.some(value => value.kind === 'Manual'));
  assert.ok(h.gestures.some(value => value.kind === 'Pinch'));
  assert.ok(h.gestures.some(value => value.kind === 'Pan'));
});

test('release snapshots explicitly emit the empty frame when all changed contacts lift', () => {
  const all = [point(1, 10, 10), point(2, 20, 20)];
  assert.deepEqual(mapTouchReleaseSnapshot(all, [all[1]], { width: 100, height: 70 }).map(touch => touch.id), [1]);
  assert.deepEqual(JSON.parse(JSON.stringify(mapTouchReleaseSnapshot(all, all, { width: 100, height: 70 }))), []);
});

test('release removes changed ids from tracked contacts instead of trusting stale allTouches', () => {
  const tracked = [{ id: 7, x: .7, y: .7 }, { id: 9, x: .9, y: .9 }];
  assert.deepEqual(removeChangedTouchContacts(tracked, [{ id: 7 }]), [{ id: 9, x: .9, y: .9 }]);
  assert.deepEqual(removeChangedTouchContacts(tracked, [{ id: 4 }]), tracked);
});

test('pinch cancellation leaves the next touch sequence usable',()=>{
 const h=render();h.rerender({preview:true});
 const down={allTouches:[point(1,20,20)],changedTouches:[point(1,20,20)]};
 h.manual().handlers.onTouchesDown(down);
 const pinch=h.gestures.findLast(g=>g.kind==='Pinch');
 pinch.handlers.onBegin();pinch.handlers.onUpdate({scale:2});
 h.manual().handlers.onTouchesUp(down);
 const count=h.calls.length;
 h.manual().handlers.onTouchesDown({allTouches:[point(2,30,30)],changedTouches:[point(2,30,30)]});
 assert.equal(h.calls.length,count+1);
});

test('pinch movement cancels before forwarding the frame to the host',()=>{
 const h=render();h.rerender({preview:true});h.layout(100,70);
 const initial=[point(1,20,30),point(2,60,30)];
 h.manual().handlers.onTouchesDown({allTouches:initial,changedTouches:initial});
 const before=h.calls.length,cancelled=h.cancelCalls.length;
 h.manual().handlers.onTouchesMove({allTouches:[point(1,10,30),point(2,70,30)],changedTouches:initial});
 assert.equal(h.calls.length,before);assert.equal(h.cancelCalls.length,cancelled+1);
});


test('direct touches outside the image and leaving letterboxes never commit a click',()=>{
 const h=render();h.rerender({preview:true,mode:'direct',videoSize:{width:1600,height:900}});h.layout(100,200);
 const frame=(id,y)=>({allTouches:[point(id,50,y)],changedTouches:[point(id,50,y)]});
 h.manual().handlers.onTouchesDown(frame(1,10));h.manual().handlers.onTouchesUp(frame(1,10));
 h.manual().handlers.onTouchesDown(frame(2,100));h.manual().handlers.onTouchesMove(frame(2,10));h.manual().handlers.onTouchesUp(frame(2,10));
 assert.equal(h.directCommands.length,0);
 h.manual().handlers.onTouchesDown(frame(3,100));h.manual().handlers.onTouchesUp(frame(3,100));
 assert.equal(h.directCommands.filter(c=>c.a==='down').length,1);assert.equal(h.directCommands.filter(c=>c.a==='up').length,1);
});

test('two-finger scroll keeps ownership through incidental finger separation',()=>{
 const h=render();h.rerender({preview:true});h.layout(400,800);
 const initial=[point(1,100,300),point(2,160,300)];
 h.manual().handlers.onTouchesDown({allTouches:initial,changedTouches:initial});
 h.manual().handlers.onTouchesMove({allTouches:[point(1,100,320),point(2,162,320)],changedTouches:initial});
 const cancelled=h.cancelCalls.length,before=h.calls.length;
 h.gestures.findLast(g=>g.kind==='Pinch').handlers.onUpdate({scale:1.3});
 h.manual().handlers.onTouchesMove({allTouches:[point(1,98,350),point(2,172,350)],changedTouches:initial});
 assert.equal(h.cancelCalls.length,cancelled);assert.equal(h.calls.length,before+1);
});

test('manual native recognizer owns the gesture until its final finger is lifted',()=>{
 const h=render();let active=0,ended=0;const manager={activate(){active++},end(){ended++}};
 const touches=[point(1,20,20),point(2,30,30),point(3,40,40)];
 h.manual().handlers.onTouchesDown({allTouches:touches,changedTouches:touches},manager);
 assert.equal(active,1);
 h.manual().handlers.onTouchesUp({allTouches:touches,changedTouches:[touches[0]]},manager);
 assert.equal(ended,0);
 h.manual().handlers.onTouchesUp({allTouches:touches.slice(1),changedTouches:touches.slice(1)},manager);
 assert.equal(ended,1);
});


test('calibrated trackpad starts outside the preview and continues across coordinate boundaries',()=>{
 const h=render();h.rerender({preview:true,gain:2,viewportInsetTop:200,viewportInsetBottom:200});h.layout(390,844);
 const g=h.manual().handlers;
 g.onTouchesDown({allTouches:[point(1,10,30)],changedTouches:[point(1,10,30)]});
 const first=h.calls.at(-1).contacts[0];
 g.onTouchesMove({allTouches:[point(1,30,50)],changedTouches:[point(1,30,50)]});
 assert.ok(h.calls.at(-1).contacts[0].x>first.x);
 for(let y=70;y<820;y+=20)g.onTouchesMove({allTouches:[point(1,30,y)],changedTouches:[point(1,30,y)]});
 assert.ok(h.cancelCalls.length>0,'crossing the virtual pad edge rebases instead of stopping');
 const before=h.calls.at(-1).contacts[0].y;
 g.onTouchesMove({allTouches:[point(1,30,825)],changedTouches:[point(1,30,825)]});
 assert.notEqual(h.calls.at(-1).contacts[0].y,before);
 const cancels=h.cancelCalls.length;
 g.onTouchesUp({allTouches:[],changedTouches:[point(1,30,825)]});
 assert.equal(h.cancelCalls.length,cancels+1,'a final short segment cannot generate a tap');h.unmount();
});

test('initial cursor image has native layout dimensions before animated positioning',()=>{
 const h=render();h.layout(390,844);
 h.rerender({preview:true,cursorScale:1,cursor:{visible:true,x:960,y:540,hx:14,hy:13,w:96,h:96,sourceWidth:1920,sourceHeight:1080,imageId:'0123456789abcdef',image:'data:image/png;base64,iVBORw0KGgoAAA=='}});
 const image=h.nodes().find(n=>n.type==='Image');assert.ok(image);
 assert.equal(image.props.style.width,28);assert.equal(image.props.style.height,28);
 assert.equal(image.props.source.width,96);assert.equal(image.props.source.height,96);
 h.rerender({cursorScale:.75});assert.equal(h.nodes().find(n=>n.type==='Image').props.style.width,21);h.unmount();
});


test('the cursor renders intermediate UI frames and retargets a burst without replaying old positions',()=>{
 const feed=new cursorModule.CursorFeed();
 const h=render({animate:true});
 const cursor={visible:true,x:100,y:400,hx:4,hy:5,w:30,h:30,sourceWidth:1920,sourceHeight:1080,imageId:'0123456789abcdef',image:'data:image/png;base64,iVBORw0KGgoAAA=='};
 h.rerender({preview:true,cursorFeed:feed});h.layout(390,844);feed.publish(cursor);h.tick(0);
 const left=()=>h.nodes().find(n=>n.type==='AnimatedView' && Array.isArray(n.props.style) && n.props.style[0]?.width)?.props.style[1].left;
 const before=left();h.tick(16);feed.publish({...cursor,x:260});h.tick(0);
 assert.equal(left(),before,'receiving a target must not teleport the displayed cursor');
 h.tick(8);const halfway=left();const target=cursorModule.cursorPlacement({...cursor,x:260},390,844,1,0,0,21).left;
 assert.ok(halfway>before && halfway<target,JSON.stringify({before,halfway,target}));
 feed.publish({...cursor,x:300});feed.publish({...cursor,x:400});h.tick(0);assert.equal(left(),halfway);
 h.tick(48);assert.ok(Math.abs(left()-cursorModule.cursorPlacement({...cursor,x:400},390,844,1,0,0,21).left)<1e-8);
 feed.publish({...cursor,x:400,hx:10});h.tick(0);assert.ok(Math.abs(left()-cursorModule.cursorPlacement({...cursor,x:400,hx:10},390,844,1,0,0,21).left)<1e-8);
 h.tick(300);const settled=left();feed.publish({...cursor,x:800});h.tick(16);
 assert.ok(left()>settled && left()<cursorModule.cursorPlacement({...cursor,x:800},390,844,1,0,0,21).left);
 h.unmount();
});


function predictedSurface(options={}) {
 const feed=new cursorModule.CursorFeed(), h=render({animate:true,...options});
 h.connection.capabilities={input:{pointerPrediction:{version:1,pixelsPerMm:options.pixelsPerMm ?? 20,width:1920,height:1080,clock:'host-monotonic-us'}}};
 const cursor={visible:true,x:500,y:400,hx:4,hy:5,w:30,h:30,sourceWidth:1920,sourceHeight:1080,capturedAtUs:1000000,imageId:'0123456789abcdef',image:'data:image/png;base64,iVBORw0KGgoAAA=='};
 h.rerender({preview:true,cursorFeed:feed,gain:1});h.layout(390,844);feed.publish(cursor);h.tick(0);
 const left=()=>h.nodes().find(n=>n.type==='AnimatedView' && Array.isArray(n.props.style) && n.props.style[0]?.width)?.props.style[1].left;
 const frame=(id,x)=>({allTouches:[point(id,x,400)],changedTouches:[point(id,x,400)]});
 return {h,feed,cursor,left,frame};
}
test('native finger motion remains continuous during a 1.6s metadata outage, without rollback from old echoes',()=>{
 const {h,feed,cursor,left,frame}=predictedSurface();
 h.manual().handlers.onTouchesDown(frame(1,100));
 let before=left();
 for(let i=1;i<=100;i++) {
  h.manual().handlers.onTouchesMove(frame(1,100+i*2)); h.tick(16);
  const next=left(); assert.ok(next>before,'UI cursor must advance on every native gesture frame without remote packets');before=next;
  if(i===10) {feed.publish({...cursor,x:510,capturedAtUs:1100000});h.tick(0);assert.equal(left(),before,'late echo cannot roll the local pointer back');}
 }
 const expected=500+200*70/844*20;
 assert.ok(Math.abs(left()-cursorModule.cursorPlacement({...cursor,x:expected},390,844,1,0,0,21).left)<1e-8);
 h.manual().handlers.onTouchesUp(frame(1,300)); assert.equal(h.fences.length,1);
 h.fences[0](2000000); feed.publish({...cursor,x:520,capturedAtUs:1500000});h.tick(48);assert.equal(left(),before);
 feed.publish({...cursor,x:expected,capturedAtUs:2100000});h.tick(48);assert.ok(Math.abs(left()-before)<1e-8);
 h.unmount();
});
test('fractional desktop scale uses the host physical pixel contract without a release jump',()=>{
 const {h,feed,cursor,left,frame}=predictedSurface({pixelsPerMm:25});
 h.manual().handlers.onTouchesDown(frame(1,100));
 for(let i=1;i<=60;i++) {h.manual().handlers.onTouchesMove(frame(1,100+i*2));h.tick(16);}
 const expected=500+120*70/844*25;
 const expectedLeft=cursorModule.cursorPlacement({...cursor,x:expected},390,844,1,0,0,21).left;
 assert.ok(Math.abs(left()-expectedLeft)<1e-8);
 h.manual().handlers.onTouchesUp(frame(1,220));h.fences[0](2000000);
 feed.publish({...cursor,x:expected,capturedAtUs:2100000});h.tick(48);
 assert.ok(Math.abs(left()-expectedLeft)<1e-8,'scaled host confirmation must preserve the UI position');
 h.unmount();
});
test('a stale stroke fence cannot settle a newer stroke, and background cancellation stops prediction',()=>{
 const {h,feed,cursor,left,frame}=predictedSurface();
 h.manual().handlers.onTouchesDown(frame(1,100));h.manual().handlers.onTouchesMove(frame(1,120));h.manual().handlers.onTouchesUp(frame(1,120));
 h.manual().handlers.onTouchesDown(frame(2,130));h.manual().handlers.onTouchesMove(frame(2,150));h.tick(0);
 const before=left();h.fences[0](2000000);feed.publish({...cursor,x:510,capturedAtUs:2100000});h.tick(48);assert.equal(left(),before);
 h.appState('background');h.tick(64);const settled=left();
 h.manual().handlers.onTouchesMove(frame(2,180));h.tick(32);assert.equal(left(),settled);h.unmount();
});
test('prediction is gated by confirmed geometry and capture clock; two fingers hand motion back to the host',()=>{
 const {h,feed,cursor,left,frame}=predictedSurface();
 feed.publish({...cursor,capturedAtUs:undefined});h.tick(0);h.manual().handlers.onTouchesDown(frame(1,100));const before=left();
 h.manual().handlers.onTouchesMove(frame(1,120));h.tick(32);assert.equal(left(),before);
 h.manual().handlers.onTouchesUp(frame(1,120));feed.publish(cursor);h.tick(48);
 h.manual().handlers.onTouchesDown(frame(2,100));h.manual().handlers.onTouchesMove(frame(2,110));h.tick(0);
 const one=left();const two={allTouches:[point(2,110,400),point(3,160,400)],changedTouches:[point(3,160,400)]};
 h.manual().handlers.onTouchesDown(two);assert.equal(h.fences.length,1);
 h.manual().handlers.onTouchesMove({...two,allTouches:[point(2,130,400),point(3,180,400)]});h.tick(16);assert.equal(left(),one);
 h.unmount();
});

test('a stalled RN queue cannot request reconciliation before the native release is actually sent',()=>{
 const {h,frame}=predictedSurface({defer:true});h.drain();
 h.manual().handlers.onTouchesDown(frame(1,100));h.manual().handlers.onTouchesMove(frame(1,120));h.manual().handlers.onTouchesMove(frame(1,140));h.manual().handlers.onTouchesUp(frame(1,140));
 assert.equal(h.fences.length,0);
 h.runQueued(0);h.runQueued(0);h.runQueued(0);assert.equal(h.fences.length,0,'movement callbacks queued before up cannot request a fence');
 h.runQueued(0);assert.equal(h.fences.length,1);assert.equal(h.calls.at(-1).contacts.length,0);h.unmount();
});

test('reconciliation never replays stale coordinates; an unresponsive capture recovers the control connection',()=>{
 const {h,feed,cursor,left,frame}=predictedSurface();h.manual().handlers.onTouchesDown(frame(1,100));h.manual().handlers.onTouchesMove(frame(1,180));h.tick(16);
 const before=left();h.manual().handlers.onTouchesUp(frame(1,180));h.fences[0](2000000);
 feed.publish({...cursor,x:510,capturedAtUs:1500000});h.tick(2999);assert.equal(left(),before);assert.equal(h.recoveries,0);
 h.tick(1);assert.equal(h.recoveries,1);assert.equal(left(),before);h.unmount();
});

test('animated keyboard geometry keeps the video, cursor and direct click coordinates synchronized',()=>{
 const h=render(),motion={height:{value:0},windowResize:0,bottom:21};
 h.rerender({preview:true,mode:'direct',videoSize:{width:1920,height:1080},viewportInsetLeft:300,viewportInsetRight:68,keyboardMotion:motion});h.layout(844,390);
 for(const [id,bottom] of [[1,21],[2,88],[3,176]]){
  motion.height.value=-bottom;h.tick(0);
  const viewport=h.nodes().find(n=>n.type==='AnimatedView'&&n.props.style?.bottom!==undefined);
  assert.equal(viewport.props.style.bottom,bottom);
  const center=point(id,300+(844-300-68)/2,(390-bottom)/2);
  const frame={allTouches:[center],changedTouches:[center]};
  h.manual().handlers.onTouchesDown(frame);h.manual().handlers.onTouchesUp(frame);
  const down=h.directCommands.filter(c=>c.a==='down').at(-1);assert.ok(down);
  const position=h.directCommands.filter(c=>c.t==='p').at(-1);
  assert.equal(position.dx,32768);assert.equal(position.dy,32768);
 }
 assert.equal(h.directCommands.filter(c=>c.a==='down').length,3);h.unmount();
});

test('a hidden keyboard releases video geometry even if the native animation retained an old negative height',()=>{
 const h=render(),motion={height:{value:-176},windowResize:0,bottom:21,visible:false};
 h.rerender({preview:true,mode:'direct',videoSize:{width:1920,height:1080},viewportInsetLeft:300,viewportInsetRight:68,keyboardMotion:motion});h.layout(844,390);h.tick(0);
 const viewport=h.nodes().find(n=>n.type==='AnimatedView'&&n.props.style?.bottom!==undefined);
 assert.equal(viewport.props.style.bottom,21);
 const center=point(1,300+(844-300-68)/2,(390-21)/2),frame={allTouches:[center],changedTouches:[center]};
 h.manual().handlers.onTouchesDown(frame);h.manual().handlers.onTouchesUp(frame);
 const position=h.directCommands.filter(c=>c.t==='p').at(-1);assert.equal(position.dx,32768);assert.equal(position.dy,32768);h.unmount();
});

test('composer reflection follows native mouse gestures even while the RN queue is stalled',()=>{
 const glassPointer={value:{x:.5,y:.78,active:false}},h=render({defer:true});h.rerender({glassPointer});h.layout(400,800);
 const gesture=h.manual().handlers;
 gesture.onTouchesDown({allTouches:[point(1,40,320)],changedTouches:[point(1,40,320)]});
 assert.equal(glassPointer.value.active,true);assert.equal(glassPointer.value.x,.1);assert.equal(h.calls.length,0);
 gesture.onTouchesMove({allTouches:[point(1,360,400)],changedTouches:[point(1,360,400)]});
 assert.equal(glassPointer.value.x,.9);assert.equal(glassPointer.value.y,.5);assert.equal(h.calls.length,0);
 gesture.onTouchesUp({allTouches:[],changedTouches:[point(1,360,400)]});
 assert.equal(glassPointer.value.active,false);assert.equal(glassPointer.value.x,.5);assert.equal(glassPointer.value.y,.78);
 h.drain();assert.equal(h.calls.length,3);assert.equal(h.calls.at(-1).contacts.length,0);h.unmount();
});
test('reflection adds no mouse commands and remains independent of pointer gain',()=>{
 const plain=value=>JSON.stringify(value),base=render(),h=render(),pointer={value:{x:.5,y:.78,active:false}};
 h.rerender({glassPointer:pointer});
 for(const pad of [base,h]){
  pad.rerender({gain:2});pad.layout(400,800);
  pad.manual().handlers.onTouchesDown({allTouches:[point(1,120,280)],changedTouches:[point(1,120,280)]});
  pad.manual().handlers.onTouchesMove({allTouches:[point(1,160,320)],changedTouches:[point(1,160,320)]});
 }
 assert.equal(pointer.value.x,.4);assert.equal(pointer.value.y,.4);assert.equal(plain(h.calls),plain(base.calls));
 for(const pad of [base,h])pad.unmount();
});
test('second fingers and obsolete releases cannot reset the current reflection',()=>{
 const glassPointer={value:{x:.5,y:.78,active:false}},h=render();h.rerender({glassPointer});h.layout(400,800);
 const g=h.manual().handlers,a=point(3,100,200),b=point(4,300,400);
 g.onTouchesDown({allTouches:[a],changedTouches:[a]});
 g.onTouchesDown({allTouches:[b,a],changedTouches:[b]});assert.equal(glassPointer.value.x,.25);
 g.onTouchesMove({allTouches:[b,a],changedTouches:[b,a]});assert.equal(glassPointer.value.x,.25);
 g.onTouchesUp({allTouches:[a,b],changedTouches:[point(2,20,20)]});assert.equal(glassPointer.value.active,true);assert.equal(glassPointer.value.x,.25);
 g.onTouchesUp({allTouches:[b],changedTouches:[a]});assert.equal(glassPointer.value.x,.75);
 g.onTouchesUp({allTouches:[],changedTouches:[b]});assert.equal(glassPointer.value.active,false);h.unmount();
});
test('cancel, rotation, background, disable and unmount always remove the finger reflection',()=>{
 for(const end of ['cancel','rotation','background','disable','unmount']){
  const glassPointer={value:{x:.5,y:.78,active:false}},h=render();h.rerender({glassPointer});h.layout(400,800);
  h.manual().handlers.onTouchesDown({allTouches:[point(1,100,200)],changedTouches:[point(1,100,200)]});assert.equal(glassPointer.value.active,true);
  if(end==='cancel')h.manual().handlers.onTouchesCancelled();
  if(end==='rotation')h.layout(800,400);
  if(end==='background')h.appState('background');
  if(end==='disable')h.rerender({disabled:true});
  if(end==='unmount')h.unmount();
  assert.equal(glassPointer.value.active,false,end);assert.equal(glassPointer.value.x,.5,end);assert.equal(glassPointer.value.y,.78,end);
  h.unmount();
 }
});
