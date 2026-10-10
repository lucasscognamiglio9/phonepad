const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectAudit } = require('../tools/check-dependencies.cjs');

function audit(url, severity = 'high') {
  return {
    metadata: { vulnerabilities: { total: 1 } },
    vulnerabilities: { dependency: { via: [{ url, severity }] } },
  };
}

test('documented advisory remains visible while temporarily accepted', () => {
  const url = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
  assert.deepEqual(inspectAudit(audit(url), new Date('2026-10-09')).accepted, [url]);
});

test('new advisories and critical severity block the check', () => {
  assert.throws(() => inspectAudit(audit('https://github.com/advisories/new'), new Date('2026-10-09')));
  assert.throws(() => inspectAudit(audit('https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', 'critical'), new Date('2026-10-09')));
});

test('temporary acceptance expires', () => {
  assert.throws(() => inspectAudit(audit('https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'), new Date('2026-11-09')));
});

test('registry failure cannot pass as a clean audit', () => {
  assert.throws(() => inspectAudit({ error: { code: 'ENETUNREACH' } }));
  assert.throws(() => inspectAudit({ metadata: { vulnerabilities: { total: 1 } }, vulnerabilities: {} }));
});
