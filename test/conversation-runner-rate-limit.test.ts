import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ConversationRunner } from '../src/runtime/harness/loop/conversation-runner';
import { ToolCall, ToolExecutionContext, ToolExecutor, ToolResult } from '../src/runtime/contracts/tool';

class StubToolExecutor implements ToolExecutor {
  private index = 0;
  callCount = 0;

  constructor(private readonly results: ToolResult[]) {}

  getToolDefinitions() {
    return [];
  }

  async executeTool(toolCall?: ToolCall): Promise<ToolResult> {
    const next = this.results[Math.min(this.index, this.results.length - 1)];
    this.callCount += 1;
    this.index += 1;
    return {
      ...next,
      tool_call_id: toolCall?.id || next.tool_call_id,
      name: toolCall?.function.name || next.name,
    };
  }
}

const originalRetryDelay = (ConversationRunner as any).RETRY_BASE_DELAY_MS;
const originalMaxRetries = (ConversationRunner as any).MAX_RETRIES;

afterEach(() => {
  (ConversationRunner as any).RETRY_BASE_DELAY_MS = originalRetryDelay;
  (ConversationRunner as any).MAX_RETRIES = originalMaxRetries;
});

function createRunner(executor: ToolExecutor): ConversationRunner {
  return new ConversationRunner({} as any, executor, {
    enableCompression: false,
  });
}

function createToolCall(name: string): ToolCall {
  return createToolCallWithId('tool-call-1', name, {});
}

function createToolCallWithId(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function createContext(): Partial<ToolExecutionContext> {
  return {
    workingDirectory: process.cwd(),
    conversationHistory: [],
    surface: 'cli',
  };
}

describe('ConversationRunner bounded tool retry', () => {
  test('普通失败结果里出现 429 数字时不应误判为限流重试', async () => {
    const executor = new StubToolExecutor([
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'execute_shell',
        ok: true,
        content: '命令执行失败: 论文统计里有 429 个样本，但这不是限流错误',
      },
    ]);
    const runner = createRunner(executor);

    (ConversationRunner as any).RETRY_BASE_DELAY_MS = 0;
    (ConversationRunner as any).MAX_RETRIES = 1;

    const result = await (runner as any).executeToolWithRetry(
      createToolCall('execute_shell'),
      [],
      createContext(),
      1,
    );

    assert.strictEqual(executor.callCount, 1);
    assert.strictEqual(result.content, '命令执行失败: 论文统计里有 429 个样本，但这不是限流错误');
  });

  test('明确的 429 限流失败应触发一次重试', async () => {
    const executor = new StubToolExecutor([
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'send_text',
        ok: false,
        errorCode: 'RATE_LIMIT',
        retryable: true,
        content: '工具执行错误: 429 Too Many Requests',
      },
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'send_text',
        ok: true,
        content: '已发送',
      },
    ]);
    const runner = createRunner(executor);

    (ConversationRunner as any).RETRY_BASE_DELAY_MS = 0;
    (ConversationRunner as any).MAX_RETRIES = 1;

    const result = await (runner as any).executeToolWithRetry(
      createToolCall('send_text'),
      [],
      createContext(),
      1,
    );

    assert.strictEqual(executor.callCount, 2);
    assert.strictEqual(result.content, '已发送');
    assert.strictEqual(result.retry_count, 1);
    assert.strictEqual(result.retry_budget, 1);
    assert.strictEqual(result.retry_budget_exhausted, false);
  });

  test('连续 429 超过重试预算后应返回 blocked ToolResult', async () => {
    const executor = new StubToolExecutor([
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'send_text',
        status: 'failure',
        ok: false,
        error_code: 'RATE_LIMIT',
        errorCode: 'RATE_LIMIT',
        retryable: true,
        content: '工具执行错误: 429 Too Many Requests',
      },
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'send_text',
        status: 'failure',
        ok: false,
        error_code: 'RATE_LIMIT',
        errorCode: 'RATE_LIMIT',
        retryable: true,
        content: '工具执行错误: 429 Too Many Requests again',
      },
    ]);
    const runner = createRunner(executor);

    (ConversationRunner as any).RETRY_BASE_DELAY_MS = 0;
    (ConversationRunner as any).MAX_RETRIES = 1;

    const result = await (runner as any).executeToolWithRetry(
      createToolCall('send_text'),
      [],
      createContext(),
      1,
    );

    assert.strictEqual(executor.callCount, 2);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error_code, 'RATE_LIMIT');
    assert.strictEqual(result.errorCode, 'RATE_LIMIT');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.retry_count, 1);
    assert.strictEqual(result.retry_budget, 1);
    assert.strictEqual(result.retry_budget_exhausted, true);
    assert.match(result.blocked_reason || '', /Retry budget exhausted after 1 retry/);
    assert.match(String(result.content), /重试预算已耗尽/);
  });

  test('明确 retryable 的 timeout 失败应触发重试并记录预算', async () => {
    const executor = new StubToolExecutor([
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'execute_shell',
        status: 'timeout',
        ok: false,
        error_code: 'TOOL_TIMEOUT',
        errorCode: 'TOOL_TIMEOUT',
        retryable: true,
        content: '命令执行失败: timed out after 1000ms',
      },
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'execute_shell',
        status: 'success',
        ok: true,
        retryable: false,
        content: '命令执行成功',
      },
    ]);
    const runner = createRunner(executor);

    (ConversationRunner as any).RETRY_BASE_DELAY_MS = 0;
    (ConversationRunner as any).MAX_RETRIES = 1;

    const result = await (runner as any).executeToolWithRetry(
      createToolCall('execute_shell'),
      [],
      createContext(),
      1,
    );

    assert.strictEqual(executor.callCount, 2);
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.content, '命令执行成功');
    assert.strictEqual(result.retry_count, 1);
    assert.strictEqual(result.retry_budget, 1);
    assert.strictEqual(result.retry_budget_exhausted, false);
  });

  test('连续 timeout 超过重试预算后应返回 blocked ToolResult', async () => {
    const executor = new StubToolExecutor([
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'execute_shell',
        status: 'timeout',
        ok: false,
        error_code: 'TOOL_TIMEOUT',
        errorCode: 'TOOL_TIMEOUT',
        retryable: true,
        content: '命令执行失败: timed out after 1000ms',
      },
      {
        tool_call_id: 'tool-call-1',
        role: 'tool',
        name: 'execute_shell',
        status: 'timeout',
        ok: false,
        error_code: 'TOOL_TIMEOUT',
        errorCode: 'TOOL_TIMEOUT',
        retryable: true,
        content: '命令执行失败: timed out after 1000ms again',
      },
    ]);
    const runner = createRunner(executor);

    (ConversationRunner as any).RETRY_BASE_DELAY_MS = 0;
    (ConversationRunner as any).MAX_RETRIES = 1;

    const result = await (runner as any).executeToolWithRetry(
      createToolCall('execute_shell'),
      [],
      createContext(),
      1,
    );

    assert.strictEqual(executor.callCount, 2);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error_code, 'TOOL_TIMEOUT');
    assert.strictEqual(result.errorCode, 'TOOL_TIMEOUT');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.retry_count, 1);
    assert.strictEqual(result.retry_budget, 1);
    assert.strictEqual(result.retry_budget_exhausted, true);
    assert.match(result.blocked_reason || '', /Retry budget exhausted after 1 retry/);
    assert.match(result.blocked_reason || '', /execute_shell/);
  });

  test('重复不可重试工具失败达到预算后应收束为 blocked ToolResult', async () => {
    const repeatedCalls = [
      createToolCallWithId('missing-file-1', 'read_file', { file_path: 'missing-input.txt' }),
      createToolCallWithId('missing-file-2', 'read_file', { file_path: 'missing-input.txt' }),
      createToolCallWithId('missing-file-3', 'read_file', { file_path: 'missing-input.txt' }),
    ];
    let aiCallIndex = 0;
    const aiService = {
      chat: async () => {
        if (aiCallIndex < repeatedCalls.length) {
          return {
            content: null,
            toolCalls: [repeatedCalls[aiCallIndex++]],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          };
        }
        return {
          content: '已停止重复读取缺失文件。',
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    };
    const executor = new StubToolExecutor([
      {
        tool_call_id: 'missing-file-1',
        role: 'tool',
        name: 'read_file',
        status: 'failure',
        ok: false,
        error_code: 'FILE_NOT_FOUND',
        errorCode: 'FILE_NOT_FOUND',
        retryable: false,
        content: '文件不存在: missing-input.txt',
      },
    ]);
    const runner = new ConversationRunner(aiService as any, executor, {
      enableCompression: false,
      stream: false,
      maxTurns: 5,
    });

    const result = await runner.run([
      { role: 'user', content: '请读取 missing-input.txt，如果失败也继续试。' },
    ]);

    assert.strictEqual(executor.callCount, 3);
    assert.strictEqual(result.response, '已停止重复读取缺失文件。');
    assert.strictEqual(result.toolResults[0].result.status, 'failure');
    assert.strictEqual(result.toolResults[1].result.status, 'failure');

    const blocked = result.toolResults[2].result;
    assert.strictEqual(blocked.status, 'blocked');
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.error_code, 'FILE_NOT_FOUND');
    assert.strictEqual(blocked.errorCode, 'FILE_NOT_FOUND');
    assert.strictEqual(blocked.retryable, false);
    assert.strictEqual(blocked.retry_count, 2);
    assert.strictEqual(blocked.retry_budget, 2);
    assert.strictEqual(blocked.retry_budget_exhausted, true);
    assert.match(blocked.blocked_reason || '', /Repeated identical non-retryable failure/);
    assert.match(String(blocked.content), /重复不可重试工具失败已收束/);
  });
});
