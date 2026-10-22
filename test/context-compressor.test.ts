import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  ContextCompressor,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_MAX_CONTEXT_TOKENS,
  contentToString,
  messagesToConversationText,
  parseCompactSummary,
  buildCompactSystemPrompt,
} from '../src/runtime/harness/context/context-compressor';
import type { Message } from '../src/runtime/contracts';
import type { AIService } from '../src/runtime/harness/models/ai-service';

// ─── 测试辅助 ─────────────────────────────────────────────

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

function mockAIService(summaryText: string): AIService {
  return {
    chatStream: async (_messages, _tools, callbacks) => {
      callbacks?.onText?.(`<summary>\n${summaryText}\n</summary>`);
      return {
        content: `<summary>\n${summaryText}\n</summary>`,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
    chat: async () => ({
      content: `<summary>\n${summaryText}\n</summary>`,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }),
  } as unknown as AIService;
}

// ─── contentToString ─────────────────────────────────────

describe('contentToString', () => {
  test('string content', () => {
    const result = contentToString('hello');
    assert.equal(result, 'hello');
  });

  test('null returns empty string', () => {
    const result = contentToString(null);
    assert.equal(result, '');
  });

  test('ContentBlock[] with text', () => {
    const result = contentToString([{ type: 'text', text: 'hi' }]);
    assert.equal(result, 'hi');
  });

  test('ContentBlock[] with image returns [图片]', () => {
    const result = contentToString([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } } as any]);
    assert.equal(result, '[图片]');
  });

  test('ContentBlock[] mixed', () => {
    const result = contentToString([{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } } as any]);
    assert.equal(result, 'hello[图片]');
  });
});

// ─── messagesToConversationText ───────────────────────────

describe('messagesToConversationText', () => {
  test('单条 user 消息', () => {
    const msgs = [user('你好')];
    const result = messagesToConversationText(msgs);
    assert.equal(result, '[用户] 你好');
  });

  test('单条 assistant 消息', () => {
    const msgs = [assistant('今天天气不错')];
    const result = messagesToConversationText(msgs);
    assert.equal(result, '[AI] 今天天气不错');
  });

  test('工具调用链格式化正确', () => {
    const msgs = [
      user('帮我读这个文件'),
      assistant('好的', [
        { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"a.txt"}' } },
      ]),
      tool('read_file', '文件内容是 hello world', 'tc1'),
      assistant('文件内容是 hello world'),
    ];
    const result = messagesToConversationText(msgs);
    assert.ok(result.includes('[用户]'), '应包含用户消息');
    assert.ok(result.includes('[AI]'), '应包含AI消息');
    assert.ok(result.includes('[工具 read_file]'), '应包含工具消息');
  });

  test('过长的工具输出被压缩为头尾预览', () => {
    const longContent = 'a'.repeat(2000);
    const msgs = [tool('bash', longContent, 'tc1')];
    const result = messagesToConversationText(msgs);
    assert.ok(result.includes('[tool:bash] 输出已压缩'), '应包含压缩标记');
    assert.ok(result.includes('原始长度: 2000 字符'), '应包含长度信息');
  });

  test('长单行工具输出也会被硬截断', () => {
    const longContent = 'single-line-output-'.repeat(400);
    const msgs = [tool('bash', longContent, 'tc1')];
    const result = messagesToConversationText(msgs);
    assert.ok(result.includes('[tool:bash] 输出已压缩'), '应包含压缩标记');
    assert.ok(result.length < 1700, `压缩后不应继续携带整段输出，实际长度 ${result.length}`);
  });
});

// ─── parseCompactSummary ─────────────────────────────────

describe('parseCompactSummary', () => {
  test('正常提取 summary 内容', () => {
    const raw = '<analysis>分析</analysis>\n\n<summary>\n这是摘要\n</summary>';
    const result = parseCompactSummary(raw);
    assert.equal(result, '这是摘要');
  });

  test('没有 analysis 标签', () => {
    const raw = '<summary>\n纯摘要\n</summary>';
    const result = parseCompactSummary(raw);
    assert.equal(result, '纯摘要');
  });

  test('没有标签时返回原文', () => {
    const raw = '没有标签';
    const result = parseCompactSummary(raw);
    assert.equal(result, '没有标签');
  });

  test('多行摘要', () => {
    const raw = '<summary>\n第一行\n第二行\n</summary>';
    const result = parseCompactSummary(raw);
    assert.equal(result, '第一行\n第二行');
  });
});

// ─── buildCompactSystemPrompt ─────────────────────────────

describe('buildCompactSystemPrompt', () => {
  test('生成包含禁止工具调用的说明', () => {
    const prompt = buildCompactSystemPrompt();
    assert.ok(prompt.includes('Do NOT call any tools'), '应包含禁止工具调用');
  });

  test('生成包含 working-memory 要求', () => {
    const prompt = buildCompactSystemPrompt();
    assert.ok(prompt.includes('Create a working-memory summary'), '应包含新的摘要目标');
    assert.ok(prompt.includes('Next State'), '应包含 Next State 段落');
  });

  test('customInstructions 追加到 prompt', () => {
    const prompt = buildCompactSystemPrompt('聚焦代码变更');
    assert.ok(prompt.includes('Additional Instructions'), '应包含追加标记');
    assert.ok(prompt.includes('聚焦代码变更'), '应包含自定义指令');
  });

  test('空白 customInstructions 不追加', () => {
    const prompt = buildCompactSystemPrompt('   ');
    assert.ok(!prompt.includes('Additional Instructions'));
  });
});

// ─── ContextCompressor.compact ───────────────────────────

describe('ContextCompressor.compact', () => {
  let aiService: AIService;

  beforeEach(() => {
    aiService = mockAIService('1. 用户要求读文件\n2. 已完成');
  });

  test('压缩旧上下文并保留最后一轮 IM anchor', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [
      system('你是小八'),
      system('[surface:feishu:private]'),
      user('第零轮'),
      assistant('第零轮回答'),
      user('第一轮'),
      assistant('第一轮回答'),
      user('你好'),
      assistant('hi'),
      user('帮我读 a.txt'),
      assistant('ok', [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]),
      tool('read_file', 'hello', 'tc1'),
      assistant('文件内容是 hello'),
    ];

    const result = await compressor.compact(messages);

    const systemMsgs = result.filter(m => m.role === 'system');
    assert.ok(systemMsgs.length >= 4, `应保留基础 system 并生成压缩治理消息，实际 ${systemMsgs.length}`);

    const boundaryMsg = result.find(m => m.role === 'system' && (m.content as string).includes('[compact_boundary]'));
    assert.ok(boundaryMsg !== undefined, '应有 boundary 消息');

    const memoryMsg = result.find(m => m.role === 'system' && (m.content as string).includes('[session_memory]'));
    assert.ok(memoryMsg !== undefined, '应有 session memory');
    assert.ok((memoryMsg!.content as string).includes('用户要求读文件'));

    const recentUserMessages = result.filter(m => m.role === 'user');
    assert.equal(recentUserMessages.length, 1, '压缩后应硬保留最后一轮 user 原文');
    assert.ok(recentUserMessages.some(m => m.content === '第零轮') === false);
    assert.ok(recentUserMessages.some(m => m.content === '帮我读 a.txt'));

    const anchor = result.find(m => m.role === 'system' && String(m.content).startsWith('[last_turn_anchor]'));
    assert.ok(anchor, '应有 last turn anchor');
    assert.ok(String(anchor!.content).includes('帮我读 a.txt'));
  });

  test('压缩后会生成新的 boundary 和 memory system 消息', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [
      system('base'),
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('读文件'),
      assistant('ok', [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{}' } }]),
      tool('read', 'file content', 'tc1'),
    ];

    const result = await compressor.compact(messages);

    const boundary = result.find(msg => msg.role === 'system' && String(msg.content).includes('[compact_boundary]'));
    const memory = result.find(msg => msg.role === 'system' && String(msg.content).includes('[session_memory]'));
    assert.ok(boundary);
    assert.ok(memory);
  });

  test('过长的 AI 摘要会被限制在 session memory 预算内', async () => {
    const longSummaryService = mockAIService('S'.repeat(12000));
    const compressor = new ContextCompressor(longSummaryService);
    const messages: Message[] = [
      system('base'),
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('u4'),
      assistant('a4'),
    ];

    const result = await compressor.compact(messages);
    const memory = result.find(m => m.role === 'system' && String(m.content).startsWith('[session_memory]'));
    assert.ok(memory);
    assert.ok(String(memory!.content).length < 6500, `memory 过长: ${String(memory!.content).length}`);
    assert.ok(String(memory!.content).includes('中间省略'), '应保留头尾并标记省略');
  });

  test('stream 未回调文本时使用最终 content 作为摘要', async () => {
    const contentOnlyService = {
      chatStream: async () => ({
        content: '<summary>\n最终摘要\n</summary>',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    } as unknown as AIService;
    const compressor = new ContextCompressor(contentOnlyService);
    const messages: Message[] = [
      system('base'),
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('u4'),
      assistant('a4'),
    ];

    const result = await compressor.compact(messages);
    const memory = result.find(m => m.role === 'system' && String(m.content).startsWith('[session_memory]'));
    assert.ok(memory);
    assert.ok(String(memory!.content).includes('最终摘要'));
  });

  test('最近保留区里的长工具输出会被压缩', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [
      system('base'),
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('run command'),
      assistant('ok', [{ id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{}' } }]),
      tool('bash', 'line'.repeat(2000), 'tc1'),
    ];

    const result = await compressor.compact(messages);
    const toolMsg = result.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(String(toolMsg!.content).includes('[tool:bash] 输出已压缩'));
    assert.ok(String(toolMsg!.content).length < 1600, `tool content 过长: ${String(toolMsg!.content).length}`);
  });

  test('最后一轮保留 send_text 原文和 send_file 路径', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [
      system('base'),
      user('旧问题 1'),
      assistant('旧回答 1'),
      user('旧问题 2'),
      assistant('旧回答 2'),
      user('旧问题 3'),
      assistant('旧回答 3'),
      user('请生成报告并发给我'),
      assistant('我来处理', [
        { id: 'tc1', type: 'function', function: { name: 'send_text', arguments: '{"text":"报告已生成，我先把摘要发你。"}' } },
        { id: 'tc2', type: 'function', function: { name: 'send_file', arguments: '{"file_path":"E:/tmp/report.md","file_name":"report.md"}' } },
      ]),
      tool('send_text', '已发送', 'tc1'),
      tool('send_file', '文件 "report.md" 已发送', 'tc2'),
      assistant('都发完了'),
    ];

    const result = await compressor.compact(messages);
    const anchor = result.find(m => m.role === 'system' && String(m.content).startsWith('[last_turn_anchor]'));
    assert.ok(anchor);
    assert.ok(String(anchor!.content).includes('请生成报告并发给我'));
    assert.ok(String(anchor!.content).includes('报告已生成，我先把摘要发你。'));
    assert.ok(String(anchor!.content).includes('E:/tmp/report.md'));
    assert.ok(String(anchor!.content).includes('report.md'));
  });

  test('最后一轮巨大 tool result 只能进入预算尾巴，不能挤掉 anchor', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [
      system('base'),
      user('旧问题 1'),
      assistant('旧回答 1'),
      user('旧问题 2'),
      assistant('旧回答 2'),
      user('旧问题 3'),
      assistant('旧回答 3'),
      user('跑一下超长命令'),
      assistant('开始跑', [
        { id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } },
      ]),
      tool('bash', 'very-long-output\n'.repeat(2000), 'tc1'),
      assistant('命令跑完了'),
    ];

    const result = await compressor.compact(messages);
    const anchor = result.find(m => m.role === 'system' && String(m.content).startsWith('[last_turn_anchor]'));
    const lastUser = result.find(m => m.role === 'user' && m.content === '跑一下超长命令');
    const toolMsg = result.find(m => m.role === 'tool' && m.name === 'bash');

    assert.ok(anchor);
    assert.ok(lastUser, '最后用户原文不能被巨大工具输出挤掉');
    assert.ok(toolMsg, '尾巴预算允许时应保留工具预览');
    assert.ok(String(toolMsg!.content).includes('[tool:bash] 输出已压缩'));
    assert.ok(String(toolMsg!.content).length < 1600);
  });

  test('旧 IM 可见窗口会滚入 summary 输入而不是无限保留', async () => {
    let summaryInput = '';
    const capturingService = {
      chatStream: async (messages: Message[], _tools: unknown, callbacks: any) => {
        summaryInput = String(messages.find(m => m.role === 'user')?.content || '');
        callbacks?.onText?.('<summary>\n已合并旧 IM 可见事实\n</summary>');
        return {
          content: '<summary>\n已合并旧 IM 可见事实\n</summary>',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    } as unknown as AIService;
    const compressor = new ContextCompressor(capturingService);
    const messages: Message[] = [
      system('base'),
      system('[im_visible_transcript]\n旧窗口：已经告诉用户 A'),
      system('[last_turn_anchor]\n旧锚点：已经发送 old.md'),
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('u4'),
      assistant('a4'),
    ];

    const result = await compressor.compact(messages);
    assert.ok(summaryInput.includes('Previous IM Visible Transcript'));
    assert.ok(summaryInput.includes('已经告诉用户 A'));
    assert.ok(summaryInput.includes('Previous Last Turn Anchor'));
    assert.ok(summaryInput.includes('old.md'));
    assert.ok(result.filter(m => m.role === 'system' && String(m.content).startsWith('[im_visible_transcript]')).length <= 1);
    assert.ok(result.filter(m => m.role === 'system' && String(m.content).startsWith('[last_turn_anchor]')).length <= 1);
  });

  test('空 session 时保留 system 和既有 memory', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [system('base'), system('[session_memory]\n已有摘要')];
    const result = await compressor.compact(messages);
    assert.equal(result.length, 2);
    assert.ok((result[1].content as string).includes('已有摘要'));
  });

  test('AI 摘要失败时抛出异常', async () => {
    const failingService = {
      chatStream: async () => { throw new Error('API error'); },
    } as unknown as AIService;
    const compressor = new ContextCompressor(failingService);
    const messages: Message[] = [
      system('base'),
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('u4'),
      assistant('a4'),
    ];

    await assert.rejects(
      async () => compressor.compact(messages),
      /API error/
    );
  });

  test('compactWithFallback 在 AI 摘要失败时保留可继续工作的上下文', async () => {
    const failingService = {
      chatStream: async () => { throw new Error('API error'); },
    } as unknown as AIService;
    const compressor = new ContextCompressor(failingService);
    const messages: Message[] = [
      system('base'),
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
      user('u4'),
      assistant('a4'),
    ];

    const result = await compressor.compactWithFallback(messages);
    const memory = result.find(m => m.role === 'system' && String(m.content).startsWith('[session_memory]'));
    const boundary = result.find(m => m.role === 'system' && String(m.content).startsWith('[compact_boundary]'));
    assert.ok(memory);
    assert.ok(boundary);
    assert.ok(String(memory!.content).includes('Fallback Reason'));
    assert.equal(result.filter(m => m.role === 'user').length, 1, '兜底也应硬保留最后一轮 user 消息');
  });

  test('不足 3 轮时不生成 memory，只返回原会话', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [system('你是小八'), user('hello'), assistant('hi')];
    const result = await compressor.compact(messages);

    const roles = result.map(m => m.role);
    assert.equal(roles.filter(r => r === 'system').length, 1, '只保留原 system');
    assert.equal(roles.filter(r => r === 'user').length, 1, '保留原 user');
    assert.equal(roles.filter(r => r === 'assistant').length, 1, '保留原 assistant');
    assert.equal(roles.filter(r => r === 'tool').length, 0, '无 tool');
  });

  test('boundary 记录原始消息数和 token', async () => {
    const compressor = new ContextCompressor(aiService);
    const messages: Message[] = [
      system('base'),
      user('msg1'),
      assistant('ai1'),
      user('msg2'),
      assistant('ai2'),
      user('msg3'),
      assistant('ai3'),
      user('msg4'),
      assistant('ai4', [{ id: 'tc1', type: 'function', function: { name: 'x', arguments: '{}' } }]),
      tool('x', 'r1', 'tc1'),
    ];

    const result = await compressor.compact(messages);
    const boundary = result.find(m => m.role === 'system' && (m.content as string).includes('[compact_boundary]'));
    assert.ok(boundary !== undefined);
    assert.ok((boundary!.content as string).includes('older messages summarized'));
    assert.ok((boundary!.content as string).includes('Pre-compact tokens:'));
  });

  test('needsCompaction 正确判断', async () => {
    const compressor = new ContextCompressor(aiService, { maxContextTokens: 1000, compactionThreshold: 0.7 });
    const light: Message[] = [system('a'), user('b')];
    const heavy: Message[] = [system('a'), user('中'.repeat(900))];

    const lightResult = compressor.needsCompaction(light);
    const heavyResult = compressor.needsCompaction(heavy);
    assert.equal(lightResult, false);
    assert.equal(heavyResult, true);
  });

  test('getUsageInfo 返回正确结构', async () => {
    const compressor = new ContextCompressor(aiService, { maxContextTokens: 1000 });
    const info = compressor.getUsageInfo([system('a'), user('b')]);
    assert.equal(info.maxTokens, 1000);
    assert.equal(typeof info.usedTokens, 'number');
    assert.equal(typeof info.usagePercent, 'number');
  });

  test('默认压缩窗口对齐 Codex 实际长上下文口径', async () => {
    const compressor = new ContextCompressor(aiService);
    const info = compressor.getUsageInfo([system('a'), user('b')]);
    assert.equal(info.maxTokens, 258400);
    assert.equal(DEFAULT_MAX_CONTEXT_TOKENS, 258400);
    assert.equal(DEFAULT_COMPACTION_THRESHOLD, 0.7);
  });
});

// ─── 全流程 ─────────────────────────────────────────────

describe('全流程：压缩 → push current_input → 推理', () => {
  test('模拟 handleMessage：压缩后追加当前输入，结构正确', async () => {
    const historyMessages: Message[] = [
      system('你是小八'),
      user('第零个问题'),
      assistant('回答零'),
      user('第一个问题'),
      assistant('回答一'),
      user('第二个问题'),
      assistant('回答二'),
      user('第三个问题'),
      assistant('回答三'),
    ];

    const aiService = mockAIService('用户问了三个问题，已全部回答。第三个问题是关于XXX。');
    const compressor = new ContextCompressor(aiService);

    // Step 1: 压缩
    const afterCompact = await compressor.compact(historyMessages);

    // Step 2: push 当前输入
    afterCompact.push(user('请继续回答第四个问题'));

    // 验证结构
    const roles = afterCompact.map(m => m.role);
    assert.equal(roles.filter(r => r === 'system').length, 5, 'base + boundary + memory + visible transcript + last_turn_anchor');
    assert.equal(roles.filter(r => r === 'user').length, 2, '最后一轮 user + 当前输入');
    assert.equal(roles.filter(r => r === 'assistant').length, 1, '最后一轮 assistant 尾巴');
    assert.equal(roles.filter(r => r === 'tool').length, 0, '无 tool');

    // 最后一条是 current_input
    const lastMsg = afterCompact[afterCompact.length - 1];
    assert.ok((lastMsg.content as string).includes('第四个问题'));

    // 无任何 tool_call_id 或 tool_calls 残留
    for (const msg of afterCompact) {
      assert.equal(msg.tool_call_id, undefined);
      if (msg.role === 'assistant') {
        assert.equal((msg as any).tool_calls, undefined);
      }
    }
  });
});
