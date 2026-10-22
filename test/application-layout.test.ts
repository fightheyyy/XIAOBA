import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { APP_VERSION } from '../src/version';

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

function electronDashboardModule(): string {
  const file = path.join(root, 'desktop/electron/main.js');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const modules: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
      && node.name.elements.some(element => element.name.getText(source) === 'startDashboard')) {
      const initializer = node.initializer;
      assert.ok(initializer && ts.isCallExpression(initializer));
      assert.equal(initializer.expression.getText(source), 'require');
      const argument = initializer.arguments[0];
      assert.ok(argument);
      modules.push(runInNewContext(argument.getText(source), { path, appRoot: root }));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(modules.length, 1, 'Electron must declare one Dashboard server import');
  return modules[0];
}

test('compiled CLI, prompts and desktop resources work from a separate task workspace', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-app-layout-'));
  try {
    const cli = await run(process.execPath, [path.join(root, 'dist/index.js'), '--version'], { cwd });
    assert.equal(cli.stdout.trim(), APP_VERSION);
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const { PromptManager } = require(${JSON.stringify(path.join(root, 'dist/runtime/harness/context/prompt-manager.js'))});
      const { startDashboard } = require(${JSON.stringify(electronDashboardModule())});
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
