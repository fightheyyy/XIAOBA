import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';
import { RoleResolver } from '../src/capabilities/roles/role-resolver';
import { SkillManager } from '../src/capabilities/skills/skill-manager';

const describeResearcherRole = fs.existsSync(path.join(process.cwd(), 'roles', 'researcher-cat', 'role.json'))
  ? describe
  : describe.skip;

describeResearcherRole('ResearcherCat role assets', () => {
  test('role.json 应存在且可解析', () => {
    const rolePath = path.join(process.cwd(), 'roles', 'researcher-cat', 'role.json');
    assert.ok(fs.existsSync(rolePath));

    const config = JSON.parse(fs.readFileSync(rolePath, 'utf-8'));
    assert.strictEqual(config.name, 'researcher-cat');
    assert.strictEqual(config.displayName, 'Ishigami Senhachi');
    assert.strictEqual(config.promptFile, 'researcher-cat-system-prompt.md');
    assert.ok(config.aliases.includes('researcher'));
    assert.ok(config.aliases.includes('sci-paper-doctor'));
  });

  test('PromptManager 能加载 ResearcherCat prompt', async () => {
    RoleResolver.activateRole('researcher');

    const prompt = await PromptManager.buildSystemPrompt();

    assert.match(prompt, /ResearcherCat/);
    assert.match(prompt, /长周期科研项目/);
    assert.match(prompt, /压缩或历史摘要恢复后/);
    assert.match(prompt, /argmax/);
    assert.match(prompt, /OvR/);
    assert.match(prompt, /实验归属/);
    assert.match(prompt, /diff\/hash/);
    assert.match(prompt, /最新附件/);
    assert.match(prompt, /最早可预测时间/);
    assert.match(prompt, /target venue/);
    assert.match(prompt, /provider\/API 失败/);
    assert.match(prompt, /source citation map/);
    assert.match(prompt, /reproduce-vs-remove decision/);
    assert.match(prompt, /accept \/ reject \/ needs-evidence/);
    assert.match(prompt, /visual brief/);
    assert.match(prompt, /includegraphics/);
    assert.match(prompt, /run registry/);
    assert.match(prompt, /research_board_update/);
    assert.match(prompt, /research_board_read/);
    assert.match(prompt, /auto_research_run/);
    assert.match(prompt, /当前角色：Ishigami Senhachi/);

    RoleResolver.clearActiveRole();
  });

  test('旧角色名 alias 仍可解析到 researcher-cat', () => {
    RoleResolver.activateRole('sci-paper-doctor');

    assert.strictEqual(RoleResolver.getActiveRoleName(), 'researcher-cat');

    RoleResolver.clearActiveRole();
  });

  test('CLI researcher alias resolves to ResearcherCat', () => {
    RoleResolver.activateRole('researcher');

    assert.strictEqual(RoleResolver.getActiveRoleName(), 'researcher-cat');
    assert.strictEqual(process.env.XIAOBA_ROLE, 'researcher-cat');
    assert.strictEqual(process.env.CURRENT_ROLE, 'researcher-cat');
    assert.strictEqual(process.env.CURRENT_ROLE_DISPLAY_NAME, 'Ishigami Senhachi');

    RoleResolver.clearActiveRole();
  });

  test('SkillManager 能加载 ResearcherCat 首批 skills', async () => {
    RoleResolver.activateRole('researcher-cat');

    const manager = new SkillManager();
    await manager.loadSkills();

    for (const skillName of [
      'research-case-orchestrator',
      'paper-reader',
      'paper-architect',
      'evidence-auditor',
      'manuscript-sync',
      'latex-compiler',
      'experiment-runner',
      'revision-planner',
    ]) {
      assert.ok(manager.getSkill(skillName), `${skillName} should be loaded`);
    }

    RoleResolver.clearActiveRole();
  });

  test('旧 skill 名 alias 仍可解析到新命名', async () => {
    RoleResolver.activateRole('researcher-cat');

    const manager = new SkillManager();
    await manager.loadSkills();

    assert.strictEqual(manager.getSkill('paper-reading-doctor')?.metadata.name, 'paper-reader');
    assert.strictEqual(manager.getSkill('experiment-result-auditor')?.metadata.name, 'evidence-auditor');
    assert.strictEqual(manager.getSkill('latex-compile-doctor')?.metadata.name, 'latex-compiler');

    RoleResolver.clearActiveRole();
  });
});
