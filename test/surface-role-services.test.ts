import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FeishuBot } from '../src/surfaces/feishu';
import { WeixinBot } from '../src/surfaces/weixin';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { ToolManager } from '../src/capabilities/tools/tool-manager';
import { RoleResolver } from '../src/capabilities/roles/role-resolver';

const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;

describe('surface role-aware AgentServices', () => {
  const roots: string[] = [];

  afterEach(() => {
    restoreEnv('XIAOBA_ROLE', originalRole);
    restoreEnv('CURRENT_ROLE', originalCurrentRole);
    restoreEnv('CURRENT_ROLE_DISPLAY_NAME', originalDisplayName);
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Feishu and Weixin default services carry the active role explicitly', async () => {
    RoleResolver.activateRole('engineer');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-surface-role-'));
    roots.push(stateDir);

    const feishu = new FeishuBot(
      { appId: 'test-app', appSecret: 'test-secret' },
      {
        client: {} as any,
        wsClient: {} as any,
        sender: {} as any,
      },
    );
    const weixin = new WeixinBot({
      token: 'test-token',
      baseUrl: 'https://weixin.invalid',
      cdnBaseUrl: 'https://cdn.weixin.invalid',
      stateDir,
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    try {
      for (const services of [(feishu as any).agentServices, (weixin as any).agentServices]) {
        assert.strictEqual(services.roleName, 'engineer-cat');
        assert.strictEqual((services.skillManager as any).roleName, 'engineer-cat');
        assert.strictEqual(
          services.toolManager.getToolVisibilityInfo().roleName,
          'engineer-cat',
        );
      }
    } finally {
      await feishu.destroy();
      await weixin.destroy();
    }
  });

  test('Feishu preserves explicitly injected AgentServices', async () => {
    RoleResolver.activateRole('engineer');
    const injected = {
      aiService: {} as any,
      toolManager: new ToolManager(),
      skillManager: new SkillManager('reviewer-cat'),
      roleName: 'reviewer-cat',
    };
    const feishu = new FeishuBot(
      { appId: 'test-app', appSecret: 'test-secret' },
      {
        client: {} as any,
        wsClient: {} as any,
        sender: {} as any,
        agentServices: injected,
      },
    );

    try {
      assert.strictEqual((feishu as any).agentServices, injected);
      assert.strictEqual((feishu as any).agentServices.roleName, 'reviewer-cat');
    } finally {
      await feishu.destroy();
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
