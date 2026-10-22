import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ConversationRunner } from '../src/runtime/harness/loop/conversation-runner';
import type { ChatResponse, Message } from '../src/runtime/contracts';
import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolResult, ToolSurface, ToolTranscriptMode } from '../src/runtime/contracts/tool';

function user(content: string): Message {
  return { role: 'user', content };
}

function assistant(content: string, toolCalls?: Message['tool_calls']): Message {
  return { role: 'assistant', content, tool_calls: toolCalls };
}

function tool(name: string, content: string, toolCallId: string): Message {
  return { role: 'tool', name, content, tool_call_id: toolCallId };
}

function system(content: string): Message {
  return { role: 'system', content };
}

function createToolDefinition(
  name: string,
  options: {
    transcriptMode?: ToolTranscriptMode;
    controlMode?: 'pause_turn';
  } = {},
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: {},
    },
    ...options,
  };
}

class InvalidJsonToolExecutor implements ToolExecutor {
  callCount = 0;

  getToolDefinitions(): ToolDefinition[] {
    return [createToolDefinition('demo')];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    this.callCount += 1;
    try {
      JSON.parse(toolCall.function.arguments);
    } catch (error: any) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: `工具参数解析错误: ${error.message}`,
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        retryable: false,
      };
    }
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: 'ok',
      ok: true,
    };
  }
}

class TwoStepAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));

    if (this.requests.length === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call-invalid-json',
            type: 'function',
            function: {
              name: 'demo',
              arguments: '{bad json',
            },
          },
        ],
      };
    }

    return {
      content: 'recovered',
    };
  }

  async chat(messages: Message[]): Promise<ChatResponse> {
    return this.chatStream(messages);
  }
}

class RecordingAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    return { content: 'ok' };
  }

  async chat(messages: Message[]): Promise<ChatResponse> {
    return this.chatStream(messages);
  }
}

class StreamingFinalAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[], _tools?: ToolDefinition[], callbacks?: { onText?: (text: string) => void }): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    callbacks?.onText?.('fallback ok');
    return { content: 'fallback ok' };
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    return this.chatStream(messages, tools);
  }
}

class OutboundThenFinalAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    if (this.requests.length === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'send-text-call',
            type: 'function',
            function: {
              name: 'send_text',
              arguments: JSON.stringify({ text: '先给你结论' }),
            },
          },
        ],
      };
    }
    return { content: '好的，已发送' };
  }

  async chat(messages: Message[]): Promise<ChatResponse> {
    return this.chatStream(messages);
  }
}

class OutboundTextExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [createToolDefinition('send_text', { transcriptMode: 'outbound_message' })];
  }

  async executeTool(
    toolCall: ToolCall,
    _conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    await contextOverrides?.channel?.reply(contextOverrides.channel.chatId, args.text);
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: '已发送',
      ok: true,
    };
  }
}

class PauseAfterFirstToolAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    return {
      content: null,
      toolCalls: [
        { id: 'pause-call', type: 'function', function: { name: 'pause_tool', arguments: '{}' } },
        { id: 'later-call', type: 'function', function: { name: 'demo', arguments: '{}' } },
      ],
    };
  }

  async chat(messages: Message[]): Promise<ChatResponse> {
    return this.chatStream(messages);
  }
}

class PauseToolExecutor implements ToolExecutor {
  callNames: string[] = [];

  getToolDefinitions(): ToolDefinition[] {
    return [
      createToolDefinition('pause_tool', { controlMode: 'pause_turn' }),
      createToolDefinition('demo'),
    ];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    this.callNames.push(toolCall.function.name);
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: `${toolCall.function.name} done`,
      ok: true,
      controlSignal: toolCall.function.name === 'pause_tool' ? 'pause_turn' : undefined,
    };
  }
}

class SuppressedToolAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    if (this.requests.length === 1) {
      return {
        content: null,
        toolCalls: [
          { id: 'suppressed-call', type: 'function', function: { name: 'quiet_tool', arguments: '{}' } },
        ],
      };
    }
    return { content: 'after suppress' };
  }

  async chat(messages: Message[]): Promise<ChatResponse> {
    return this.chatStream(messages);
  }
}

class SuppressedToolExecutor implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] {
    return [createToolDefinition('quiet_tool', { transcriptMode: 'suppress' })];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: 'quiet ok',
      ok: true,
    };
  }
}

class MultiToolAIService {
  requests: Message[][] = [];

  async chatStream(messages: Message[]): Promise<ChatResponse> {
    this.requests.push(messages.map(message => ({ ...message })));
    return {
      content: null,
      toolCalls: [
        { id: 'first-call', type: 'function', function: { name: 'demo', arguments: '{"step":1}' } },
        { id: 'second-call', type: 'function', function: { name: 'demo', arguments: '{"step":2}' } },
        { id: 'third-call', type: 'function', function: { name: 'demo', arguments: '{"step":3}' } },
      ],
    };
  }

  async chat(messages: Message[]): Promise<ChatResponse> {
    return this.chatStream(messages);
  }
}

class RecordingToolExecutor implements ToolExecutor {
  callIds: string[] = [];

  getToolDefinitions(): ToolDefinition[] {
    return [createToolDefinition('demo')];
  }

  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    this.callIds.push(toolCall.id);
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: `${toolCall.id} ok`,
      status: 'success',
      ok: true,
    };
  }
}

function assertValidToolTranscript(messages: Message[]): void {
  let pendingToolCallIds: Set<string> | null = null;

  for (const message of messages.filter(msg => msg.role !== 'system')) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      assert.strictEqual(pendingToolCallIds, null, 'previous assistant tool calls were not completed');
      pendingToolCallIds = new Set(message.tool_calls.map(toolCall => toolCall.id));
      continue;
    }

    if (message.role === 'tool') {
      assert.ok(pendingToolCallIds, `orphan tool message ${message.name || ''}`);
      assert.ok(message.tool_call_id, 'tool message missing tool_call_id');
      assert.ok(pendingToolCallIds!.has(message.tool_call_id!), `unexpected tool_call_id ${message.tool_call_id}`);
      pendingToolCallIds!.delete(message.tool_call_id!);
      if (pendingToolCallIds!.size === 0) {
        pendingToolCallIds = null;
      }
      continue;
    }

    assert.strictEqual(pendingToolCallIds, null, 'non-tool message appeared before all tool results');
  }

  assert.strictEqual(pendingToolCallIds, null, 'assistant tool calls were left without tool results');
}

describe('ConversationRunner harness safeguards', () => {
  test('reports runner compaction with compact-after messages', async () => {
    const aiService = new RecordingAIService();
    const events: any[] = [];
    const runner = new ConversationRunner(aiService as any, new InvalidJsonToolExecutor(), {
      maxContextTokens: 80,
      onContextCompaction: event => events.push(event),
    });

    const result = await runner.run([
      user('第一轮：记住不要改无关文件。'),
      assistant('已记住。'),
      user('第二轮：命令坏了。'),
      assistant('我先看证据。'),
      user('第三轮：路径在 workspace 里。'),
      assistant('收到。'),
      user('第四轮：继续。'),
    ]);

    assert.strictEqual(result.response, 'ok');
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'conversation_runner');
    assert.equal(events[0].status, 'success');
    assert.equal(events[0].reason, 'threshold_exceeded');
    assert.equal(events[0].turn, 1);
    assert.equal(typeof events[0].tokens_before, 'number');
    assert.equal(typeof events[0].tokens_after, 'number');
    assert.ok(events[0].messages_after < events[0].messages_before);
    assert.ok(events[0].messages.some((message: Message) =>
      message.role === 'system' && String(message.content).startsWith('[compact_boundary]')
    ));
  });

  test('channel-backed message surfaces hide final text by default', async () => {
    const messageSurfaces: ToolSurface[] = ['feishu', 'weixin', 'pet'];
    for (const surface of messageSurfaces) {
      const aiService = new StreamingFinalAIService();
      const deliveries: string[] = [];
      const streamedText: string[] = [];
      const runner = new ConversationRunner(aiService as any, new InvalidJsonToolExecutor(), {
        enableCompression: false,
        toolExecutionContext: {
          surface,
          channel: {
            chatId: `${surface}-chat`,
            reply: async (chatId, text) => {
              deliveries.push(`${chatId}:${text}`);
            },
            sendFile: async () => undefined,
          },
        },
      });

      const result = await runner.run([user(`hello ${surface}`)], {
        onText: text => streamedText.push(text),
      });

      assert.strictEqual(result.response, 'fallback ok');
      assert.strictEqual(result.finalResponseVisible, false);
      assert.deepStrictEqual(streamedText, []);
      assert.deepStrictEqual(deliveries, []);
      assert.strictEqual(result.toolResults.length, 0);
      assert.ok(result.messages.some(message => message.role === 'assistant' && message.content === 'fallback ok'));
    }
  });

  test('channel-backed message surfaces use final text as fallback delivery only when enabled', async () => {
    const messageSurfaces: ToolSurface[] = ['feishu', 'weixin', 'pet'];
    for (const surface of messageSurfaces) {
      const aiService = new StreamingFinalAIService();
      const deliveries: string[] = [];
      const streamedText: string[] = [];
      const runner = new ConversationRunner(aiService as any, new InvalidJsonToolExecutor(), {
        enableCompression: false,
        toolExecutionContext: {
          surface,
          channel: {
            chatId: `${surface}-chat`,
            reply: async (chatId, text) => {
              deliveries.push(`${chatId}:${text}`);
            },
            sendFile: async () => undefined,
          },
        },
        deliveryFallbackFinalReply: true,
      });

      const result = await runner.run([user(`hello ${surface}`)], {
        onText: text => streamedText.push(text),
      });

      assert.strictEqual(result.response, 'fallback ok');
      assert.strictEqual(result.finalResponseVisible, true);
      assert.deepStrictEqual(streamedText, []);
      assert.deepStrictEqual(deliveries, [`${surface}-chat:fallback ok`]);
      assert.strictEqual(result.toolResults.length, 1);
      assert.strictEqual(result.toolResults[0].toolName, 'send_text');
      assert.strictEqual(result.toolResults[0].result.status, 'success');
      assert.strictEqual(result.toolResults[0].result.delivery_evidence?.[0]?.delivery_type, 'text');
      assert.strictEqual(result.toolResults[0].result.delivery_evidence?.[0]?.status, 'delivered');
      assert.strictEqual(result.toolResults[0].result.delivery_evidence?.[0]?.text_preview, 'fallback ok');
      assert.deepStrictEqual(
        JSON.parse(result.toolResults[0].toolCall.function.arguments),
        { text: 'fallback ok', _delivery_fallback: true },
      );
    }
  });

  test('channel-backed surfaces suppress final text after send_text delivered', async () => {
    const aiService = new OutboundThenFinalAIService();
    const deliveries: string[] = [];
    const runner = new ConversationRunner(aiService as any, new OutboundTextExecutor(), {
      enableCompression: false,
      toolExecutionContext: {
        surface: 'feishu',
        channel: {
          chatId: 'feishu-chat',
          reply: async (chatId, text) => {
            deliveries.push(`${chatId}:${text}`);
          },
          sendFile: async () => undefined,
        },
      },
    });

    const result = await runner.run([user('send it')]);

    assert.strictEqual(result.response, '');
    assert.strictEqual(result.finalResponseVisible, false);
    assert.deepStrictEqual(deliveries, ['feishu-chat:先给你结论']);
    assert.strictEqual(aiService.requests.length, 2);
    assert.strictEqual(result.toolResults.length, 1);
    assert.strictEqual(result.toolResults[0].toolCall.id, 'send-text-call');
    assert.strictEqual(result.toolResults[0].result.ok, true);
    assert.ok(result.messages.some(message => message.role === 'tool' && message.name === 'send_text'));
    assert.ok(!result.messages.some(message => message.role === 'assistant' && message.content === '好的，已发送'));
  });

  test('cli surface returns final text without channel auto-delivery', async () => {
    const aiService = new RecordingAIService();
    const deliveries: string[] = [];
    const runner = new ConversationRunner(aiService as any, new InvalidJsonToolExecutor(), {
      enableCompression: false,
      toolExecutionContext: {
        surface: 'cli',
        channel: {
          chatId: 'cli-chat',
          reply: async (_chatId, text) => {
            deliveries.push(text);
          },
          sendFile: async () => undefined,
        },
      },
    });

    const result = await runner.run([user('hello cli')]);

    assert.strictEqual(result.response, 'ok');
    assert.strictEqual(result.finalResponseVisible, true);
    assert.deepStrictEqual(deliveries, []);
  });

  test('bad tool JSON is returned as a tool error instead of aborting the run', async () => {
    const aiService = new TwoStepAIService();
    const executor = new InvalidJsonToolExecutor();
    const runner = new ConversationRunner(aiService as any, executor, {
      enableCompression: false,
    });
    const toolStarts: unknown[] = [];

    const result = await runner.run([user('call demo with malformed args')], {
      onToolStart: (_name, _id, input) => {
        toolStarts.push(input);
      },
    });

    assert.strictEqual(result.response, 'recovered');
    assert.strictEqual(executor.callCount, 1);
    assert.strictEqual(aiService.requests.length, 2);
    assert.deepStrictEqual(toolStarts, [{ _invalidJson: true, raw: '{bad json' }]);
    assert.ok(result.newMessages.some(message =>
      message.role === 'tool'
      && message.name === 'demo'
      && String(message.content).includes('工具参数解析错误')
      && message.errorCode === undefined,
    ));
    assert.ok(aiService.requests[1].some(message =>
      message.role === 'tool'
      && message.name === 'demo'
      && String(message.content).includes('工具参数解析错误')
    ));
  });

  test('hard trimming keeps provider-visible tool transcripts well paired', () => {
    const runner = new ConversationRunner({} as any, new InvalidJsonToolExecutor(), {
      enableCompression: false,
    });
    const messages: Message[] = [
      system('base'),
      user('first'),
      assistant('', [
        { id: 'call-1', type: 'function', function: { name: 'demo', arguments: '{"a":1}' } },
        { id: 'call-2', type: 'function', function: { name: 'demo', arguments: '{"b":2}' } },
      ]),
      tool('demo', 'result 1', 'call-1'),
      tool('demo', 'result 2', 'call-2'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('u4'),
      assistant('a4'),
      user('u5'),
      assistant('a5'),
    ];

    const trimmed = (runner as any).hardTrimMessages(messages, 100000) as Message[];

    assertValidToolTranscript(trimmed);
    assert.ok(trimmed.some(message =>
      message.role === 'assistant'
      && message.tool_calls?.some(toolCall => toolCall.id === 'call-1')
    ));
    assert.ok(trimmed.some(message => message.role === 'tool' && message.tool_call_id === 'call-2'));
  });

  test('historical orphan and incomplete tool transcripts are sanitized before provider requests', async () => {
    const aiService = new RecordingAIService();
    const runner = new ConversationRunner(aiService as any, new InvalidJsonToolExecutor(), {
      enableCompression: false,
    });
    const messages: Message[] = [
      system('base'),
      tool('demo', 'orphan result', 'orphan-call'),
      assistant('', [
        { id: 'missing-result', type: 'function', function: { name: 'demo', arguments: '{}' } },
      ]),
      user('continue'),
    ];

    await runner.run(messages);

    assert.strictEqual(aiService.requests.length, 1);
    assertValidToolTranscript(aiService.requests[0]);
    assert.ok(!aiService.requests[0].some(message => message.role === 'tool'));
    assert.ok(!aiService.requests[0].some(message =>
      message.role === 'assistant' && message.tool_calls?.some(toolCall => toolCall.id === 'missing-result')
    ));
    assertValidToolTranscript(messages);
  });

  test('pause_turn after a partial multi-tool response only records executed tool calls', async () => {
    const aiService = new PauseAfterFirstToolAIService();
    const executor = new PauseToolExecutor();
    const runner = new ConversationRunner(aiService as any, executor, {
      enableCompression: false,
    });

    const result = await runner.run([user('pause after first tool')]);

    assert.strictEqual(result.finalResponseVisible, false);
    assert.deepStrictEqual(executor.callNames, ['pause_tool']);
    assertValidToolTranscript(result.messages);
    const assistantWithTools = result.newMessages.find(message =>
      message.role === 'assistant' && message.tool_calls?.length
    );
    assert.deepStrictEqual(
      assistantWithTools?.tool_calls?.map(toolCall => toolCall.id),
      ['pause-call'],
    );
    assert.ok(!result.newMessages.some(message =>
      message.role === 'assistant' && message.tool_calls?.some(toolCall => toolCall.id === 'later-call')
    ));
  });

  test('successful suppress transcript tools do not leave dangling assistant tool calls', async () => {
    const aiService = new SuppressedToolAIService();
    const runner = new ConversationRunner(aiService as any, new SuppressedToolExecutor(), {
      enableCompression: false,
    });

    const result = await runner.run([user('run quiet tool')]);

    assert.strictEqual(result.response, 'after suppress');
    assert.strictEqual(aiService.requests.length, 2);
    assert.strictEqual(result.toolResults.length, 1);
    assert.strictEqual(result.toolResults[0].toolCall.id, 'suppressed-call');
    assert.strictEqual(result.toolResults[0].result.content, 'quiet ok');
    assertValidToolTranscript(result.messages);
    assert.ok(!result.newMessages.some(message => message.role === 'tool' && message.name === 'quiet_tool'));
    assert.ok(!result.newMessages.some(message =>
      message.role === 'assistant' && message.tool_calls?.some(toolCall => toolCall.id === 'suppressed-call')
    ));
  });

  test('interrupt during multi-tool execution records pending calls as cancelled evidence', async () => {
    const aiService = new MultiToolAIService();
    const executor = new RecordingToolExecutor();
    let shouldContinueChecks = 0;
    const runner = new ConversationRunner(aiService as any, executor, {
      enableCompression: false,
      shouldContinue: () => {
        shouldContinueChecks += 1;
        return shouldContinueChecks <= 2;
      },
    });

    const result = await runner.run([user('start three tools then stop')]);

    assert.strictEqual(result.response, '');
    assert.strictEqual(result.finalResponseVisible, false);
    assert.deepStrictEqual(executor.callIds, ['first-call']);
    assert.strictEqual(result.toolResults.length, 3);
    assert.strictEqual(result.toolResults[0].result.status, 'success');
    assert.strictEqual(result.toolResults[1].toolCall.id, 'second-call');
    assert.strictEqual(result.toolResults[1].result.status, 'cancelled');
    assert.strictEqual(result.toolResults[1].result.error_code, 'TOOL_CANCELLED');
    assert.strictEqual(result.toolResults[1].result.retryable, false);
    assert.match(String(result.toolResults[1].result.content), /工具调用已取消/);
    assert.strictEqual(result.toolResults[2].toolCall.id, 'third-call');
    assert.strictEqual(result.toolResults[2].result.status, 'cancelled');
    assertValidToolTranscript(result.messages);

    const assistantWithTools = result.newMessages.find(message =>
      message.role === 'assistant' && message.tool_calls?.length
    );
    assert.deepStrictEqual(
      assistantWithTools?.tool_calls?.map(toolCall => toolCall.id),
      ['first-call'],
    );
    assert.ok(!result.newMessages.some(message =>
      message.role === 'assistant' && message.tool_calls?.some(toolCall => toolCall.id === 'second-call')
    ));
  });

  test('duplicate historical tool call ids are normalized before provider requests', async () => {
    const aiService = new RecordingAIService();
    const runner = new ConversationRunner(aiService as any, new InvalidJsonToolExecutor(), {
      enableCompression: false,
    });
    const messages: Message[] = [
      user('dedupe'),
      assistant('', [
        { id: 'dup-call', type: 'function', function: { name: 'demo', arguments: '{"first":true}' } },
        { id: 'dup-call', type: 'function', function: { name: 'demo', arguments: '{"second":true}' } },
      ]),
      tool('demo', 'single result', 'dup-call'),
      user('continue'),
    ];

    await runner.run(messages);

    assertValidToolTranscript(aiService.requests[0]);
    const assistantWithTools = aiService.requests[0].find(message =>
      message.role === 'assistant' && message.tool_calls?.length
    );
    assert.deepStrictEqual(
      assistantWithTools?.tool_calls?.map(toolCall => toolCall.id),
      ['dup-call'],
    );
  });
});
