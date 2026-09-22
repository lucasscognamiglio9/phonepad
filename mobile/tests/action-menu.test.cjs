const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const actions = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(
  path.join(__dirname, '../src/lib/actions.ts'), 'utf8',
), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: actions });

function loadActionMenu(overrides = {}) {
  const source = ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/components/action-menu.tsx'), 'utf8',
  ), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const styles = { absoluteFill: { position: 'absolute' }, create: value => value };
  const modules = {
    react: {
      useCallback: value => value,
      useEffect: () => {},
      useMemo: value => value(),
      useRef: initial => ({ current: initial }),
      useState: initial => [initial, () => {}],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    'react-native': {
      InteractionManager: { runAfterInteractions: callback => callback() },
      Keyboard: { addListener: () => ({ remove: () => {} }) },
      Modal: 'Modal',
      Platform: { OS: 'ios' },
      Pressable: 'Pressable',
      StyleSheet: styles,
      Text: 'Text',
      View: 'View',
      useWindowDimensions: () => ({ width: 390, height: 844 }),
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) },
    './action-icon': { ActionIcon: 'ActionIcon' },
    '../lib/actions': actions,
    'react-native-reanimated': {
      default: { View: 'AnimatedView' },
      Easing: { out: value => value, cubic: value => value },
      ReduceMotion: { System: 'system' },
      useAnimatedStyle: () => ({}),
      useSharedValue: value => ({ value }),
      withTiming: value => value,
    },
    'react-native-screens': { FullWindowOverlay: 'FullWindowOverlay' },
    './glass-surface': { GlassSurface: 'GlassSurface' },
    '../lib/attachments': {},
  };
  Object.assign(modules, overrides);
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: name => modules[name],
    Number,
    setTimeout,
    clearTimeout,
  });
  return exports;
}

const { getActionMenuLayout, ACTION_MENU_HEIGHT, ACTION_MENU_WIDTH } = loadActionMenu();
const insets = { top: 54, right: 0, bottom: 34, left: 0 };

test('returns no popup layout while the anchor is hidden', () => {
  assert.equal(getActionMenuLayout(null, { width: 390, height: 844 }, insets), null);
});

test('keeps the popup above the composer and inside horizontal safe-area margins', () => {
  const layout = getActionMenuLayout(
    { x: 180, y: 730, width: 44, height: 44 },
    { width: 390, height: 844 },
    insets,
  );
  assert.equal(layout.left, 78);
  assert.equal(layout.top, 548);
  assert.ok(layout.originX > 0 && layout.originX < ACTION_MENU_WIDTH);
  assert.ok(layout.originY > 0 && layout.originY < ACTION_MENU_HEIGHT);
});

test('moves below a high anchor and clamps to the keyboard top when needed', () => {
  const below = getActionMenuLayout(
    { x: 30, y: 70, width: 44, height: 44 },
    { width: 390, height: 844 },
    insets,
  );
  assert.equal(below.top, 124);
  assert.equal(below.left, 12);

  const aboveKeyboard = getActionMenuLayout(
    { x: 180, y: 700, width: 44, height: 44 },
    { width: 390, height: 844 },
    insets,
    350,
  );
  assert.equal(aboveKeyboard.top, 310);
  assert.ok(aboveKeyboard.top + ACTION_MENU_HEIGHT <= 844 - 350 - 12);
});

test('short landscape uses a smaller scrollable frame above the keyboard and inside notch margins', () => {
  const layout = getActionMenuLayout(
    { x: 60, y: 142, width: 44, height: 44 },
    { width: 844, height: 390 },
    { top: 0, left: 59, right: 59, bottom: 21 },
    215,
  );
  assert.ok(layout.height < ACTION_MENU_HEIGHT);
  assert.ok(layout.top >= 12);
  assert.ok(layout.top + layout.height <= 390 - 215 - 12);
  assert.ok(layout.left >= 59 + 12);
  assert.ok(layout.left + ACTION_MENU_WIDTH <= 844 - 59 - 12);
});

test('narrow windows reduce popup width to stay between safe-area margins', () => {
  const layout = getActionMenuLayout(
    { x: 12, y: 220, width: 44, height: 44 },
    { width: 220, height: 480 },
    { top: 0, right: 18, bottom: 0, left: 18 },
  );
  assert.ok(layout.width < ACTION_MENU_WIDTH);
  assert.ok(layout.left >= 30);
  assert.ok(layout.left + layout.width <= 220 - 18 - 12);
  assert.ok(layout.originX >= 0 && layout.originX <= layout.width);
});

function componentHarness(initialAnchor, platform = 'ios') {
  const slots = [];
  const effects = [];
  const listeners = {};
  let hookIndex = 0;
  let tree;
  const state = { anchor: initialAnchor };
  const props = {
    anchor: state.anchor,
    close: () => { state.anchor = null; props.closeCalls += 1; },
    choose: action => props.chosen.push(action),
    onDismiss: () => props.dismissed += 1,
    closeCalls: 0,
    chosen: [],
    dismissed: 0,
  };
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => value === right[index]);
  const react = {
    useCallback(callback, deps) {
      const at = hookIndex++;
      if (!slots[at] || !sameDeps(slots[at].deps, deps)) slots[at] = { deps, callback };
      return slots[at].callback;
    },
    useEffect(callback, deps) {
      const at = hookIndex++;
      if (!slots[at] || !sameDeps(slots[at], deps)) {
        slots[at] = deps;
        effects.push(callback);
      }
    },
    useMemo(callback, deps) {
      const at = hookIndex++;
      if (!slots[at] || !sameDeps(slots[at].deps, deps)) slots[at] = { deps, value: callback() };
      return slots[at].value;
    },
    useRef(initial) {
      const at = hookIndex++;
      return slots[at] ??= { current: initial };
    },
    useState(initial) {
      const at = hookIndex++;
      if (!(at in slots)) slots[at] = initial;
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }];
    },
  };
  const modules = {
    react,
    'react-native': {
      InteractionManager: { runAfterInteractions: callback => callback() },
      Keyboard: { addListener: (event, callback) => { listeners[event] = callback; return { remove: () => delete listeners[event] }; } },
      Modal: 'Modal',
      Platform: { OS: platform },
      Pressable: 'Pressable',
      ScrollView: 'ScrollView',
      StyleSheet: { absoluteFill: { position: 'absolute' }, create: value => value },
      Text: 'Text',
      View: 'View',
      useWindowDimensions: () => ({ width: 390, height: 844 }),
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 54, right: 0, bottom: 34, left: 0 }) },
    './action-icon': { ActionIcon: 'ActionIcon' },
    '../lib/actions': actions,
    'react-native-reanimated': {
      default: { View: 'AnimatedView' },
      Easing: { out: value => value, cubic: value => value },
      ReduceMotion: { System: 'system' },
      useAnimatedStyle: callback => callback(),
      useSharedValue: value => react.useRef({ value }).current,
      withTiming: value => value,
    },
    './glass-surface': { GlassSurface: 'GlassSurface' },
    '../lib/attachments': {},
    'react-native-screens': { FullWindowOverlay: 'FullWindowOverlay' },
    'react/jsx-runtime': {
      jsx: (type, properties) => ({ type, props: properties }),
      jsxs: (type, properties) => ({ type, props: properties }),
    },
  };
  const componentExports = loadActionMenu(modules);
  const nodes = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  };
  const find = predicate => nodes(tree).find(predicate);
  const render = () => {
    hookIndex = 0;
    props.anchor = state.anchor;
    tree = componentExports.ActionMenu(props);
    while (effects.length) effects.shift()();
  };
  render();
  return { props, state, find, render, listeners };
}

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test('iOS uses a window overlay and waits for it to hide before choosing an attachment', async () => {
  const h = componentHarness({ x: 170, y: 730, width: 44, height: 44 });
  const rows = h.find(node => node.type === 'ScrollView');
  assert.equal(rows.props.keyboardShouldPersistTaps, 'always', 'an open keyboard must not consume the first option tap');
  assert.equal(rows.props.keyboardDismissMode, 'none');
  const action = h.find(node => node.type === 'Pressable' && node.props.testID === 'phonepad-action-files');
  assert.ok(action);
  action.props.onPress();
  h.render();
  assert.deepEqual(h.props.chosen, []);
  assert.equal(h.props.closeCalls, 1);
  assert.equal(h.find(node => node.type === 'FullWindowOverlay'), undefined, 'closing removes the native window host immediately');
  assert.equal(h.find(node => node.type === 'Modal'), undefined);
  await nextTurn();
  assert.deepEqual(h.props.chosen, ['files']);
  assert.equal(h.props.dismissed, 0);
});

test('outside press is consumed by the overlay and ordinary dismissal is one-shot', async () => {
  const h = componentHarness({ x: 170, y: 730, width: 44, height: 44 });
  const overlay = h.find(node => node.type === 'FullWindowOverlay');
  assert.equal(overlay.props.unstable_accessibilityContainerViewIsModal, true);
  const backdrop = h.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === 'Cerrar acciones');
  assert.ok(backdrop);
  backdrop.props.onPress();
  h.render();
  assert.equal(h.props.closeCalls, 1);
  assert.deepEqual(h.props.chosen, []);
  await nextTurn();
  h.render();
  await nextTurn();
  assert.equal(h.props.dismissed, 1);
});

test('a late dismissal from the previous overlay cannot affect a newly opened cycle', async () => {
  const h = componentHarness({ x: 170, y: 730, width: 44, height: 44 });
  const action = h.find(node => node.type === 'Pressable' && node.props.testID === 'phonepad-action-files');
  action.props.onPress();
  h.render();
  h.state.anchor = { x: 170, y: 730, width: 44, height: 44 };
  h.render();
  await nextTurn();
  assert.deepEqual(h.props.chosen, []);
  assert.equal(h.props.dismissed, 0);
});

test('Android keeps the transparent over-full-screen Modal dismissal contract', async () => {
  const h = componentHarness({ x: 170, y: 730, width: 44, height: 44 }, 'android');
  const modal = h.find(node => node.type === 'Modal');
  assert.equal(modal.props.presentationStyle, 'overFullScreen');
  assert.equal(modal.props.transparent, true);
  const action = h.find(node => node.type === 'Pressable' && node.props.testID === 'phonepad-action-photos');
  action.props.onPress();
  h.render();
  assert.deepEqual(h.props.chosen, []);
  modal.props.onDismiss();
  assert.deepEqual(h.props.chosen, ['photos']);
  await nextTurn();
});
