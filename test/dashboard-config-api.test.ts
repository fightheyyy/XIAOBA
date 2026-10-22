import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { MessageSessionManager } from '../src/runtime/sessions/message-session-manager';
import { createApiRouter } from '../src/surfaces/dashboard/routes/api';
import { ServiceManager } from '../src/surfaces/dashboard/service-manager';

const originalCwd = process.cwd();
const trackedEnvKeys = [
  'XIAOBA_LLM_PROVIDER',
  'XIAOBA_LLM_API_BASE',
  'XIAOBA_LLM_API_KEY',
  'XIAOBA_LLM_MODEL',
] as const;
const originalEnv = new Map<string, string | undefined>(
  trackedEnvKeys.map(key => [key, process.env[key]])
);

async function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

function restoreTrackedEnv(): void {
  for (const key of trackedEnvKeys) {
    const value = originalEnv.get(key);
    if (typeof value === 'string') {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

describe('Dashboard config API', () => {
  let testRoot = '';
  let server: http.Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-config-'));
    process.chdir(testRoot);
    fs.writeFileSync(path.join(testRoot, '.env'), [
      'XIAOBA_LLM_PROVIDER=openai',
      'XIAOBA_LLM_API_BASE=https://old.example/v1',
      'XIAOBA_LLM_API_KEY=sk-old-123456',
      'XIAOBA_LLM_MODEL=MiniMax-M2.7-highspeed',
      '',
    ].join('\n'), 'utf-8');

    process.env.XIAOBA_LLM_PROVIDER = 'openai';
    process.env.XIAOBA_LLM_API_BASE = 'https://old.example/v1';
    process.env.XIAOBA_LLM_API_KEY = 'sk-old-123456';
    process.env.XIAOBA_LLM_MODEL = 'MiniMax-M2.7-highspeed';

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createApiRouter(new ServiceManager(testRoot)));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    await MessageSessionManager.getManager('pet')?.destroy();
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    restoreTrackedEnv();
  });

  test('saving model config updates the running dashboard environment immediately', async () => {
    const saveResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        XIAOBA_LLM_PROVIDER: 'openai',
        XIAOBA_LLM_API_BASE: 'http://127.0.0.1:8317/v1',
        XIAOBA_LLM_API_KEY: 'sk-new-654321',
        XIAOBA_LLM_MODEL: 'gpt-5.5',
      }),
    });
    assert.strictEqual(saveResponse.status, 200);

    assert.strictEqual(process.env.XIAOBA_LLM_PROVIDER, 'openai');
    assert.strictEqual(process.env.XIAOBA_LLM_API_BASE, 'http://127.0.0.1:8317/v1');
    assert.strictEqual(process.env.XIAOBA_LLM_API_KEY, 'sk-new-654321');
    assert.strictEqual(process.env.XIAOBA_LLM_MODEL, 'gpt-5.5');

    const statusResponse = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(statusResponse.status, 200);
    const status = await statusResponse.json() as { provider: string; model: string };
    assert.strictEqual(status.provider, 'openai');
    assert.strictEqual(status.model, 'gpt-5.5');
  });

  test('masked sensitive values are not written back into the runtime environment', async () => {
    const saveResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        XIAOBA_LLM_API_KEY: '****3456',
        XIAOBA_LLM_MODEL: 'gpt-5.5',
      }),
    });
    assert.strictEqual(saveResponse.status, 200);

    assert.strictEqual(process.env.XIAOBA_LLM_API_KEY, 'sk-old-123456');
    assert.strictEqual(process.env.XIAOBA_LLM_MODEL, 'gpt-5.5');

    const configResponse = await fetch(`${baseUrl}/api/config`);
    assert.strictEqual(configResponse.status, 200);
    const config = await configResponse.json() as { XIAOBA_LLM_API_KEY: string; XIAOBA_LLM_MODEL: string };
    assert.strictEqual(config.XIAOBA_LLM_API_KEY, '****3456');
    assert.strictEqual(config.XIAOBA_LLM_MODEL, 'gpt-5.5');
  });
});
