import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { Observability } from '../src/runtime/observability';
import { APP_NODE_ENGINE, APP_VERSION } from '../src/version';

const root = path.resolve(__dirname, '..');

describe('release version consistency', () => {
  test('uses package.json as the runtime version source', () => {
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');

    assert.strictEqual(APP_VERSION, packageJson.version);
    assert.strictEqual(APP_NODE_ENGINE, packageJson.engines.node);
    assert.strictEqual(packageLock.version, packageJson.version);
    assert.strictEqual(packageLock.packages[''].version, packageJson.version);
    assert.strictEqual(Observability.fromEnv({}).config.serviceVersion, packageJson.version);
    assert.strictEqual(
      Observability.fromEnv({ XIAOBA_VERSION: 'deployment-version' }).config.serviceVersion,
      'deployment-version',
    );
  });

  test('keeps user-facing release links and Dashboard labels aligned', () => {
    const packageJson = readJson('package.json');
    const html = readText('desktop/dashboard/index.html');
    const expectedTag = `releases/tag/v${packageJson.version}`;

    assert.ok(readText('README.md').includes(expectedTag));
    assert.ok(readText('README.en.md').includes(expectedTag));
    assert.ok(!/sidebar-brand-ver">v\d/.test(html));
    assert.ok(!/sidebar-watermark-version[^\n]*>v\d/.test(html));
    assert.ok(html.includes('id="sidebar-watermark-version">v-</span>'));
    assert.ok(html.includes("watermarkVersion.textContent = displayVersion"));
    assert.ok(html.includes("watermark.setAttribute('aria-label'"));
  });

  test('declares the macOS Preview architecture and external Node policy', () => {
    const packageJson = readJson('package.json');
    const electronMain = readText('desktop/electron/main.js');
    const envExample = readText('.env.example');
    const releaseScript = readText('scripts/release.sh');

    assert.match(packageJson.scripts['electron:build:mac'], /--arm64/);
    assert.strictEqual(packageJson.build.mac.artifactName, '${productName}-${version}-mac-${arch}.${ext}');
    assert.strictEqual(packageJson.build.extraFiles, undefined);
    assert.ok(packageJson.build.extraResources[0].filter.includes('!@types/**'));
    assert.ok(packageJson.build.extraResources[0].filter.includes('!playwright/**'));
    assert.ok(packageJson.build.extraResources[0].filter.includes('!tsx/**'));
    assert.ok(electronMain.includes("process.env.XIAOBA_NODE_EXE || ''"));
    assert.ok(electronMain.includes('/opt/homebrew/bin/node'));
    assert.ok(electronMain.includes("process.env.XIAOBA_ENABLE_AUTO_UPDATE !== 'true'"));
    assert.ok(releaseScript.includes('p.build.mac.artifactName'));
    assert.ok(releaseScript.includes('SHORT_COMMIT'));
    assert.ok(!releaseScript.includes('The v0.2 Preview release script'));
    assert.ok(envExample.includes('XIAOBA_DASHBOARD_HOST=127.0.0.1'));
    assert.ok(!envExample.includes('XIAOBA_DASHBOARD_HOST=0.0.0.0'));
  });
});

function readJson(relativePath: string): any {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}
