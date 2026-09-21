const test = require('node:test');
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

function render({ dismissKeyboard, touchResult, defer = false } = {}) {
  const slots = [];
  const pendingEffects = [];
  const cleanups = [];
  const gestures = [];
  const appStateListeners = [];
  const calls = [], directCommands = [];
  const cancelCalls = [];
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
  const useSharedValue = initial => {
    const at = hookIndex++;
    return slots[at] ??= { value: initial };
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
    react: { useEffect, useMemo, useRef },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {
      AppState: {
        addEventListener: (_, listener) => {
          appStateListeners.push(listener);
          return { remove: () => { const at = appStateListeners.indexOf(listener); if (at >= 0) appStateListeners.splice(at, 1); } };
        },
      },
      View: 'View',
    },
    'react-native-gesture-handler': {
      GestureDetector: 'GestureDetector',
      Gesture: {
        Manual: () => gesture('Manual'), Pinch: () => gesture('Pinch'), Pan: () => gesture('Pan'),
        Simultaneous: (...items) => ({ kind: 'Simultaneous', items }),
      },
    },
    'react-native-reanimated': { default: { View: 'AnimatedView' }, useSharedValue, useAnimatedStyle: fn => fn() },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => defer ? queue.push([fn, args]) : fn(...args) },
    '../lib/direct-pointer': directPointer, '../lib/connection': {},
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
  }).outputText, { exports: componentExports, require: name => modules[name] });

  const runEffects = () => {
    while (pendingEffects.length) {
      const effect = pendingEffects.shift();
      slots[effect.at].cleanup = effect.fn();
    }
  };
  const renderAgain = () => {
    hookIndex = 0;
    tree = componentExports.TouchSurface(props);
    runEffects();
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
    calls,
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
