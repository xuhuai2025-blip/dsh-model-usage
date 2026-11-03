import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
test('standalone build is reproducible, resolves transitive imports and cleans stale hashes safely', async () => {
  const parent = resolve(root, 'tests');
  const fixture = await mkdtemp(join(parent, '.build-'));
  assert.equal(dirname(fixture), parent);
  try {
    for (const file of ['build.mjs', 'index.js', 'core.js', 'prices.js', 'panel.js', 'package.json', 'cordis.patch.yml']) await copyFile(join(root, file), join(fixture, file));
    await mkdir(join(fixture, 'dist'));
    await writeFile(join(fixture, 'dist/index.000000000000.js'), '// stale');
    await writeFile(join(fixture, 'dist/keep.txt'), 'not a generated artifact');
    const build = () => {
      const result = spawnSync(process.execPath, [join(fixture, 'build.mjs')], { cwd: parent, stdio: 'inherit' });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
    };
    const snapshot = async () => {
      const files = (await readdir(join(fixture, 'dist'))).sort();
      const result = {};
      for (const file of [...files.map(file => 'dist/' + file), 'package.json', 'cordis.patch.yml']) result[file] = await readFile(join(fixture, file), 'utf8');
      return result;
    };
    build();
    const first = await snapshot();
    assert.ok(!('dist/index.000000000000.js' in first));
    assert.equal(first['dist/keep.txt'], 'not a generated artifact');
    assert.equal(Object.keys(first).filter(file => file.endsWith('.js')).length, 4);
    const manifest = JSON.parse(first['package.json']);
    const host = await import(pathToFileURL(join(fixture, manifest.exports['.'])));
    assert.equal(typeof host.apply, 'function');
    assert.deepEqual(host.inject, ['connection', 'sessionPersistence']);
    build();
    assert.deepEqual(await snapshot(), first);
  } finally {
    if (dirname(fixture) !== parent || !fixture.startsWith(join(parent, '.build-'))) throw new Error('Invalid temporary build path');
    await rm(fixture, { recursive: true, force: true });
  }
});
