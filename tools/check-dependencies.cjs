const { spawnSync } = require('node:child_process');
const path = require('node:path');

const acceptedUntil = '2026-11-09';
const accepted = new Set([
  'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
]);

function inspectAudit(audit, date = new Date()) {
  if (audit.error || !audit.metadata?.vulnerabilities || !audit.vulnerabilities) {
    throw Error('npm no devolvió una auditoría completa.');
  }
  const advisories = new Map();
  for (const vulnerability of Object.values(audit.vulnerabilities)) {
    for (const entry of vulnerability.via) {
      if (typeof entry === 'object') advisories.set(entry.url, entry);
    }
  }
  if (audit.metadata.vulnerabilities.total > 0 && advisories.size === 0) {
    throw Error('Hay vulnerabilidades sin avisos verificables.');
  }
  const expired = date.toISOString().slice(0, 10) >= acceptedUntil;
  const blocked = [...advisories.values()].filter(entry =>
    entry.severity === 'critical' || !accepted.has(entry.url) || expired);
  if (blocked.length) {
    throw Error('Avisos nuevos o pendientes de revisión: ' + blocked.map(entry => entry.url).join(', '));
  }
  return { counts: audit.metadata.vulnerabilities, accepted: [...advisories.keys()], acceptedUntil };
}

if (require.main === module) {
  try {
    const result = spawnSync('npm', ['audit', '--json'], {
      cwd: path.join(__dirname, '../mobile'), encoding: 'utf8', timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024, shell: false,
    });
    if (result.error || ![0, 1].includes(result.status)) throw Error('No se pudo ejecutar npm audit.');
    const report = inspectAudit(JSON.parse(result.stdout));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.accepted.length) {
      process.stderr.write('Persisten los dos avisos sin parche documentados en docs/auditoria-seguridad.md.\n');
    }
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { inspectAudit };
