import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
if (args.length !== 3) throw Error('Usage: node tools/verify-native-update.mjs EXPORT PUBLICATION REPORT');
const config = JSON.parse(await readFile(new URL('../mobile/app.json', import.meta.url), 'utf8')).expo;
const channel = config.updates?.requestHeaders?.['expo-channel-name'];
if (!config.updates?.enabled || !config.updates.url || !channel)
  throw Error('Configure your own EAS project, update URL and channel in mobile/app.json first.');
const updateURL = new URL(config.updates.url);
if (updateURL.protocol !== 'https:' || updateURL.hostname !== 'u.expo.dev' ||
    !/^\/[0-9a-f-]{36}$/i.test(updateURL.pathname) || updateURL.username || updateURL.password ||
    updateURL.search || updateURL.hash)
  throw Error('Unexpected update destination');
const [exportDir, publicationPath, reportDir] = args.map(p => resolve(p));
const publication = JSON.parse(await readFile(publicationPath, 'utf8'));
const expected = Array.isArray(publication) ? publication.find(p => p.platform === 'ios') : publication;
if (!expected?.id || !expected.runtimeVersion) throw Error('Missing iOS publication identity');
const metadata = JSON.parse(await readFile(resolve(exportDir, 'metadata.json'), 'utf8')).fileMetadata.ios;
const local = new Map();
for (const path of [metadata.bundle, ...metadata.assets.map(a => a.path)]) {
  const bytes = await readFile(resolve(exportDir, path));
  local.set(createHash('sha256').update(bytes).digest('base64url'), { bytes, path });
}
const response = await fetch(updateURL, {
  headers: { 'expo-platform': 'ios', 'expo-runtime-version': expected.runtimeVersion,
    'expo-channel-name': channel, 'expo-protocol-version': '1',
    accept: 'multipart/mixed,application/expo+json,application/json' },
  signal: AbortSignal.timeout(30000), redirect: 'error',
});
if (!response.ok) throw Error(`Manifest HTTP ${response.status}`);
const contentType = response.headers.get('content-type') || '';
let manifest, extensions = {};
if (contentType.startsWith('multipart/')) {
  const form = await new Response(await response.arrayBuffer(), {
    headers: { 'content-type': contentType.replace('multipart/mixed', 'multipart/form-data') },
  }).formData();
  const partText = async value => typeof value === 'string' ? value : await value.text();
  manifest = JSON.parse(await partText(form.get('manifest')));
  if (form.has('extensions')) extensions = JSON.parse(await partText(form.get('extensions')));
} else manifest = await response.json();
if (manifest.id !== expected.id || manifest.runtimeVersion !== expected.runtimeVersion)
  throw Error('Channel does not serve the expected update/runtime');

const integrity = [];
for (const asset of [manifest.launchAsset, ...manifest.assets]) {
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.hostname !== 'assets.eascdn.net' || url.username || url.password)
    throw Error('Unexpected asset destination');
  // Transient CDN request headers stay in memory, never in logs or reports.
  const res = await fetch(url, { headers: extensions.assetRequestHeaders?.[asset.key] || {},
    signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!res.ok) throw Error(`Asset HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('base64url');
  const original = local.get(hash);
  if (hash !== asset.hash || !original || !bytes.equals(original.bytes)) throw Error('Asset mismatch');
  integrity.push({ path: original.path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}
if (integrity.length !== local.size) throw Error('Missing exported assets');
await mkdir(reportDir, { recursive: true });
const report = { updateId: manifest.id, runtimeVersion: manifest.runtimeVersion, channel,
  httpStatus: response.status, filesVerified: integrity.length,
  bytesVerified: integrity.reduce((n, item) => n + item.bytes, 0), remoteMatchesLocal: true,
  installedOnDevice: false, transport: 'Node fetch default client' };
await writeFile(resolve(reportDir, 'delivery.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(resolve(reportDir, 'integrity.json'), JSON.stringify(integrity, null, 2) + '\n');
console.log(JSON.stringify(report));
