import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ConversationRunner } from '../src/runtime/harness/loop/conversation-runner';
import { Message, ChatResponse } from '../src/runtime/contracts';
import { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/runtime/contracts/tool';

class ScriptedAIService {
  requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  private index = 0;

  constructor(private readonly responses: ChatResponse[]) {}

  async chat(messages: Message[], tools: ToolDefinition[]): Promise<ChatResponse> {
    this.requests.push({
      messages: messages.map(message => ({ ...message })),
      tools,
    });
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) {
      throw new Error('No scripted response left');
    }
    return response;
  }
}

class SkillToolExecutor implements ToolExecutor {
  calls: ToolCall[] = [];

  getToolDefinitions(): ToolDefinition[] {
    return [{
      name: 'skill',
      description: 'Activate a skill',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      },
    }];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    this.calls.push(toolCall);
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: 'skill',
      ok: true,
      content: JSON.stringify({
        __type__: 'skill_activation',
        skillName: 'debug-skill',
        prompt: 'You are now debugging with extra care.',
        maxTurns: 2,
      }),
    };
  }
}

class ScopedSkillToolExecutor implements ToolExecutor {
  contexts: Array<Partial<any> | undefined> = [];

  getToolDefinitions(context?: Partial<any>): ToolDefinition[] {
    this.contexts.push(context);
    const skillTool: ToolDefinition = {
      name: 'skill',
      description: 'Activate a skill',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
        },
      },
    };
    if (context?.activeSkillName === 'calendar' || context?.activeToolsets?.includes('calendar')) {
      return [
        skillTool,
        {
          name: 'feishu_calendar_agenda',
          description: 'Query agenda',
          parameters: { type: 'object', properties: {} },
        },
      ];
    }
    return [skillTool];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: 'skill',
      ok: true,
      content: JSON.stringify({
        __type__: 'skill_activation',
        skillName: 'calendar',
        toolsets: ['calendar'],
        prompt: 'Calendar tools are active.',
      }),
    };
  }
}

function skillToolCall(): ToolCall {
  return {
    id: 'skill-call-1',
    type: 'function',
    function: {
      name: 'skill',
      arguments: JSON.stringify({ name: 'debug-skill' }),
    },
  };
}

describe('ConversationRunner skill activation integration', () => {
  test('turns a skill tool result into a system prompt for the next model request', async () => {
    const ai = new ScriptedAIService([
      {
        content: null,
        toolCalls: [skillToolCall()],
      },
      {
        content: 'debug skill is active',
      },
    ]);
    const executor = new SkillToolExecutor();
    const runner = new ConversationRunner(ai as any, executor, {
      stream: false,
      enableCompression: false,
      maxTurns: 5,
    });
    const messages: Message[] = [
      { role: 'system', content: 'base prompt' },
      { role: 'user', content: 'please use debug-skill' },
    ];

    const result = await runner.run(messages);

    assert.strictEqual(result.response, 'debug skill is active');
    assert.strictEqual(executor.calls.length, 1);
    assert.strictEqual(ai.requests.length, 2);

    const secondRequestSystemPrompts = ai.requests[1].messages
      .filter(message => message.role === 'system')
      .map(message => String(message.content));
    assert.ok(secondRequestSystemPrompts.includes('[skill:debug-skill]\nYou are now debugging with extra care.'));

    const skillPrompts = result.messages.filter(message =>
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('[skill:debug-skill]'),
    );
    assert.strictEqual(skillPrompts.length, 1);

    const toolResult = result.newMessages.find(message => message.role === 'tool');
    assert.ok(toolResult);
    assert.strictEqual(toolResult!.content, 'Skill "debug-skill" 已激活');
  });

  test('uses activated skill context to resolve the next visible tool set', async () => {
    const ai = new ScriptedAIService([
      {
        content: null,
        toolCalls: [skillToolCall()],
      },
      {
        content: 'calendar skill is active',
      },
    ]);
    const executor = new ScopedSkillToolExecutor();
    const runner = new ConversationRunner(ai as any, executor, {
      stream: false,
      enableCompression: false,
      maxTurns: 5,
    });
    const messages: Message[] = [
      { role: 'system', content: 'base prompt' },
      { role: 'user', content: 'please use calendar' },
    ];

    const result = await runner.run(messages);

    assert.strictEqual(result.response, 'calendar skill is active');
    assert.deepEqual(ai.requests[0].tools.map(tool => tool.name), ['skill']);
    assert.deepEqual(ai.requests[1].tools.map(tool => tool.name), ['skill', 'feishu_calendar_agenda']);
    assert.strictEqual(executor.contexts[0]?.activeSkillName, undefined);
    assert.strictEqual(executor.contexts.some(context => context?.activeSkillName === 'calendar'), true);
  });
});
