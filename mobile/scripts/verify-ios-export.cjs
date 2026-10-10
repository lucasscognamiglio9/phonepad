const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function verifyIOSExport(exportDir, projectRoot) {
  const root = path.resolve(exportDir);
  const sourceRoot = path.resolve(projectRoot);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
  const entry = metadata.fileMetadata?.ios?.bundle;
  if (typeof entry !== 'string') throw Error('Missing iOS bundle metadata');
  const bundle = path.resolve(root, entry);
  if (!bundle.startsWith(root + path.sep)) throw Error('Bundle is outside export directory');
  const map = JSON.parse(fs.readFileSync(bundle + '.map', 'utf8'));
  const matched = new Set();
  for (let index = 0; index < map.sources.length; index++) {
    const name = map.sources[index];
    // Metro's generated require.context module is not a source file.
    if (!name.startsWith('/src/') || !/\.[cm]?[jt]sx?$/.test(name)) continue;
    const file = path.resolve(sourceRoot, '.' + name);
    if (!file.startsWith(sourceRoot + path.sep) || !fs.existsSync(file)
        || fs.readFileSync(file, 'utf8') !== map.sourcesContent?.[index]) {
      throw Error(`Export contains stale or unexpected source: ${name}`);
    }
    matched.add(name);
  }
  for (const name of ['/src/screens/control.tsx', '/src/components/native-keyboard.tsx',
    '/src/components/session-options.tsx', '/src/components/attachment-transfer.tsx', '/src/lib/updates.ts']) {
    if (!matched.has(name)) throw Error(`Missing current PhonePad source: ${name}`);
  }
  const bytes = fs.readFileSync(bundle);
  if (bytes.subarray(0, 8).toString('hex') !== 'c61fbc03c103191f') throw Error('Bundle is not Hermes bytecode');
  return { bundle: entry, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), matchedSourceFiles: matched.size };
}

module.exports = { verifyIOSExport };
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(verifyIOSExport(process.argv[2], process.argv[3] || path.resolve(__dirname, '..')), null, 2) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
