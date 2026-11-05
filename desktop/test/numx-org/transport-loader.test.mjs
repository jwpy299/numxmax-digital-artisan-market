import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REQUIRED_TRANSPORT_FUNCTIONS as TRANSPORT_KEYS } from '../../src/plugins/numx-org/lib/transport-loader.js';

const validTransport = `module.exports = { ${TRANSPORT_KEYS.map((key) => `${key}() {}`).join(', ')} };\n`;

function loaderFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'numx-transport-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lib = path.join(root, 'src', 'plugins', 'numx-org', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  const loader = path.join(lib, 'transport-loader.js');
  copyFileSync(new URL('../../src/plugins/numx-org/lib/transport-loader.js', import.meta.url), loader);
  return {
    loader,
    first: path.join(root, 'src', 'org-transport', 'index.cjs'),
    second: path.join(root, 'src', 'plugins', '@numx', 'org-transport', 'index.cjs'),
  };
}

test('传输回退：首个候选缺依赖时保留真实错误，不用第二候选掩盖', async (t) => {
  const fixture = loaderFixture(t);
  mkdirSync(path.dirname(fixture.first), { recursive: true });
  mkdirSync(path.dirname(fixture.second), { recursive: true });
  writeFileSync(fixture.first, "module.exports = require('numx-definitely-missing-dependency-v142');\n");
  writeFileSync(fixture.second, validTransport);
  await assert.rejects(import(`${pathToFileURL(fixture.loader).href}?missing-dependency`), (error) => {
    assert.ok(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error?.code));
    assert.match(String(error?.message), /numx-definitely-missing-dependency-v142/);
    return true;
  });
});

test('传输回退：候选本身缺失才可进入下一候选', async (t) => {
  const fixture = loaderFixture(t);
  mkdirSync(path.dirname(fixture.second), { recursive: true });
  writeFileSync(fixture.second, validTransport);
  const loaded = await import(`${pathToFileURL(fixture.loader).href}?second-candidate`);
  assert.equal(typeof loaded.transport.normalizeJson, 'function');
});

test('传输回退：全部候选缺失与首个候选结构错误保持不同故障', async (t) => {
  const missing = loaderFixture(t);
  await assert.rejects(import(`${pathToFileURL(missing.loader).href}?all-missing`), /org_plugin_transport_unavailable/);

  const invalid = loaderFixture(t);
  mkdirSync(path.dirname(invalid.first), { recursive: true });
  mkdirSync(path.dirname(invalid.second), { recursive: true });
  writeFileSync(invalid.first, 'module.exports = {};\n');
  writeFileSync(invalid.second, validTransport);
  await assert.rejects(import(`${pathToFileURL(invalid.loader).href}?invalid-shape`), /org_plugin_transport_invalid/);
});
