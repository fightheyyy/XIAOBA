import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePetDesktopEntry } from '../src/surfaces/pet/desktop-launcher';

const originalCwd = process.cwd();
const originalAppRoot = process.env.XIAOBA_APP_ROOT;
const originalPetMain = process.env.XIAOBA_PET_MAIN;

describe('Pet desktop launcher', () => {
  afterEach(() => {
    process.chdir(originalCwd);
    if (typeof originalAppRoot === 'string') {
      process.env.XIAOBA_APP_ROOT = originalAppRoot;
    } else {
      delete process.env.XIAOBA_APP_ROOT;
    }
    if (typeof originalPetMain === 'string') {
      process.env.XIAOBA_PET_MAIN = originalPetMain;
    } else {
      delete process.env.XIAOBA_PET_MAIN;
    }
  });

  test('Electron dashboard cwd 为 userData 时从 XIAOBA_APP_ROOT 解析 pet-main', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pet-app-root-'));
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-pet-user-data-'));
    process.env.XIAOBA_APP_ROOT = appRoot;
    delete process.env.XIAOBA_PET_MAIN;
    process.chdir(userData);

    assert.strictEqual(
      resolvePetDesktopEntry(),
      path.join(appRoot, 'desktop', 'electron', 'pet-main.js'),
    );

    process.chdir(originalCwd);
    fs.rmSync(appRoot, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('XIAOBA_PET_MAIN 可以显式覆盖 pet-main 路径', () => {
    process.env.XIAOBA_APP_ROOT = '/tmp/app-root';
    process.env.XIAOBA_PET_MAIN = '/tmp/custom-pet-main.js';

    assert.strictEqual(resolvePetDesktopEntry(), '/tmp/custom-pet-main.js');
  });
});
