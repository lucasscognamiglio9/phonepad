const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function loadHostSettings(
  expoFileSystem = { File: class {}, Paths: { document: {} } },
  expoCrypto = { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
) {
  const source = ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/lib/host-settings.ts'), 'utf8',
  ), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: name => {
      if (name === 'expo-file-system') return expoFileSystem;
      if (name === 'expo-crypto') return expoCrypto;
      throw new Error(`Unexpected module: ${name}`);
    },
    URL,
    console,
  });
  return exports;
}

function memoryStorage(initial = null, failWrite = false) {
  let value = initial;
  return {
    readText: async () => value,
    writeTextAtomically: async text => {
      if (failWrite) throw new Error('simulated persistence failure');
      value = text;
    },
    get value() { return value; },
  };
}

test('normalizes only HTTPS origins and rejects credentials, paths, queries and fragments', () => {
  const { normalizeHostOrigin } = loadHostSettings();
  assert.equal(normalizeHostOrigin('  HTTPS://Example.com/  '), 'https://example.com');
  assert.equal(normalizeHostOrigin('https://example.com:8443'), 'https://example.com:8443');
  for (const value of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/control',
    'https://example.com/./',
    'https://example.com\\control',
    'https:example.com',
    'https://example.com?token=secret',
    'https://example.com#fragment',
    'example.com',
  ]) assert.throws(() => normalizeHostOrigin(value));
});

test('loads a persisted v1 fixture with two hosts and resolves the selected origin', async () => {
  const { createHostSettingsAdapter, loadSelectedHost, selectHost } = loadHostSettings();
  const storage = memoryStorage(JSON.stringify({
    version: 1,
    devices: [
      { id: 'mac', name: 'Mac de prueba', origin: 'https://mac.example' },
      { id: 'android', name: 'Android de prueba', origin: 'https://android.example:8443' },
    ],
    selected: 'android',
  }));
  const adapter = createHostSettingsAdapter(storage);
  const result = await loadSelectedHost(adapter);
  assert.equal(result.error, undefined);
  assert.equal(result.settings.devices.length, 2);
  assert.equal(result.origin, 'https://android.example:8443');
  const switched = selectHost(result.settings, 'mac');
  const saved = await adapter.save(switched);
  assert.equal(saved.ok, true);
  assert.equal((await loadSelectedHost(adapter)).origin, 'https://mac.example');
});

test('failed persistence returns a recoverable result and keeps the in-memory fixture usable', async () => {
  const { addHost, createDefaultHostSettings, createHostSettingsAdapter } = loadHostSettings();
  const storage = memoryStorage(null, true);
  const adapter = createHostSettingsAdapter(storage);
  const settings = addHost(createDefaultHostSettings(), { id: 'linux', name: 'Linux', origin: 'https://linux.example' });
  const result = await adapter.save(settings);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'write-failed');
  assert.equal(storage.value, null);
  assert.equal(settings.selected, 'linux');
});

test('serializes concurrent saves and rejects the stale second state without losing selection', async () => {
  const { addHost, createDefaultHostSettings, createHostSettingsAdapter } = loadHostSettings();
  const storage = memoryStorage();
  const adapter = createHostSettingsAdapter(storage);
  const first = addHost(createDefaultHostSettings(), { id: 'one', name: 'Uno', origin: 'https://one.example' });
  const second = addHost(createDefaultHostSettings(), { id: 'two', name: 'Dos', origin: 'https://two.example' });
  const [savedFirst, savedSecond] = await Promise.all([adapter.save(first), adapter.save(second)]);
  assert.equal(savedFirst.ok, true);
  assert.equal(savedSecond.ok, false);
  assert.equal(savedSecond.error.code, 'stale-settings');
  const loaded = await adapter.load();
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.settings.devices.map(device => device.id))), ['one']);
  assert.equal(loaded.settings.selected, 'one');
});

test('removing the selected host leaves selection empty until the user chooses another', () => {
  const { addHost, createDefaultHostSettings, removeHost } = loadHostSettings();
  const first = addHost(createDefaultHostSettings(), { id: 'one', name: 'Uno', origin: 'https://one.example' });
  const both = addHost(first, { id: 'two', name: 'Dos', origin: 'https://two.example' });
  const removed = removeHost(both, 'one');
  assert.equal(removed.selected, null);
  assert.deepEqual(JSON.parse(JSON.stringify(removed.devices.map(device => device.id))), ['two']);
});

test('malformed persisted data falls back to an empty recoverable state', async () => {
  const { createHostSettingsAdapter } = loadHostSettings();
  const adapter = createHostSettingsAdapter(memoryStorage('{"version":99,"devices":[]}'));
  const result = await adapter.load();
  assert.equal(result.settings.devices.length, 0);
  assert.equal(result.settings.selected, null);
  assert.equal(result.error.code, 'invalid-settings');
});

test('Expo SDK 57 provider journals two slots and recovers when a move deletes its target first', async () => {
  const entries = new Map();
  let failNextMove = false;
  let textReads = 0;
  const uri = value => typeof value === 'string' ? value : value.uri;
  class MockFile {
    constructor(parent, name) { this.uri = `${uri(parent)}/${name}`; }
    get exists() { return entries.has(this.uri); }
    get size() { return String(entries.get(this.uri) ?? '').length; }
    text() { textReads += 1; return Promise.resolve(entries.get(this.uri)); }
    write(text) { entries.set(this.uri, text); }
    delete() { entries.delete(this.uri); }
    async move(destination, options) {
      if (entries.has(destination.uri) && !options?.overwrite) throw new Error('destination exists');
      if (failNextMove) {
        failNextMove = false;
        entries.delete(destination.uri);
        throw new Error('simulated move failure after deleting destination');
      }
      entries.set(destination.uri, entries.get(this.uri));
      entries.delete(this.uri);
      this.uri = destination.uri;
    }
  }
  const {
    createExpoHostSettingsStorage,
    createHostSettingsAdapter,
    addHost,
    createDefaultHostSettings,
    HOST_SETTINGS_FILE_NAME,
    HOST_SETTINGS_SLOT_A_FILE_NAME,
    HOST_SETTINGS_SLOT_B_FILE_NAME,
    HOST_SETTINGS_TEMP_FILE_NAME,
    MAX_HOST_SETTINGS_BYTES,
  } = loadHostSettings({
    File: MockFile,
    Paths: { document: { uri: 'document' } },
  });
  const storage = createExpoHostSettingsStorage();
  const first = '{"version":1,"devices":[],"selected":null,"revision":1}';
  const second = '{"version":1,"devices":[],"selected":null,"revision":2}';
  await storage.writeTextAtomically(first);
  await storage.writeTextAtomically(second);
  assert.equal(entries.get(`document/${HOST_SETTINGS_SLOT_A_FILE_NAME}`), first);
  assert.equal(entries.get(`document/${HOST_SETTINGS_SLOT_B_FILE_NAME}`), second);
  assert.equal(entries.has(`document/${HOST_SETTINGS_TEMP_FILE_NAME}`), false);

  failNextMove = true;
  await assert.rejects(storage.writeTextAtomically('{"version":1,"devices":[],"selected":null,"revision":3}'));
  assert.equal(await storage.readText(), second);
  assert.equal(entries.get(`document/${HOST_SETTINGS_SLOT_B_FILE_NAME}`), second);

  const corrupt = '{"version":99,"devices":[],"selected":null}';
  entries.set(`document/${HOST_SETTINGS_SLOT_A_FILE_NAME}`, first);
  entries.set(`document/${HOST_SETTINGS_SLOT_B_FILE_NAME}`, corrupt);
  const { createHostSettingsAdapter: createCrossRealmHostSettingsAdapter } = loadHostSettings({ File: MockFile, Paths: { document: { uri: 'document' } } });
  const adapter = createCrossRealmHostSettingsAdapter(storage);
  const loaded = await adapter.load();
  assert.equal(loaded.error, undefined);
  const blocked = await adapter.save(loaded.settings);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'invalid-settings');
  assert.equal(entries.get(`document/${HOST_SETTINGS_SLOT_B_FILE_NAME}`), corrupt);

  entries.delete(`document/${HOST_SETTINGS_SLOT_A_FILE_NAME}`);
  entries.delete(`document/${HOST_SETTINGS_SLOT_B_FILE_NAME}`);
  entries.set(`document/${HOST_SETTINGS_FILE_NAME}`, corrupt);
  await assert.rejects(
    storage.writeTextAtomically(first),
    /snapshot desconocido/,
  );
  assert.equal(entries.get(`document/${HOST_SETTINGS_FILE_NAME}`), corrupt);
  entries.delete(`document/${HOST_SETTINGS_FILE_NAME}`);

  entries.delete(`document/${HOST_SETTINGS_SLOT_A_FILE_NAME}`);
  entries.delete(`document/${HOST_SETTINGS_SLOT_B_FILE_NAME}`);
  const adapterA = createHostSettingsAdapter(storage);
  const adapterB = createHostSettingsAdapter(storage);
  const stateA = addHost(createDefaultHostSettings(), {
    id: 'adapter-a', name: 'Adaptador A', origin: 'https://adapter-a.example',
  });
  const stateB = addHost(createDefaultHostSettings(), {
    id: 'adapter-b', name: 'Adaptador B', origin: 'https://adapter-b.example',
  });
  const [savedA, savedB] = await Promise.all([adapterA.save(stateA), adapterB.save(stateB)]);
  assert.equal(savedA.ok, true);
  assert.equal(savedB.ok, false);
  assert.equal(savedB.error.code, 'stale-settings');
  const afterConcurrentAdapters = await storage.readText();
  assert.match(afterConcurrentAdapters, /adapter-a/);

  entries.delete(`document/${HOST_SETTINGS_SLOT_A_FILE_NAME}`);
  entries.set(`document/${HOST_SETTINGS_SLOT_B_FILE_NAME}`, 'x'.repeat(MAX_HOST_SETTINGS_BYTES + 1));
  const readsBeforeOversize = textReads;
  await assert.rejects(storage.readText(), /demasiado grande/);
  assert.equal(textReads, readsBeforeOversize);
});
