import { after, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { createRoleAwareToolManager } from '../src/capabilities/tools/create-tool-manager';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { ChatResponse, Message } from '../src/runtime/contracts';
import { Tool, ToolDefinition, ToolExecutionContext } from '../src/runtime/contracts/tool';
import { ToolManager } from '../src/capabilities/tools/tool-manager';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';
import { RoleResolver } from '../src/capabilities/roles/role-resolver';

const originalRole = process.env.XIAOBA_ROLE;
const originalCurrentRole = process.env.CURRENT_ROLE;
const originalCurrentRoleDisplayName = process.env.CURRENT_ROLE_DISPLAY_NAME;

function fakeChannel(surface: string) {
  return {
    chatId: `${surface}-chat`,
    reply: async () => undefined,
    sendFile: async () => undefined,
  };
}

class SecretaryScopedAIService {
  requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  private responseIndex = 0;

  constructor(private readonly responses: ChatResponse[]) {}

  async chatStream(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      tools,
    });
    const response = this.responses[this.responseIndex++];
    if (!response) {
      throw new Error('No scripted response left');
    }
    return response;
  }

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class FakeConfirmedMessageSendTool implements Tool {
  definition: ToolDefinition = {
    name: 'feishu_message_send_confirmed',
    description: 'Fake confirmed sender for gate tests.',
    parameters: {
      type: 'object',
      properties: {
        recipient_type: { type: 'string' },
        recipient_id: { type: 'string' },
        text: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['recipient_type', 'recipient_id', 'text', 'confirmed'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    return JSON.stringify({
      ok: true,
      sent_to: args.recipient_id,
      text: args.text,
    });
  }
}

describe('SecretaryCat role', () => {
  after(() => {
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
  });

  test('role assets exist and alias activation resolves to secretary-cat', () => {
    const rolePath = path.join(process.cwd(), 'roles', 'secretary-cat', 'role.json');
    assert.ok(fs.existsSync(rolePath));

    const config = JSON.parse(fs.readFileSync(rolePath, 'utf-8'));
    assert.equal(config.name, 'secretary-cat');
    assert.equal(config.promptFile, 'secretary-system-prompt.md');
    assert.equal(config.inheritBaseSkills, false);
    assert.equal(config.inheritBaseTools, false);
    assert.deepEqual(config.baseToolAllowlist, ['skill']);
    assert.equal(config.toolVisibility.mode, 'skill_scoped');
    assert.ok(config.aliases.includes('feishu-cat'));
    assert.deepEqual(config.toolVisibility.defaultTools, [
      'skill',
      'feishu_auth_status',
      'feishu_auth_login_start',
      'feishu_auth_login_complete',
    ]);

    RoleResolver.activateRole('secretary');
    assert.equal(RoleResolver.getActiveRoleName(), 'secretary-cat');
    assert.equal(RoleResolver.resolveRoleDirectoryName('FeishuCat'), 'secretary-cat');
  });

  test('prompt and role-local skills load without base skill inheritance', async () => {
    const prompt = await PromptManager.buildSystemPrompt({ roleName: 'secretary-cat' });
    assert.match(prompt, /SecretaryCat/);
    assert.match(prompt, /confirmation/);
    assert.match(prompt, /first activate the matching skill/);
    assert.match(prompt, /currently visible tool named `skill`/);
    assert.match(prompt, /not literally present in the current tool list/);
    assert.match(prompt, /call the tool immediately/);
    assert.match(prompt, /Do not use message-drafting for email requests/);
    assert.doesNotMatch(prompt, /feishu_calendar_agenda/);
    assert.doesNotMatch(prompt, /feishu_message_draft/);
    assert.doesNotMatch(prompt, /feishu_mail_draft_create/);
    assert.doesNotMatch(prompt, /feishu_docs_search/);
    assert.doesNotMatch(prompt, /feishu_drive_search/);
    assert.doesNotMatch(prompt, /feishu_sheets_read/);
    assert.doesNotMatch(prompt, /feishu_base_record_list/);
    assert.doesNotMatch(prompt, /feishu_task_list/);
    assert.doesNotMatch(prompt, /feishu_minutes_search/);

    const skillManager = new SkillManager('secretary-cat');
    await skillManager.loadSkills();
    assert.deepEqual(skillManager.getAllSkills().map(skill => skill.metadata.name).sort(), [
      'base',
      'calendar',
      'contact',
      'daily-brief',
      'docs',
      'drive',
      'mail',
      'message-drafting',
      'minutes',
      'sheets',
      'task',
    ]);
  });

  test('role-aware tool manager exposes only default SecretaryCat tools before skill activation', async () => {
    const manager = createRoleAwareToolManager(process.cwd(), {}, 'secretary-cat');
    const toolNames = manager.getToolDefinitions().map(tool => tool.name).sort();

    assert.deepEqual(toolNames, [
      'feishu_auth_login_complete',
      'feishu_auth_login_start',
      'feishu_auth_status',
      'skill',
    ]);
    const visibility = manager.getToolVisibilityInfo({ roleName: 'secretary-cat' });
    assert.equal(visibility.mode, 'skill_scoped');
    assert.deepEqual(visibility.visibleTools.sort(), toolNames);
    assert.ok(visibility.hiddenToolCount > 20);
    assert.equal(manager.getTool('execute_shell'), undefined);
    assert.equal(manager.getTool('write_file'), undefined);
    assert.equal(manager.getTool('edit_file'), undefined);
    assert.equal(manager.getTool('read_file'), undefined);
  });

  test('SecretaryCat calendar skill exposes only calendar scoped tools and confirmation-gated writes', async () => {
    const manager = createRoleAwareToolManager(process.cwd(), {}, 'secretary-cat');
    const toolNames = manager.getToolDefinitions({
      roleName: 'secretary-cat',
      activeSkillName: 'calendar',
      conversationHistory: [{ role: 'user', content: '看一下明天日历' }],
    }).map(tool => tool.name).sort();

    assert.deepEqual(toolNames, [
      'feishu_auth_login_complete',
      'feishu_auth_login_start',
      'feishu_auth_status',
      'feishu_calendar_agenda',
      'feishu_calendar_create',
      'feishu_contact_search',
      'skill',
    ]);
    assert.ok(!toolNames.includes('feishu_calendar_update'));
    assert.ok(!toolNames.includes('feishu_calendar_delete'));
    assert.ok(!toolNames.includes('feishu_mail_triage'));
    assert.ok(!toolNames.includes('feishu_docs_search'));

    const confirmedToolNames = manager.getToolDefinitions({
      roleName: 'secretary-cat',
      activeSkillName: 'calendar',
      conversationHistory: [{ role: 'user', content: '确认删除这个日程' }],
    }).map(tool => tool.name);
    assert.ok(confirmedToolNames.includes('feishu_calendar_update'));
    assert.ok(confirmedToolNames.includes('feishu_calendar_delete'));
  });

  test('SecretaryCat confirmation gate ignores negated confirmation turns', async () => {
    const manager = createRoleAwareToolManager(process.cwd(), {}, 'secretary-cat');
    const toolNames = manager.getToolDefinitions({
      roleName: 'secretary-cat',
      activeSkillName: 'calendar',
      conversationHistory: [{ role: 'user', content: '不要删除这个日程，也不可以更新' }],
    }).map(tool => tool.name);

    assert.ok(!toolNames.includes('feishu_calendar_update'));
    assert.ok(!toolNames.includes('feishu_calendar_delete'));
  });

  test('SecretaryCat confirmed execution requires payload-bound confirmation evidence', async () => {
    const manager = new ToolManager(
      process.cwd(),
      { roleName: 'secretary-cat' },
      [new FakeConfirmedMessageSendTool()],
    );
    const context = {
      roleName: 'secretary-cat',
      activeSkillName: 'message-drafting',
      activeToolsets: ['message'],
    };

    const mismatch = await manager.executeTool({
      id: 'message-send-mismatch',
      type: 'function',
      function: {
        name: 'feishu_message_send_confirmed',
        arguments: JSON.stringify({
          recipient_type: 'user_id',
          recipient_id: 'ou_wrong',
          text: 'different message',
          confirmed: true,
        }),
      },
    }, [
      { role: 'assistant', content: '提案：发送给 ou_right，内容是 hello payload.' },
      { role: 'user', content: '可以，确认发送' },
    ], context);

    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 'blocked');
    assert.equal(mismatch.errorCode, 'TOOL_CONFIRMATION_PAYLOAD_MISMATCH');

    const matched = await manager.executeTool({
      id: 'message-send-matched',
      type: 'function',
      function: {
        name: 'feishu_message_send_confirmed',
        arguments: JSON.stringify({
          recipient_type: 'user_id',
          recipient_id: 'ou_right',
          text: 'hello payload',
          confirmed: true,
        }),
      },
    }, [
      { role: 'assistant', content: '提案：发送给 ou_right，内容是 hello payload.' },
      { role: 'user', content: '可以，确认发送' },
    ], context);

    assert.equal(matched.ok, true);
    assert.equal(matched.status, 'success');
    assert.match(String(matched.content), /ou_right/);
  });

  test('SecretaryCat contact skill exposes contact lookup without unrelated domain tools', async () => {
    const manager = createRoleAwareToolManager(process.cwd(), {}, 'secretary-cat');
    const toolNames = manager.getToolDefinitions({
      roleName: 'secretary-cat',
      activeSkillName: 'contact',
      conversationHistory: [{ role: 'user', content: '帮我查一下张三' }],
    }).map(tool => tool.name).sort();

    assert.deepEqual(toolNames, [
      'feishu_auth_login_complete',
      'feishu_auth_login_start',
      'feishu_auth_status',
      'feishu_contact_search',
      'skill',
    ]);
    assert.ok(!toolNames.includes('feishu_message_draft'));
    assert.ok(!toolNames.includes('feishu_calendar_agenda'));
    assert.ok(!toolNames.includes('feishu_mail_triage'));
  });

  test('SecretaryCat message skill does not expose unrelated mail/docs/drive tools', async () => {
    const manager = createRoleAwareToolManager(process.cwd(), {}, 'secretary-cat');
    const toolNames = manager.getToolDefinitions({
      roleName: 'secretary-cat',
      activeSkillName: 'message-drafting',
      activeToolsets: ['message'],
      conversationHistory: [{ role: 'user', content: '帮我给小张写条消息' }],
    }).map(tool => tool.name).sort();

    assert.deepEqual(toolNames, [
      'feishu_auth_login_complete',
      'feishu_auth_login_start',
      'feishu_auth_status',
      'feishu_contact_search',
      'feishu_message_draft',
      'skill',
    ]);
    assert.ok(!toolNames.includes('feishu_message_send_confirmed'));
    assert.ok(!toolNames.includes('feishu_mail_draft_create'));
    assert.ok(!toolNames.includes('feishu_docs_search'));
    assert.ok(!toolNames.includes('feishu_drive_search'));
  });

  test('SecretaryCat hard-called scoped or unconfirmed tools are blocked by runtime', async () => {
    const manager = createRoleAwareToolManager(process.cwd(), {}, 'secretary-cat');
    const unscoped = await manager.executeTool({
      id: 'docs-search-blocked',
      type: 'function',
      function: {
        name: 'feishu_docs_search',
        arguments: JSON.stringify({ query: 'budget' }),
      },
    }, [], {
      roleName: 'secretary-cat',
    });
    assert.equal(unscoped.ok, false);
    assert.equal(unscoped.errorCode, 'TOOL_FORBIDDEN_FOR_ACTIVE_SKILL');

    const unconfirmed = await manager.executeTool({
      id: 'message-send-blocked',
      type: 'function',
      function: {
        name: 'feishu_message_send_confirmed',
        arguments: JSON.stringify({
          recipient_type: 'user_id',
          recipient_id: 'ou_xxx',
          text: 'hello',
          confirmed: true,
        }),
      },
    }, [{ role: 'user', content: '帮我写条消息' }], {
      roleName: 'secretary-cat',
      activeSkillName: 'message-drafting',
      activeToolsets: ['message'],
    });
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.errorCode, 'TOOL_CONFIRMATION_REQUIRED');
  });

  test('SecretaryCat keeps active scoped domain for the next confirmation turn', async () => {
    const originalCwd = process.cwd();
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-secretary-scope-'));
    try {
      fs.mkdirSync(path.join(testRoot, 'roles', 'secretary-cat', 'skills', 'message-drafting'), { recursive: true });
      fs.writeFileSync(
        path.join(testRoot, 'roles', 'secretary-cat', 'role.json'),
        JSON.stringify({
          name: 'secretary-cat',
          displayName: 'SecretaryCat',
          inheritBaseSkills: false,
          inheritBaseTools: false,
          baseToolAllowlist: ['skill'],
          toolVisibility: {
            mode: 'skill_scoped',
            defaultTools: ['skill', 'feishu_auth_status', 'feishu_auth_login_start', 'feishu_auth_login_complete'],
            skillToolsets: {
              message: ['feishu_contact_search', 'feishu_message_draft', 'feishu_message_send_confirmed'],
            },
          },
          skillToolsetAliases: {
            'message-drafting': ['message'],
          },
          confirmedToolGate: {
            requireImmediateUserConfirmation: true,
            tools: ['feishu_message_send_confirmed'],
          },
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(testRoot, 'roles', 'secretary-cat', 'skills', 'message-drafting', 'SKILL.md'),
        [
          '---',
          'name: message-drafting',
          'description: Draft Feishu messages safely.',
          'toolsets:',
          '  - message',
          '---',
          '',
          '# Message Drafting',
          '',
          'Draft first, then wait for confirmation before sending.',
        ].join('\n'),
        'utf-8',
      );
      process.chdir(testRoot);

      const aiService = new SecretaryScopedAIService([
        {
          content: null,
          toolCalls: [{
            id: 'activate-message',
            type: 'function',
            function: {
              name: 'skill',
              arguments: JSON.stringify({ skill: 'message-drafting' }),
            },
          }],
        },
        { content: 'Draft ready. Please confirm.' },
        { content: 'Confirmed send path is visible.' },
      ]);
      const session = new AgentSession('chat:secretary-scope', {
        aiService: aiService as any,
        toolManager: createRoleAwareToolManager(testRoot, {}, 'secretary-cat'),
        skillManager: new SkillManager('secretary-cat'),
        roleName: 'secretary-cat',
      }, 'chat');

      await session.handleMessage('帮我给小张写条飞书消息');
      await session.handleMessage('确认发送');

      assert.deepEqual(aiService.requests[0].tools.map(tool => tool.name).sort(), [
        'feishu_auth_login_complete',
        'feishu_auth_login_start',
        'feishu_auth_status',
        'skill',
      ]);
      assert.ok(aiService.requests[1].tools.some(tool => tool.name === 'feishu_message_draft'));
      assert.ok(!aiService.requests[1].tools.some(tool => tool.name === 'feishu_message_send_confirmed'));
      assert.ok(aiService.requests[2].tools.some(tool => tool.name === 'feishu_message_send_confirmed'));
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('SecretaryCat wrappers stay available when all scoped toolsets are active', async () => {
    const manager = createRoleAwareToolManager(process.cwd(), {}, 'secretary-cat');
    const toolNames = manager.getToolDefinitions({
      roleName: 'secretary-cat',
      activeSkillName: 'base',
      activeToolsets: [
        'calendar',
        'message',
        'task',
        'mail',
        'minutes',
        'docs',
        'drive',
        'sheets',
        'base',
      ],
      conversationHistory: [{ role: 'user', content: '确认创建更新发送' }],
    }).map(tool => tool.name).sort();

    assert.ok(toolNames.includes('feishu_auth_status'));
    assert.ok(toolNames.includes('feishu_calendar_agenda'));
    assert.ok(toolNames.includes('feishu_message_draft'));
    assert.ok(toolNames.includes('feishu_task_list'));
    assert.ok(toolNames.includes('feishu_mail_triage'));
    assert.ok(toolNames.includes('feishu_minutes_search'));
    assert.ok(toolNames.includes('feishu_docs_fetch'));
    assert.ok(toolNames.includes('feishu_drive_search'));
    assert.ok(toolNames.includes('feishu_sheets_read'));
    assert.ok(toolNames.includes('feishu_base_record_list'));
    assert.ok(toolNames.includes('skill'));
    assert.ok(!toolNames.includes('send_text'));
    assert.ok(!toolNames.includes('send_file'));
    assert.ok(!toolNames.includes('read_file'));
    assert.ok(!toolNames.includes('glob'));
    assert.ok(!toolNames.includes('grep'));
    assert.ok(!toolNames.includes('execute_shell'));
    assert.ok(!toolNames.includes('write_file'));
    assert.ok(!toolNames.includes('edit_file'));
    assert.ok(!toolNames.includes('spawn_subagent'));

    const result = await manager.executeTool({
      id: 'shell-blocked',
      type: 'function',
      function: {
        name: 'execute_shell',
        arguments: JSON.stringify({ command: 'echo no' }),
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'TOOL_FORBIDDEN_FOR_ROLE');
  });

  test('SecretaryCat receives delivery tools only on channel-backed surfaces', async () => {
    const cliManager = createRoleAwareToolManager(process.cwd(), { surface: 'cli' }, 'secretary-cat');
    assert.ok(!cliManager.getToolDefinitions().some(tool => tool.name === 'send_text'));
    assert.ok(!cliManager.getToolDefinitions().some(tool => tool.name === 'send_file'));

    for (const surface of ['feishu', 'weixin', 'pet'] as const) {
      const missingChannelManager = createRoleAwareToolManager(process.cwd(), { surface }, 'secretary-cat');
      assert.ok(!missingChannelManager.getToolDefinitions().some(tool => tool.name === 'send_text'), `${surface} without channel should not receive send_text`);
      assert.ok(!missingChannelManager.getToolDefinitions().some(tool => tool.name === 'send_file'), `${surface} without channel should not receive send_file`);

      const manager = createRoleAwareToolManager(process.cwd(), {
        surface,
        channel: fakeChannel(surface),
      }, 'secretary-cat');
      const toolNames = manager.getToolDefinitions().map(tool => tool.name);
      assert.ok(!toolNames.includes('send_text'), `${surface} should not receive send_text before a scoped policy includes it`);
      assert.ok(!toolNames.includes('send_file'), `${surface} should not receive send_file before a scoped policy includes it`);
    }

    const cliSendResult = await cliManager.executeTool({
      id: 'send-text-cli-blocked',
      type: 'function',
      function: {
        name: 'send_text',
        arguments: JSON.stringify({ text: 'hello' }),
      },
    });
    assert.equal(cliSendResult.ok, false);
    assert.equal(cliSendResult.errorCode, 'TOOL_FORBIDDEN_FOR_SURFACE');
  });
});
