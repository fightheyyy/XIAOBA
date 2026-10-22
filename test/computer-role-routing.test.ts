import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createRoleAwareToolManager } from '../src/capabilities/tools/create-tool-manager';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';

describe('Base computer-role routing', () => {
  test('Base ships with zero default skills', async () => {
    const skillManager = new SkillManager();
    await skillManager.loadSkills();

    assert.strictEqual(skillManager.getSkill('agent-browser'), undefined);
    assert.strictEqual(
      skillManager.getAllSkills().some(skill => skill.metadata.name === 'agent-browser'),
      false,
    );
    assert.deepEqual(skillManager.getAllSkills(), []);
  });

  test('Base prompt routes execution and evolution work to role owners', async () => {
    const prompt = await PromptManager.buildSystemPrompt();

    assert.match(prompt, /动态网页导航[\s\S]*`browser-cat`/);
    assert.match(prompt, /macOS 应用[\s\S]*`gui-cat`/);
    assert.match(prompt, /飞书日历[\s\S]*`secretary-cat`/);
    assert.match(prompt, /长期记忆[\s\S]*`evolution-cat`/);
    assert.match(prompt, /跨角色派工时不要同时传 `skill_name`/);
    assert.match(prompt, /不可信外部内容/);
  });

  test('runtime registry gives each computer role read-only Base context tools plus its typed adapter tools', () => {
    const browserNames = createRoleAwareToolManager(
      process.cwd(),
      { roleName: 'browser-cat' },
      'browser-cat',
    ).getToolDefinitions().map(tool => tool.name).sort();
    const guiNames = createRoleAwareToolManager(
      process.cwd(),
      { roleName: 'gui-cat' },
      'gui-cat',
    ).getToolDefinitions().map(tool => tool.name).sort();

    assert.ok(browserNames.includes('ask_parent'));
    assert.ok(browserNames.includes('browser_driver_status'));
    assert.ok(browserNames.includes('browser_open'));
    assert.ok(browserNames.includes('browser_close'));
    assert.ok(browserNames.includes('skill'));
    assert.equal(browserNames.filter(name => name.startsWith('browser_')).length, 12);
    assert.equal(browserNames.includes('browser_task_run'), false);

    assert.ok(guiNames.includes('ask_parent'));
    assert.ok(guiNames.includes('gui_driver_status'));
    assert.ok(guiNames.includes('gui_observe'));
    assert.ok(guiNames.includes('gui_release_control'));
    assert.ok(guiNames.includes('skill'));
    assert.equal(guiNames.filter(name => name.startsWith('gui_')).length, 8);
    assert.equal(guiNames.includes('gui_task_run'), false);

    for (const names of [browserNames, guiNames]) {
      for (const expected of ['ask_parent', 'read_file', 'glob', 'grep']) {
        assert.equal(names.includes(expected), true, `${expected} must be visible`);
      }
      for (const forbidden of ['execute_shell', 'write_file', 'edit_file', 'spawn_subagent']) {
        assert.equal(names.includes(forbidden), false, `${forbidden} must stay hidden`);
      }
    }
  });
});
