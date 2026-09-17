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
  const absoluteFill = { __style: 'absoluteFill' };
  const keyboard = { dismissCount: 0, dismiss: () => { keyboard.dismissCount++; } };
  const videoStarts = [];
  let cursor = 0;
  let dirty = false;
  let tree;

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index] || slots[index].kind !== 'state') slots[index] = { kind: 'state', value: initial };
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
      this.report = report;
      this.startCount = 0;
      this.stopCount = 0;
      connections.push(this);
    }
    start = () => { this.startCount++; };
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
    videoStarts.push(true);
    show(stream);
    return Promise.resolve(() => {});
  };
  const updatePort = {
    isEnabled: false,
    checkForUpdateAsync: () => Promise.resolve({}),
    fetchUpdateAsync: () => Promise.resolve({}),
    reloadAsync: () => Promise.resolve(),
  };
  const modules = {
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
      View: 'View',
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
    'react-native-keyboard-controller': { KeyboardAvoidingView: 'KeyboardAvoidingView' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 54, right: 12, bottom: 34, left: 10 }) },
    '@livekit/react-native-webrtc': { RTCView: 'RTCView' },
    '../components/glass-button': { GlassButton: 'GlassButton' },
    '../components/landscape-controls': { LandscapeControls: 'LandscapeControls' },
    '../components/touch-surface': { TouchSurface: 'TouchSurface' },
    '../components/native-keyboard': { NativeKeyboard: 'NativeKeyboard' },
    '../lib/attachments': {
      chooseAttachments: () => Promise.resolve(options.attachments ?? (options.attachment ? [options.attachment] : [])),
      attachmentBatch: items => ({ id: 'fixture-batch', items }),
      sendAttachmentBatch: (...args) => { uploads.push(args); return options.uploadError ? Promise.reject(Error('transfer failed')) : Promise.resolve({ files: args[1].items.map(item => ({name:item.name,bytes:item.size})), ...options.receipt }); },
    },
    '../lib/connection': { COMPUTER: 'https://computer.test/', Connection: FakeConnection },
    '../lib/video': { startVideo },
    '../lib/updates': { UpdateLifecycle: FakeUpdateLifecycle },
    '../lib/preview-lifecycle': { PreviewLifecycle: FakePreviewLifecycle },
  };

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
      tree = Control();
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

  for (const node of h.all('KeyboardAvoidingView').concat(h.all('View'), h.all('TouchSurface'))) {
    const style = node.props?.style;
    if (!style || typeof style !== 'object' || Array.isArray(style)) continue;
    assert.equal(style.paddingTop, undefined, 'video ancestors must not add top inset padding');
    assert.equal(style.paddingBottom, undefined, 'video ancestors must not add bottom inset padding');
  }
});

test('landscape preview hides portrait controls, and rail show/hide does not restart video or send input', () => {
  const h = harness();
  h.reportConnection('connected');
  h.find('GlassButton', 'Ver pantalla').props.onPress();
  h.render();
  assert.equal(h.startVideoCount(), 1);
  const lifecycle = h.previews[0];
  const updateCount = lifecycle.updateCalls.length;
  const commandCount = h.commands.length;

  h.setDimensions(844, 390);
  const native = h.find('NativeKeyboard');
  const rail = h.find('LandscapeControls');
  assert.equal(native.props.visible, false);
  assert.equal(rail.props.visible, false);
  assert.equal(h.find('GlassButton', 'Reconectar'), undefined);
  assert.equal(h.find('GlassButton', 'Ver pantalla'), undefined);

  rail.props.show();
  h.render();
  assert.equal(h.find('LandscapeControls').props.visible, true);
  assert.equal(h.commands.length, commandCount);
  assert.equal(lifecycle.restartCount, 0);
  assert.equal(lifecycle.updateCalls.length, updateCount);
  assert.equal(h.startVideoCount(), 1);

  h.find('LandscapeControls').props.hide();
  h.render();
  assert.equal(h.find('LandscapeControls').props.visible, false);
  assert.equal(h.commands.length, commandCount);
  assert.equal(lifecycle.restartCount, 0);
  assert.equal(lifecycle.updateCalls.length, updateCount);
  assert.equal(h.startVideoCount(), 1);
});

test('landscape rail keyboard opens the explicit input and showing or hiding the rail hides it again', () => {
  const h = harness();
  h.reportConnection('connected');
  h.find('GlassButton', 'Ver pantalla').props.onPress();
  h.render();
  h.setDimensions(844, 390);

  h.find('LandscapeControls').props.show();
  h.render();
  assert.equal(h.find('LandscapeControls').props.visible, true);
  h.find('LandscapeControls').props.openKeyboard();
  h.render();
  assert.equal(h.find('NativeKeyboard').props.active, true);
  assert.equal(h.find('NativeKeyboard').props.visible, true);
  assert.equal(h.find('LandscapeControls').props.visible, false);

  h.find('LandscapeControls').props.show();
  h.render();
  assert.equal(h.find('NativeKeyboard').props.active, false);
  assert.equal(h.find('NativeKeyboard').props.visible, false);
  assert.equal(h.find('LandscapeControls').props.visible, true);

  h.find('LandscapeControls').props.hide();
  h.render();
  assert.equal(h.find('NativeKeyboard').props.visible, false);
  assert.equal(h.find('LandscapeControls').props.visible, false);
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

test('closed composer ignores stale native keyboard spacing through repeated rotations', () => {
  const h = harness();
  h.reportConnection('connected');
  h.find('GlassButton', 'Ver pantalla').props.onPress();
  h.render();
  const rtcPath = h.findPath('RTCView');
  for (let cycle = 0; cycle < 3; cycle++) {
    h.find('NativeKeyboard').props.open(); h.render();
    assert.equal(h.find('KeyboardAvoidingView'), undefined, 'keyboard adjustment must never wrap the video');
    h.setDimensions(844, 390);
    assert.equal(h.find('NativeKeyboard').props.active, false);
    assert.equal(h.find('NativeKeyboard').props.visible, false);
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

test('rotation also clears keyboard space with the preview off; explicit reopening still works', () => {
  const h = harness(); h.reportConnection('connected');
  h.find('NativeKeyboard').props.open(); h.render();
  h.setDimensions(844, 390);
  assert.equal(h.find('NativeKeyboard').props.active, false);
  assert.equal(h.find('KeyboardAvoidingView'), undefined);
  h.find('NativeKeyboard').props.open(); h.render();
  assert.equal(h.find('KeyboardAvoidingView'), undefined, 'keyboard adjustment must never wrap the video');
  h.find('NativeKeyboard').props.close(); h.render();
  assert.equal(h.find('KeyboardAvoidingView'), undefined);
});

const photo = { uri: 'file:///selected.jpg', name: 'Foto.jpg', type: 'image/jpeg' };
const delivered = { name: 'Foto-123.jpg', bytes: 123, folder: 'Downloads/Phonepad', clipboard: 'ready', clipboardKind: 'image' };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('photo upload prepares paste but sends no input until the user chooses Pegar ahora', async () => {
  const h = harness({ attachment: photo, receipt: delivered });
  h.reportConnection('connected');
  h.find('NativeKeyboard').props.choose('camera');
  await settle();
  h.render();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.alerts[0][0], 'Listo para pegar');
  assert.equal(h.commands.length, 0, 'upload must never paste or submit automatically');
  h.alerts[0][2].find(button => button.text === 'Pegar ahora').onPress();
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0].command.key, 'v');
  assert.deepEqual(Array.from(h.commands[0].command.mods), ['ctrl']);
  assert.equal(h.commands.some(entry => entry.command?.key === 'Enter'), false);
});

test('saved upload without clipboard readiness never offers a misleading paste action', async () => {
  const h = harness({ attachment: photo, receipt: { ...delivered, clipboard: 'unavailable' } });
  h.find('NativeKeyboard').props.choose('files');
  await settle();
  assert.equal(h.alerts[0][0], 'Guardado en la laptop');
  assert.equal(h.alerts[0][2], undefined);
  assert.equal(h.commands.length, 0);
});

test('canceling the phone picker does not upload or report success', async () => {
  const h = harness();
  h.find('NativeKeyboard').props.choose('photos');
  await settle();
  h.render();
  assert.equal(h.uploads.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.find('NativeKeyboard').props.choosing, false);
});

test('a failed paste command tells the user to reconnect and does not send Enter', async () => {
  const h = harness({ attachment: photo, receipt: delivered, sendSucceeds: false });
  h.find('NativeKeyboard').props.choose('camera');
  await settle();
  h.alerts[0][2].find(button => button.text === 'Pegar ahora').onPress();
  assert.equal(h.alerts[1][0], 'Reconectá la laptop');
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0].command.key, 'v');
});

test('multiple selected files form one batch and one explicit paste action',async()=>{
 const h=harness({attachments:[photo,{...photo,name:'second.jpg'}],receipt:delivered});
 h.reportConnection('connected');h.find('NativeKeyboard').props.choose('photos');await settle();h.render();
 assert.equal(h.uploads.length,1);assert.equal(h.uploads[0][1].items.length,2);assert.equal(h.commands.length,0);
 assert.equal(h.alerts[0][0],'Listo para pegar');
});
test('lost batch response retains a retry with the same batch identity',async()=>{
 const h=harness({attachments:[photo],uploadError:true});
 h.find('NativeKeyboard').props.choose('photos');await settle();h.render();
 const first=h.uploads[0][1];
 const retry=h.all('GlassButton').find(n=>n.props.label==='Reintentar lote');
 assert.ok(retry);retry.props.onPress();await settle();h.render();
 assert.equal(h.uploads[1][1],first);assert.equal(h.commands.length,0);
});
