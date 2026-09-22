const appearanceModule = require('./appearance-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function sameDeps(left, right) {
  return left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function harness(options = {}) {
  const slots = [];
  const pendingEffects = [];
  const connections = [];
  const previews = [];
  const updates = [];
  const appStateListeners = [];
  const commands = [];
  const alerts = [];
  const uploads = [];
  const dimensions = { width: 390, height: 844 };
  const keyboardState = options.keyboardState ?? { isVisible: false, height: 0 };
  const absoluteFill = { __style: 'absoluteFill' };
  const keyboard = { dismissCount: 0, dismiss: () => { keyboard.dismissCount++; } };
  const videoStarts = [];
  let cursor = 0;
  let dirty = false;
  let tree;
  let hostChanges = 0;

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index] || slots[index].kind !== 'state') slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[index];
      return [slot.value, next => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index] || slots[index].kind !== 'ref') slots[index] = { kind: 'ref', current: initial };
      return slots[index];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (previous?.kind === 'memo' && sameDeps(previous.deps, deps)) return previous.value;
      const value = factory();
      slots[index] = { kind: 'memo', deps, value };
      return value;
    },
    useCallback(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (previous?.kind === 'callback' && sameDeps(previous.deps, deps)) return previous.value;
      slots[index] = { kind: 'callback', deps, value: callback };
      return callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        pendingEffects.push({ index, effect, previous });
        slots[index] = { kind: 'effect', deps, cleanup: previous?.cleanup };
      }
    },
  };

  class FakeConnection {
    constructor(origin, report) {
      this.origin = origin;
      this.canInput = options.canInput !== false;
      this.canView = true;
      this.canTransfer = options.canTransfer !== false;
      this.canClipboard = options.canClipboard !== false;
      this.capabilities = null;
      this.literal = { draft: '', lateDraft: null, pending: null, busy: false };
      this.report = report;
      this.startCount = 0;
      this.stopCount = 0;
      connections.push(this);
    }
    start = () => { this.startCount++; };
    setForeground = active => { if(active && !this.startCount) this.start(); };
    stop = () => { this.stopCount++; };
    send = command => { commands.push({ kind: 'send', command }); return options.sendSucceeds !== false; };
    move = (dx, dy) => { commands.push({ kind: 'move', dx, dy }); };
    click = button => { commands.push({ kind: 'click', button }); };
  }

  class FakePreviewLifecycle {
    constructor(start, show, message) {
      this.start = start;
      this.show = show;
      this.message = message;
      this.updateCalls = [];
      this.restartCount = 0;
      this.disposeCount = 0;
      this.started = false;
      previews.push(this);
    }
    update = (wanted, active, ready) => {
      this.updateCalls.push({ wanted, active, ready });
      if (wanted && active && ready && !this.started) {
        this.started = true;
        const session = this.start(new AbortController().signal, stream => this.show(stream), error => this.message(error.message));
        void Promise.resolve(session).then(value => { this.session = value; });
      }
    };
    restart = () => { this.restartCount++; };
    dispose = () => { this.disposeCount++; };
  }

  class FakeUpdateLifecycle {
    constructor(port, interactive) {
      this.port = port;
      this.interactive = interactive;
      this.events = [];
      updates.push(this);
    }
    start = state => { this.events.push(['start', state]); };
    setAppState = state => { this.events.push(['appState', state]); };
    setPreview = value => { this.events.push(['preview', value]); };
    markReady = () => { this.events.push(['ready']); };
    check = () => { this.events.push(['check']); return Promise.resolve({}); };
    dispose = () => { this.events.push(['dispose']); };
  }

  const stream = { toURL: () => 'stream://test' };
  const startVideo = (_origin, _signal, show) => {
    videoStarts.push(_origin);
    show(stream);
    return Promise.resolve(() => {});
  };
  const updatePort = {
    isEnabled: false,
    checkForUpdateAsync: () => Promise.resolve({}),
    fetchUpdateAsync: () => Promise.resolve({}),
    reloadAsync: () => Promise.resolve(),
  };
  const keyboardLayout = {};
  vm.runInNewContext(compile('components/keyboard-layout.ts'), { exports: keyboardLayout, require: () => appearanceModule });
  const pointerGeometry = {};
  vm.runInNewContext(compile('lib/pointer-geometry.ts'), { exports: pointerGeometry, Number, Math });
  const modules = { './appearance': appearanceModule, '../components/appearance': appearanceModule,
    'expo-keep-awake': {activateKeepAwakeAsync: async()=>{},deactivateKeepAwake:async()=>{}},
    '../lib/session-awake': {keepSessionAwake:()=>()=>{}},
    '../lib/control-preferences': {loadControlPreferences:()=>({mode:'trackpad',gain:1}),saveControlPreferences:()=>{}},
    '../lib/clipboard-transfer': {transferClipboard:async()=>{}},
    '../components/session-options': {SessionOptions:'SessionOptions'},
    react,
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props: props || {} }),
      jsxs: (type, props) => ({ type, props: props || {} }),
    },
    'react-native': {
      Alert: { alert: (...args) => alerts.push(args) },
      AppState: {
        currentState: 'active',
        addEventListener: (_event, listener) => {
          appStateListeners.push(listener);
          return { remove() {} };
        },
      },
      Keyboard: keyboard,
      StyleSheet: { absoluteFill, create: styles => styles },
      Text: 'Text',
      View: 'View', Modal: 'Modal', ScrollView: 'ScrollView',
      useWindowDimensions: () => dimensions,
    },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-updates': {
      isEnabled: false,
      useUpdates: () => ({ isUpdatePending: false }),
      checkForUpdateAsync: updatePort.checkForUpdateAsync,
      fetchUpdateAsync: updatePort.fetchUpdateAsync,
      reloadAsync: updatePort.reloadAsync,
    },
    'react-native-keyboard-controller': {
      KeyboardAvoidingView: 'KeyboardAvoidingView',
      useKeyboardState: selector => selector(keyboardState),
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 54, right: 12, bottom: 34, left: 10 }) },
    '@livekit/react-native-webrtc': { RTCView: 'RTCView' },
    '../components/glass-button': { GlassButton: 'GlassButton' },
    '../components/glass-surface': { GlassSurface: 'GlassSurface' },
    '../components/landscape-controls': { LandscapeControls: 'LandscapeControls' },
    '../components/help-sheet': { HelpSheet: 'HelpSheet' },
    '../components/touch-surface': { TouchSurface: 'TouchSurface' },
    '../components/native-keyboard': { NativeKeyboard: 'NativeKeyboard' },
    '../components/keyboard-layout': keyboardLayout,
    '../lib/pointer-geometry': pointerGeometry,
    '../lib/attachments': {
      chooseAttachments: () => options.choicePromise ?? Promise.resolve(options.attachments ?? (options.attachment ? [options.attachment] : [])),
      attachmentBatch: items => ({ id: 'fixture-batch', items }),

    },
    './glass-button': { GlassButton: 'GlassButton' },
    '../lib/file-transfer': {
      transferLimits: async () => ({ version: 2, maxFiles: 20, maxBytes: 104857600, maxChunkBytes: 1048576, ttlSeconds: 86400 }),
      sendPreparedBatch: async (...args) => { uploads.push(args); if (options.uploadError) throw Error('transfer failed'); return {state:'stored'}; },
      copyPreparedBatch: async batch => ({ state:'stored', files:batch.manifest.files, clipboard:{state:options.receipt?.clipboard ?? 'ready',replayed:options.replayed} }),
      cancelPreparedBatch: async () => ({state:'cancelled'}),
    },
    '../lib/file-transfer-storage': {
      restorePreparedBatch: () => null,
      prepareBatch: async (origin,batch) => ({origin,createdAt:1,manifest:{version:2,id:batch.id,files:batch.items.map(f=>({name:f.name,bytes:f.size??123,type:f.type,sha256:'a'.repeat(64)}))}}),
      readPreparedChunk: () => new Uint8Array(),
      discardPreparedBatch: () => {},
    },
    '../lib/connection': { Connection: FakeConnection },
    '../lib/video': { startVideo },
    '../lib/updates': { UpdateLifecycle: FakeUpdateLifecycle },
    '../lib/preview-lifecycle': { PreviewLifecycle: FakePreviewLifecycle },
  };

  const attachmentModule = {};
  vm.runInNewContext(compile('components/attachment-transfer.tsx'), {
    exports: attachmentModule, require: name => modules[name], AbortController, setTimeout, clearTimeout, Uint8Array,
  });
  modules['../components/attachment-transfer'] = attachmentModule;
  const exports = {};
  vm.runInNewContext(compile('screens/control.tsx'), {
    exports,
    require: name => modules[name],
    AbortController,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const Control = exports.Control;

  function flushEffects() {
    while (pendingEffects.length) {
      const { index, effect, previous } = pendingEffects.shift();
      previous?.cleanup?.();
      slots[index].cleanup = effect();
    }
  }

  function render() {
    let passes = 0;
    do {
      dirty = false;
      cursor = 0;
      tree = Control({ origin: options.origin ?? 'https://computer.test', onChangeHost: () => { hostChanges++; } });
      flushEffects();
      if (++passes > 20) throw new Error('Control test harness did not settle');
    } while (dirty);
    return tree;
  }

  function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }

  function find(type, label) {
    return nodes(tree).find(node => node.type === type && (!label || node.props.label === label));
  }

  function findPath(node, type, pathSoFar = []) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const result = findPath(node[index], type, pathSoFar.concat(index));
        if (result) return result;
      }
      return null;
    }
    if (node.type === type) return pathSoFar;
    const children = node.props?.children;
    if (Array.isArray(children)) {
      for (let index = 0; index < children.length; index++) {
        const result = findPath(children[index], type, pathSoFar.concat(['children', index]));
        if (result) return result;
      }
    } else {
      const result = findPath(children, type, pathSoFar.concat(['children']));
      if (result) return result;
    }
    return null;
  }

  function all(type) { return nodes(tree).filter(node => node.type === type); }
  function setDimensions(width, height) { dimensions.width = width; dimensions.height = height; render(); }
  function reportConnection(state) { connections[0].report(state); render(); }

  render();
  return {
    all,
    connections,
    hostChanges: () => hostChanges,
    unmount: () => slots.forEach(slot => { if (slot?.kind === 'effect') slot.cleanup?.(); }),
    alerts,
    uploads,
    commands,
    find,
    findPath: type => findPath(tree, type),
    keyboard,
    previews,
    reportConnection,
    render,
    setDimensions,
    startVideoCount: () => videoStarts.length,
    tree: () => tree,
    updates,
    videoStarts,
    absoluteFill,
    keyboardState,
  };
}

test('portrait keeps the composer and contains the preview without safe-area padding', () => {
  const h = harness();
  h.reportConnection('connected');
  const nativePath = h.findPath('NativeKeyboard');
  assert.ok(h.find('NativeKeyboard').props.visible);
  assert.equal(h.find('GlassButton', 'Reconectar').props.label, 'Reconectar');

  h.find('GlassButton', 'Ver pantalla').props.onPress();
  h.render();
  const rtc = h.find('RTCView');
  assert.ok(rtc, 'preview should mount an RTCView');
  assert.equal(rtc.props.objectFit, 'contain');
  assert.strictEqual(rtc.props.style, h.absoluteFill);
  assert.deepEqual(h.findPath('NativeKeyboard'), nativePath);

  for (const node of [h.tree(), h.find('TouchSurface')].concat(h.all('KeyboardAvoidingView'))) {
    const style = node.props?.style;
    if (!style || typeof style !== 'object' || Array.isArray(style)) continue;
    assert.equal(style.paddingTop, undefined, 'video ancestors must not add top inset padding');
    assert.equal(style.paddingBottom, undefined, 'video ancestors must not add bottom inset padding');
  }
});

test('mouse settings preserve the mounted composer and expose no removed pages', () => {
 const h=harness();h.reportConnection('connected');const before=h.findPath('NativeKeyboard');
 h.find('GlassButton','Mouse').props.onPress();h.render();
 assert.equal(h.find('SessionOptions').props.visible,true);
 assert.equal(h.find('SessionOptions').props.help,undefined);
 assert.equal(h.find('SessionOptions').props.hosts,undefined);
 assert.deepEqual(h.findPath('NativeKeyboard'),before);
 assert.equal(h.find('GlassButton','Equipos'),undefined);
});
test('landscape controls stay mounted without toggles or extra input',()=>{
 const h=harness();h.reportConnection('connected');h.find('GlassButton','Ver pantalla').props.onPress();h.render();
 h.setDimensions(844,390);const rail=h.find('LandscapeControls');
 assert.ok(rail);assert.equal(rail.props.show,undefined);assert.equal(rail.props.hide,undefined);
 rail.props.openOptions();h.render();assert.equal(h.find('SessionOptions').props.visible,true);
 assert.equal(h.startVideoCount(),1);assert.equal(h.previews[0].restartCount,0);
});

test('landscape preview reserves only the keyboard overlap and avoids Android double resize', () => {
  const h = harness({ keyboardState: { isVisible: false, height: 0 } });
  h.reportConnection('connected');
  h.find('GlassButton', 'Ver pantalla').props.onPress();
  h.render();
  h.setDimensions(844, 390);
  h.find('LandscapeControls').props.openKeyboard();
  h.render();
  h.keyboardState.isVisible = true;
  h.keyboardState.height = 260;
  h.render();
  assert.equal(h.find('TouchSurface').props.viewportInsetBottom, 260, 'iOS full-window layout clips the preview above the keyboard');

  h.setDimensions(844, 130);
  assert.equal(h.find('RTCView').props.style, h.absoluteFill, 'Android resize is already reflected by the window');
  h.find('NativeKeyboard').props.onOcclusionChange(68);h.render();
  assert.equal(h.find('TouchSurface').props.viewportInsetBottom,68,'reserve the measured composer once');
  assert.equal(h.find('TouchSurface').props.viewportInsetBottom,68,'direct input uses the same free rectangle');
  assert.equal(h.startVideoCount(),1,'resizing does not restart video');
});

test('landscape preview handles resize-first and keyboard-state-first event ordering', () => {
  for (const order of ['resize-first', 'keyboard-first']) {
    const keyboardState = { isVisible: false, height: 0 };
    const h = harness({ keyboardState });
    h.reportConnection('connected');
    h.find('GlassButton', 'Ver pantalla').props.onPress(); h.render();
    h.setDimensions(844, 390);
    h.find('LandscapeControls').props.openKeyboard(); h.render();
    if (order === 'resize-first') h.setDimensions(844, 130);
    keyboardState.isVisible = true; keyboardState.height = 260; h.render();
    if (order === 'keyboard-first') h.setDimensions(844, 130);
    assert.equal(h.find('RTCView').props.style, h.absoluteFill, `${order} must not double clip Android resize`);
  }
});

test('landscape keyboard keeps the rail available and mouse settings dismiss the keyboard', () => {
 const h=harness();h.reportConnection('connected');h.find('GlassButton','Ver pantalla').props.onPress();h.render();h.setDimensions(844,390);
 h.find('LandscapeControls').props.openKeyboard();h.render();
 assert.equal(h.find('NativeKeyboard').props.active,true);assert.ok(h.find('LandscapeControls'));
 h.find('LandscapeControls').props.openOptions();h.render();
 assert.equal(h.find('NativeKeyboard').props.active,false);
 assert.equal(h.find('SessionOptions').props.visible,true);
});

test('returning to portrait restores the same composer position after landscape controls', () => {
  const h = harness();
  h.reportConnection('connected');
  h.find('GlassButton', 'Ver pantalla').props.onPress();
  h.render();
  const portraitPath = h.findPath('NativeKeyboard');
  h.setDimensions(844, 390);
  const landscapePath = h.findPath('NativeKeyboard');
  assert.deepEqual(landscapePath, portraitPath);
  assert.equal(h.find('NativeKeyboard').props.visible, false);
  h.setDimensions(390, 844);
  assert.deepEqual(h.findPath('NativeKeyboard'), portraitPath);
  assert.equal(h.find('NativeKeyboard').props.visible, true);
});

test('rotation preserves the active composer and mounted preview', () => {
  const h = harness();
  h.reportConnection('connected');
  h.find('GlassButton', 'Ver pantalla').props.onPress();
  h.render();
  const rtcPath = h.findPath('RTCView');
  for (let cycle = 0; cycle < 3; cycle++) {
    h.find('NativeKeyboard').props.open(); h.render();
    assert.equal(h.find('KeyboardAvoidingView'), undefined, 'keyboard adjustment must never wrap the video');
    h.setDimensions(844, 390);
    assert.equal(h.find('NativeKeyboard').props.active, true);
    assert.equal(h.find('NativeKeyboard').props.visible, true);
    assert.equal(h.find('KeyboardAvoidingView'), undefined);
    assert.equal(h.tree().type, 'View');
    assert.equal(h.tree().props.style.flex, 1);
    assert.equal(h.tree().props.style.paddingBottom, undefined);
    h.setDimensions(390, 844);
    assert.equal(h.find('NativeKeyboard').props.visible, true);
    assert.equal(h.find('KeyboardAvoidingView'), undefined);
    assert.deepEqual(h.findPath('RTCView'), rtcPath);
  }
  assert.equal(h.startVideoCount(), 1);
  assert.equal(h.commands.length, 0);
});

test('rotation preserves keyboard focus without preview and explicit closing still works', () => {
  const h = harness(); h.reportConnection('connected');
  h.find('NativeKeyboard').props.open(); h.render();
  h.setDimensions(844, 390);
  assert.equal(h.find('NativeKeyboard').props.active, true);
  assert.equal(h.find('KeyboardAvoidingView'), undefined);
  h.find('NativeKeyboard').props.open(); h.render();
  assert.equal(h.find('KeyboardAvoidingView'), undefined, 'keyboard adjustment must never wrap the video');
  h.find('NativeKeyboard').props.close(); h.render();
  assert.equal(h.find('KeyboardAvoidingView'), undefined);
});

const photo = { uri: 'file:///selected.jpg', name: 'Foto.jpg', type: 'image/jpeg', size:123 };
const delivered = { clipboard:'ready' };
const settle = () => new Promise(resolve => setImmediate(resolve));
async function choose(h, source='photos') {
 h.reportConnection('connected'); h.find('NativeKeyboard').props.choose(source); await settle(); h.render();
}
async function send(h) {
 h.find('GlassButton','Enviar').props.onPress(); await settle(); h.render();
}
test('selection is reviewed before upload and never pastes or submits automatically',async()=>{
 const h=harness({attachment:photo,receipt:delivered});await choose(h,'camera');
 assert.equal(h.uploads.length,0);assert.equal(h.find('Modal').props.visible,true);
 await send(h);assert.equal(h.uploads.length,1);assert.equal(h.commands.length,0);
 h.alerts[0][2].find(b=>b.text==='Pegar ahora').onPress();
 assert.equal(h.commands.length,1);assert.equal(h.commands[0].command.key,'v');
 assert.deepEqual(Array.from(h.commands[0].command.mods),['ctrl']);
 assert.equal(h.commands.some(c=>c.command.key==='Enter'),false);
});
test('unconfirmed or replayed clipboard never offers a misleading paste action',async()=>{
 for(const options of [{receipt:{clipboard:'unavailable'}},{receipt:delivered,replayed:true}]){
  const h=harness({attachment:photo,...options});await choose(h);await send(h);
  assert.equal(h.alerts[0][0],'Guardado en la computadora');assert.equal(h.alerts[0][2],undefined);assert.equal(h.commands.length,0);
 }
});
test('canceling the native picker creates no transfer or success alert',async()=>{
 const h=harness();await choose(h);assert.equal(h.uploads.length,0);assert.equal(h.alerts.length,0);
 assert.equal(h.find('NativeKeyboard').props.choosing,false);
});
test('failed paste requests reconnection and never sends Enter',async()=>{
 const h=harness({attachment:photo,receipt:delivered,sendSucceeds:false});await choose(h);await send(h);
 h.alerts[0][2].find(b=>b.text==='Pegar ahora').onPress();assert.equal(h.alerts[1][0],'Reconectá la computadora');
 assert.equal(h.commands.length,1);assert.equal(h.commands[0].command.key,'v');
});
test('multiple selections can be reviewed and removed before sending in order',async()=>{
 const h=harness({attachments:[photo,{...photo,name:'second.jpg'},{...photo,name:'third.jpg'}]});await choose(h);
 h.find('GlassButton','Quitar second.jpg').props.onPress();h.render();await send(h);
 assert.deepEqual(Array.from(h.uploads[0][0].manifest.files,f=>f.name),['Foto.jpg','third.jpg']);
});
test('lost upload response reuses the prepared manifest and does not allow changing its files',async()=>{
 const h=harness({attachment:photo,uploadError:true});await choose(h);await send(h);
 const first=h.uploads[0][0];assert.equal(h.find('GlassButton','Quitar Foto.jpg'),undefined);
 h.find('GlassButton','Reanudar').props.onPress();await settle();h.render();
 assert.equal(h.uploads[1][0].manifest,first.manifest);assert.equal(h.commands.length,0);
});
test('preview stays mounted while reviewing, uploading and closing the attachment sheet',async()=>{
 const h=harness({attachment:photo});h.reportConnection('connected');h.find('GlassButton','Ver pantalla').props.onPress();h.render();
 const rtc=h.findPath('RTCView');await choose(h);assert.deepEqual(h.findPath('RTCView'),rtc);
 await send(h);assert.deepEqual(h.findPath('RTCView'),rtc);assert.equal(h.startVideoCount(),1);
});


test('input, video and attachments all use the selected host and unmount closes its resources', async () => {
 for(const origin of ['https://first.example', 'https://second.example:8443']) {
  const h = harness({origin,attachment:photo});h.reportConnection('connected');
  h.find('GlassButton','Ver pantalla').props.onPress();h.render();
  await choose(h);await send(h);
  assert.equal(h.connections[0].origin,origin);
  assert.equal(h.videoStarts[0],origin);
  assert.equal(h.uploads[0][0].origin,origin);
  assert.equal(h.find('GlassButton','Equipos'),undefined);
  h.unmount();
  assert.ok(h.connections[0].stopCount>0);
  assert.equal(h.previews[0].disposeCount,1);
  assert.ok(h.updates[0].events.some(event=>event[0]==='dispose'));
 }
});

test('pending text still blocks OTA application after removing the host menu',()=>{
 const h=harness();h.find('NativeKeyboard').props.onPendingChange(true);h.render();
 assert.equal(h.updates[0].events.at(-1)[1],true);
 h.find('NativeKeyboard').props.onPendingChange(false);h.render();
 assert.equal(h.updates[0].events.at(-1)[1],false);
});

test('a view-only session can show video while keyboard control stays disabled',()=>{
 const h=harness({canInput:false});h.reportConnection('connected');
 assert.equal(h.find('NativeKeyboard').props.disabled,true);
 h.find('GlassButton','Ver pantalla').props.onPress();h.render();
 assert.ok(h.find('RTCView'));assert.equal(h.startVideoCount(),1);
 h.setDimensions(844,390);assert.equal(h.find('LandscapeControls').props.disabled,true);
 assert.equal(h.previews[0].disposeCount,0);
});

test('a saved batch can complete without clipboard permission and never offers Paste',async()=>{
 const h=harness({attachment:photo,canClipboard:false});await choose(h);
 h.find('GlassButton','Enviar').props.onPress();await settle();h.render();
 assert.equal(h.uploads.length,1);assert.equal(h.alerts[0][0],'Guardado en la computadora');
 assert.equal(h.alerts[0][2],undefined);assert.equal(h.commands.length,0);
});

test('native picker suspension does not discard the photos chosen while the control socket reconnects',async()=>{
 let finish;const choicePromise=new Promise(resolve=>{finish=resolve;});
 const h=harness({choicePromise});h.reportConnection('connected');
 h.find('NativeKeyboard').props.choose('photos');await settle();h.render();
 h.reportConnection('offline');finish([photo]);await settle();h.render();
 assert.equal(h.find('Modal').props.visible,true);assert.equal(h.uploads.length,0);
 h.reportConnection('connected');await send(h);assert.equal(h.uploads.length,1);
});

test('portrait keyboard reserves space above the composer without recreating video',()=>{
 const h=harness();h.reportConnection('connected');h.find('GlassButton','Ver pantalla').props.onPress();h.render();
 h.find('NativeKeyboard').props.open();h.render();h.keyboardState.height=300;h.keyboardState.isVisible=true;
 h.find('NativeKeyboard').props.onOcclusionChange(60);h.render();
 assert.equal(h.find('TouchSurface').props.viewportInsetBottom,360);
 assert.ok(h.find('TouchSurface').props.viewportInsetTop>54);
 assert.equal(h.startVideoCount(),1);
});
test('landscape reserves both control rails and the keyboard button toggles',()=>{
 const h=harness();h.reportConnection('connected');h.find('GlassButton','Ver pantalla').props.onPress();h.render();h.setDimensions(844,390);
 const surface=h.find('TouchSurface');assert.ok(surface.props.viewportInsetLeft>=70);assert.ok(surface.props.viewportInsetRight>=70);
 h.find('LandscapeControls').props.openKeyboard();h.render();assert.equal(h.find('NativeKeyboard').props.active,true);
 h.find('LandscapeControls').props.openKeyboard();h.render();assert.equal(h.find('NativeKeyboard').props.active,false);
});
