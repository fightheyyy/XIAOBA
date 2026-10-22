import { after, afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';
import { RoleResolver } from '../src/capabilities/roles/role-resolver';
import { SkillManager } from '../src/capabilities/skills/skill-manager';

const originalCwd = process.cwd();
const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;
const originalAppRoot = process.env.XIAOBA_APP_ROOT;
const originalRolesRoot = process.env.XIAOBA_ROLES_ROOT;

function writeFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf-8');
}

describe('roles mechanism', () => {
  let testRoot: string;

  beforeEach(() => {
    RoleResolver.clearActiveRole();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-roles-'));

    writeFile(path.join(testRoot, 'prompts', 'system-prompt.md'), '你是基础角色。');
    writeFile(path.join(testRoot, 'prompts', 'behavior.md'), '基础行为约束。');

    writeFile(path.join(testRoot, 'skills', 'base-skill', 'SKILL.md'), `---
name: base-skill
description: Base skill
---

# Base Skill
`);
    writeFile(path.join(testRoot, 'skills', 'shared-skill', 'SKILL.md'), `---
name: shared-skill
description: Base shared skill
---

# Base Shared Skill
`);
    writeFile(path.join(testRoot, 'skills', 'hidden-skill', 'SKILL.md'), `---
name: hidden-skill
description: Hidden skill
---

# Hidden Skill
`);

    writeFile(path.join(testRoot, 'roles', 'InspectorCat', 'role.json'), JSON.stringify({
      name: 'inspector-cat',
      displayName: 'InspectorCat',
      promptFile: 'inspector-system-prompt.md',
      inheritBaseSkills: true,
      excludeBaseSkills: ['hidden-skill'],
    }, null, 2));
    writeFile(path.join(testRoot, 'roles', 'InspectorCat', 'prompts', 'inspector-system-prompt.md'), '你是 InspectorCat。');
    writeFile(path.join(testRoot, 'roles', 'InspectorCat', 'prompts', 'behavior.md'), '角色行为约束。');
    writeFile(path.join(testRoot, 'roles', 'InspectorCat', 'skills', 'shared-skill', 'SKILL.md'), `---
name: shared-skill
description: Role shared skill
---

# Role Shared Skill
`);
    writeFile(path.join(testRoot, 'roles', 'InspectorCat', 'skills', 'role-only-skill', 'SKILL.md'), `---
name: role-only-skill
description: Role only skill
---

# Role Only Skill
`);

    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  after(() => {
    process.chdir(originalCwd);
    if (originalRole) {
      process.env.XIAOBA_ROLE = originalRole;
    } else {
      delete process.env.XIAOBA_ROLE;
    }
    if (originalCurrentRole) {
      process.env.CURRENT_ROLE = originalCurrentRole;
    } else {
      delete process.env.CURRENT_ROLE;
    }
    if (originalCurrentRoleDisplayName) {
      process.env.CURRENT_ROLE_DISPLAY_NAME = originalCurrentRoleDisplayName;
    } else {
      delete process.env.CURRENT_ROLE_DISPLAY_NAME;
    }
    if (originalAppRoot) {
      process.env.XIAOBA_APP_ROOT = originalAppRoot;
    } else {
      delete process.env.XIAOBA_APP_ROOT;
    }
    if (originalRolesRoot) {
      process.env.XIAOBA_ROLES_ROOT = originalRolesRoot;
    } else {
      delete process.env.XIAOBA_ROLES_ROOT;
    }
  });

  test('RoleResolver 应该支持规范化角色名并注入环境变量', () => {
    RoleResolver.activateRole('inspector cat');

    assert.strictEqual(RoleResolver.getActiveRoleName(), 'InspectorCat');
    assert.strictEqual(process.env.XIAOBA_ROLE, 'InspectorCat');
    assert.strictEqual(process.env.CURRENT_ROLE_DISPLAY_NAME, 'InspectorCat');
  });

  test('PromptManager 应该优先加载角色 prompt', async () => {
    RoleResolver.activateRole('inspector-cat');

    const systemPrompt = await PromptManager.buildSystemPrompt();

    assert.match(systemPrompt, /你是 InspectorCat/);
    assert.match(systemPrompt, /基础行为约束/);
    assert.match(systemPrompt, /角色行为约束/);
    assert.match(systemPrompt, /当前角色：InspectorCat/);
    assert.doesNotMatch(systemPrompt, /你是基础角色/);
  });

  test('SkillManager 应该合并基础 skills，并允许角色覆盖和排除', async () => {
    RoleResolver.activateRole('inspector-cat');

    const manager = new SkillManager();
    await manager.loadSkills();

    const skillNames = manager.getAllSkills().map(skill => skill.metadata.name).sort();
    assert.deepStrictEqual(skillNames, ['base-skill', 'role-only-skill', 'shared-skill']);

    const sharedSkill = manager.getSkill('shared-skill');
    assert.ok(sharedSkill);
    assert.match(sharedSkill!.content, /Role Shared Skill/);
    assert.strictEqual(manager.getSkill('hidden-skill'), undefined);
  });

  test('Electron cwd 为 userData 时应从 XIAOBA_APP_ROOT 回落读取内置 roles', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-roles-app-root-'));
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-roles-user-data-'));

    writeFile(path.join(appRoot, 'roles', 'engineer-cat', 'role.json'), JSON.stringify({
      name: 'engineer-cat',
      displayName: 'EngineerCat',
    }, null, 2));
    writeFile(path.join(appRoot, 'roles', 'reviewer-cat', 'role.json'), JSON.stringify({
      name: 'reviewer-cat',
      displayName: 'ReviewerCat',
    }, null, 2));

    process.chdir(userData);
    process.env.XIAOBA_APP_ROOT = appRoot;
    delete process.env.XIAOBA_ROLES_ROOT;

    assert.deepStrictEqual(RoleResolver.listAvailableRoles(), ['engineer-cat', 'reviewer-cat']);
    RoleResolver.activateRole('engineer-cat');
    assert.strictEqual(RoleResolver.getActiveRolePath(), path.join(appRoot, 'roles', 'engineer-cat'));

    process.chdir(testRoot);
    fs.rmSync(appRoot, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });
});
