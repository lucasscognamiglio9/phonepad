const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load({ documents = {}, photos = {}, sendError = false } = {}) {
  const requests = [];
  const photoModule = {
    UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
    ...photos,
  };
  class Request {
    upload = {};
    headers = {};
    status = 0;
    responseText = '';
    abortCount = 0;
    constructor() { requests.push(this); }
    open(...args) { this.opened = args; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(body) { if (sendError) throw Error('native request failed'); this.body = body; this.sent = true; }
    abort() { this.abortCount++; this.onabort?.(); }
    load(status, body) {
      this.status = status;
      this.responseText = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      this.onload?.();
    }
  }
  class FormDataMock {
    entries = [];
    append(...args) { this.entries.push(args); }
  }
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/attachments.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require: name => name === 'expo-crypto' ? { randomUUID: () => '01234567-0123-4567-8901-012345678901' } : name === 'expo-document-picker' ? documents : photoModule,
    XMLHttpRequest: Request,
    FormData: FormDataMock,
    AbortController,
    Error,
    Promise,
    Number,
    String,
  });
  return { ...exports, requests };
}

const receipt = (overrides = {}) => ({
  name: 'photo-123.jpg', bytes: 7, folder: 'Downloads/Phonepad',
  clipboard: 'ready', clipboardKind: 'image', ...overrides,
});
const json = value => JSON.parse(JSON.stringify(value));

test('a synchronous native send failure cleans callbacks and cannot settle again', async () => {
  const h = load({ sendError: true });
  const controller = new AbortController();
  await assert.rejects(h.sendAttachment('https://host.ts.net', {
    uri: 'file://photo', name: 'photo.jpg', type: 'image/jpeg', size: 7,
  }, controller.signal, () => {}), /iniciar la transferencia/);
  assert.equal(h.requests[0].onload, null);
  assert.equal(h.requests[0].upload.onprogress, null);
  controller.abort();
  assert.equal(h.requests[0].abortCount, 0);
});

test('canceling Files returns no attachment and creates no transfer', async () => {
  let options;
  const h = load({ documents: {
    getDocumentAsync: async value => { options = value; return { canceled: true, assets: null }; },
  } });
  assert.equal(await h.chooseAttachment('files'), null);
  assert.deepEqual(json(options), { multiple: false, copyToCacheDirectory: true });
  assert.equal(h.requests.length, 0);
});

test('Files preserve the native filename and MIME, with safe extension fallback', async () => {
  let options;
  const h = load({ documents: {
    getDocumentAsync: async value => {
      options = value;
      return { canceled: false, assets: [{ uri: 'file:///tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 42 }] };
    },
  } });
  const item = await h.chooseAttachment('files');
  assert.deepEqual(json(options), { multiple: false, copyToCacheDirectory: true });
  assert.deepEqual(json(item), { uri: 'file:///tmp/report.pdf', name: 'report.pdf', type: 'application/pdf', size: 42 });

  const fallback = load({ documents: {
    getDocumentAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///tmp/notes.txt', name: '', size: 3 }] }),
  } });
  assert.equal((await fallback.chooseAttachment('files')).type, 'text/plain');
});

test('Photos use the limited image picker without requesting library or microphone access', async () => {
  let options;
  let libraryPermissionRequests = 0;
  const h = load({ photos: {
    requestMediaLibraryPermissionsAsync: async () => { libraryPermissionRequests++; return { granted: true }; },
    launchImageLibraryAsync: async value => {
      options = value;
      return { canceled: false, assets: [{ uri: 'file:///tmp/IMG.HEIC', fileName: 'IMG.HEIC', mimeType: 'image/heic', fileSize: 7 }] };
    },
  } });
  const item = await h.chooseAttachment('photos');
  assert.deepEqual(Array.from(options.mediaTypes), ['images']);
  assert.equal(options.allowsEditing, false);
  assert.equal(options.quality, 1);
  assert.equal(options.preferredAssetRepresentationMode, 'compatible');
  assert.equal(libraryPermissionRequests, 0);
  assert.deepEqual(json(item), { uri: 'file:///tmp/IMG.HEIC', name: 'IMG.HEIC', type: 'image/heic', size: 7 });
});

test('Photos infer PNG correctly when the native picker omits MIME metadata', async () => {
  const h = load({ photos: {
    launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///tmp/screenshot.PNG', fileSize: 8 }] }),
  } });
  assert.deepEqual(json(await h.chooseAttachment('photos')), {
    uri: 'file:///tmp/screenshot.PNG', name: 'screenshot.PNG', type: 'image/png', size: 8,
  });
});

test('camera denial prevents capture, while unavailable hardware gets a clear error', async () => {
  let launches = 0;
  const denied = load({ photos: {
    requestCameraPermissionsAsync: async () => ({ granted: false }),
    launchCameraAsync: async () => { launches++; return { canceled: true }; },
  } });
  await assert.rejects(denied.chooseAttachment('camera'), /Configuración/);
  assert.equal(launches, 0);

  const unavailable = load({ photos: {
    requestCameraPermissionsAsync: async () => ({ granted: true }),
    launchCameraAsync: async () => { throw { code: 'E_CAMERA_UNAVAILABLE', message: 'No camera device' }; },
  } });
  await assert.rejects(unavailable.chooseAttachment('camera'), /cámara no está disponible/i);
});

test('camera cancellation is harmless and a captured JPEG keeps a matching name and MIME', async () => {
  const canceled = load({ photos: {
    requestCameraPermissionsAsync: async () => ({ granted: true }),
    launchCameraAsync: async () => ({ canceled: true, assets: null }),
  } });
  assert.equal(await canceled.chooseAttachment('camera'), null);

  const h = load({ photos: {
    requestCameraPermissionsAsync: async () => ({ granted: true }),
    launchCameraAsync: async () => ({ canceled: false, assets: [{
      uri: 'file:///tmp/capture', fileName: 'capture.HEIC', mimeType: 'image/jpeg', fileSize: 11,
    }] }),
  } });
  const item = await h.chooseAttachment('camera');
  assert.equal(item.type, 'image/jpeg');
  assert.equal(item.name, 'capture.jpg');
});

test('upload sends the file and intent=clipboard, then returns the ready receipt', async () => {
  const h = load();
  const pending = h.sendAttachment('https://host.ts.net', {
    uri: 'file://photo', name: 'photo.jpg', type: 'image/jpeg', size: 7,
  }, new AbortController().signal, () => {});
  const request = h.requests[0];
  assert.deepEqual(request.opened, ['POST', 'https://host.ts.net/api/files']);
  assert.equal(request.headers.Origin, 'https://host.ts.net');
  assert.equal(request.timeout, 115000);
  assert.equal(request.body.entries[0][0], 'file');
  assert.deepEqual(json(request.body.entries[0][1]), { uri: 'file://photo', name: 'photo.jpg', type: 'image/jpeg' });
  assert.deepEqual(request.body.entries[1], ['intent', 'clipboard']);
  request.load(201, receipt());
  assert.deepEqual(json(await pending), receipt());
});

test('legacy 201 responses are successful but truthfully report clipboard unavailable', async () => {
  const h = load();
  const pending = h.sendAttachment('https://host.ts.net', {
    uri: 'file://a', name: 'a.txt', type: 'text/plain', size: 3,
  }, new AbortController().signal, () => {});
  h.requests[0].load(201, { name: 'a-123.txt', bytes: 3, folder: 'Downloads/Phonepad' });
  assert.deepEqual(json(await pending), { name: 'a-123.txt', bytes: 3, folder: 'Downloads/Phonepad', clipboard: 'unavailable' });
});

test('upload rejects incomplete or malformed receipts instead of claiming success', async () => {
  for (const body of [null, { name: 'a.txt', folder: 'Downloads/Phonepad' }, { name: 'a.txt', bytes: 3 }, '{bad']) {
    const h = load();
    const pending = h.sendAttachment('https://host.ts.net', {
      uri: 'file://a', name: 'a.txt', type: 'text/plain', size: 3,
    }, new AbortController().signal, () => {});
    h.requests[0].load(201, body);
    await assert.rejects(pending, /respuesta (inválida|incompleta)/);
  }
});

test('progress is bounded and duplicate XHR callbacks settle only once', async () => {
  const h = load();
  const updates = [];
  const pending = h.sendAttachment('https://host.ts.net', {
    uri: 'file://a', name: 'a.txt', type: 'text/plain', size: 3,
  }, new AbortController().signal, percent => updates.push(percent));
  const request = h.requests[0];
  request.upload.onprogress({ lengthComputable: true, loaded: 1, total: 3 });
  request.upload.onprogress({ lengthComputable: true, loaded: 5, total: 3 });
  const onload = request.onload;
  request.load(201, receipt({ name: 'a.txt', bytes: 3, clipboard: 'unavailable', clipboardKind: undefined }));
  onload();
  assert.deepEqual(json(await pending), { name: 'a.txt', bytes: 3, folder: 'Downloads/Phonepad', clipboard: 'unavailable' });
  assert.deepEqual(updates, [33, 100]);
});

test('timeout and AbortSignal cancellation reject promptly and remove the active request', async () => {
  const timed = load();
  const timeoutPending = timed.sendAttachment('https://host.ts.net', {
    uri: 'file://a', name: 'a.txt', type: 'text/plain', size: 3,
  }, new AbortController().signal, () => {});
  timed.requests[0].ontimeout();
  await assert.rejects(timeoutPending, /tardó demasiado/);

  const aborted = load();
  const controller = new AbortController();
  const abortPending = aborted.sendAttachment('https://host.ts.net', {
    uri: 'file://a', name: 'a.txt', type: 'text/plain', size: 3,
  }, controller.signal, () => {});
  controller.abort();
  assert.equal(aborted.requests[0].abortCount, 1);
  await assert.rejects(abortPending, /cancelada/);
});

test('oversized files fail before opening any request and non-success statuses remain errors', async () => {
  const h = load();
  await assert.rejects(h.sendAttachment('https://host.ts.net', {
    uri: 'file://large', name: 'large.bin', type: 'application/octet-stream', size: 100 * 1024 * 1024 + 1,
  }, new AbortController().signal, () => {}), /100 MB/);
  assert.equal(h.requests.length, 0);

  const failed = load();
  const pending = failed.sendAttachment('https://host.ts.net', {
    uri: 'file://a', name: 'a.txt', type: 'text/plain', size: 3,
  }, new AbortController().signal, () => {});
  failed.requests[0].load(401, 'unauthorized');
  await assert.rejects(pending, /autorizado/);
});

test('multiple photos preserve order, names and full list with the native picker', async () => {
  let options;
  const h=load({photos:{launchImageLibraryAsync:async value=>{options=value;return {canceled:false,assets:[
    {uri:'file://b',fileName:'b.HEIC',mimeType:'image/heic',fileSize:2},
    {uri:'file://a',fileName:'a.PNG',mimeType:'image/png',fileSize:3},
  ]};}}});
  const items=await h.chooseAttachments('photos');
  assert.deepEqual(Array.from(items,item=>item.name),['b.HEIC','a.PNG']);
  assert.equal(options.allowsMultipleSelection,true);assert.equal(options.orderedSelection,true);assert.equal(options.selectionLimit,20);
});
test('multiple documents keep every selection; exceeding the limit is explicit',async()=>{
  const h=load({documents:{getDocumentAsync:async options=>{assert.equal(options.multiple,true);return {canceled:false,assets:[
    {uri:'file://one',name:'one.txt'},{uri:'file://two',name:'two.txt'},
  ]};}}});
  assert.equal((await h.chooseAttachments('files')).length,2);
  const many=load({documents:{getDocumentAsync:async()=>({canceled:false,assets:Array.from({length:21},()=>({uri:'file://a',name:'a.txt'}))})}});
  await assert.rejects(many.chooseAttachments('files'),/20 archivos/);
});
test('batch upload sends manifest before all files and checks count and identity in receipt',async()=>{
 const h=load();const items=[{uri:'file://a',name:'a.png',type:'image/png',size:3},{uri:'file://b',name:'b.png',type:'image/png',size:4}];
 const batch=h.attachmentBatch(items);
 const pending=h.sendAttachmentBatch('https://host',batch,new AbortController().signal,()=>{});
 const request=h.requests[0];assert.equal(request.opened[1],'https://host/api/file-batches');
 assert.deepEqual(request.body.entries.map(entry=>entry[0]),['manifest','file-0','file-1']);
 assert.equal(JSON.parse(request.body.entries[0][1]).files.length,2);
 request.load(201,{version:1,id:batch.id,folder:'Downloads/Phonepad',clipboard:'ready',files:items.map(item=>({name:item.name,bytes:item.size,sha256:'a'.repeat(64)}))});
 assert.equal((await pending).files.length,2);
 const invalid=h.sendAttachmentBatch('https://host',batch,new AbortController().signal,()=>{});
 h.requests[1].load(201,{version:1,id:'wrong',files:[],folder:'x',clipboard:'ready'});
 await assert.rejects(invalid,/verificar el lote/);
});
test('batch retry preserves operation identity after a missing response',async()=>{
 const h=load();const batch=h.attachmentBatch([{uri:'file://a',name:'a.txt',type:'text/plain',size:3}]);
 const first=h.sendAttachmentBatch('https://host',batch,new AbortController().signal,()=>{});
 h.requests[0].onerror();await assert.rejects(first,/selección/);
 const second=h.sendAttachmentBatch('https://host',batch,new AbortController().signal,()=>{});
 assert.equal(h.requests[0].body.entries[0][1],h.requests[1].body.entries[0][1]);
 h.requests[1].load(200,{version:1,id:batch.id,folder:'Downloads/Phonepad',clipboard:'ready',replayed:true,files:[{name:'a.txt',bytes:3,sha256:'a'.repeat(64)}]});
 assert.equal((await second).replayed,true);
});
