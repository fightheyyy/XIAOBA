import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceManager } from '../src/surfaces/dashboard/service-manager';
import { Logger } from '../src/runtime/observability/logger';

const originalCwd = process.cwd();

describe('Dashboard service logs', () => {
  let testRoot = '';

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-service-logs-'));
    process.chdir(testRoot);
    Logger.setSilentMode(true);
    Logger.clearRuntimeLogs();
  });

  afterEach(() => {
    Logger.clearRuntimeLogs();
    Logger.setSilentMode(false);
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('pet service logs include in-process pet chat runtime logs', () => {
    const serviceManager = new ServiceManager(testRoot);

    Logger.withSessionContext('pet:xiaoba', () => {
      Logger.info('[pet:xiaoba] 收到 pet 消息 (dashboard): 你好');
      Logger.info('[pet:xiaoba Turn 1] AI最终回复: 在呢');
    });
    Logger.withSessionContext('feishu:user-demo', () => {
      Logger.info('feishu runtime should stay out of pet logs');
    });
    Logger.info('unscoped dashboard log should stay out of pet logs');

    const logs = serviceManager.getLogs('pet', 20);

    assert.ok(logs.some(line => line.includes('收到 pet 消息 (dashboard): 你好')));
    assert.ok(logs.some(line => line.includes('AI最终回复: 在呢')));
    assert.ok(!logs.some(line => line.includes('feishu runtime should stay out')));
    assert.ok(!logs.some(line => line.includes('unscoped dashboard log')));
  });

  test('managed service list excludes retired CatsCompany adapter', () => {
    const serviceManager = new ServiceManager(testRoot);
    const serviceNames = serviceManager.getAll().map(service => service.name);

    assert.ok(serviceNames.includes('feishu'));
    assert.ok(serviceNames.includes('weixin'));
    assert.ok(!serviceNames.includes('catscompany'));
  });
});
