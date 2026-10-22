import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_VERSION } from '../src/version';

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

test('compiled CLI, prompts and desktop resources work from a separate task workspace', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-app-layout-'));
  try {
    const cli = await run(process.execPath, [path.join(root, 'dist/index.js'), '--version'], { cwd });
    assert.equal(cli.stdout.trim(), APP_VERSION);
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const { PromptManager } = require(${JSON.stringify(path.join(root, 'dist/runtime/harness/context/prompt-manager.js'))});
      const { startDashboard } = require(${JSON.stringify(path.join(root, 'dist/surfaces/dashboard/server.js'))});
      (async () => {
        assert.equal(PromptManager.getSurfacePrompt(), fs.readFileSync(${JSON.stringify(path.join(root, 'prompts/surface.md'))}, 'utf8').trim());
        const server = await startDashboard(0, '127.0.0.1');
        try {
          const base = 'http://127.0.0.1:' + server.address().port;
          for (const route of ['/', '/pet.html']) {
            const response = await fetch(base + route);
            assert.equal(response.status, 200);
            assert.match(await response.text(), /<!doctype html>/i);
          }
        } finally { await new Promise(resolve => server.close(resolve)); }
      })().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    `;
    await run(process.execPath, ['-e', script], { cwd, timeout: 20_000 });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
