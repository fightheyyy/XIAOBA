import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolManager } from '../src/capabilities/tools/tool-manager';
import { Tool, ToolCall } from '../src/runtime/contracts/tool';

function createToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: 'tool-call-1',
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function createTool(name: string, execute: Tool['execute']): Tool {
  return {
    definition: {
      name,
      description: `${name} tool`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    execute,
  };
}

describe('ToolManager rate limit classification', () => {
  test('send_text 抛出 429 错误时应标记为可重试的 RATE_LIMIT', async () => {
    const manager = new ToolManager(process.cwd(), {
      surface: 'feishu',
      channel: {
        chatId: 'chat-demo',
        reply: async () => {
          throw new Error('429 Too Many Requests');
        },
        sendFile: async () => undefined,
      },
    });

    const result = await manager.executeTool(createToolCall('send_text', { text: 'hello' }), [], {});

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'failure');
    assert.strictEqual(result.error_code, 'RATE_LIMIT');
    assert.strictEqual(result.errorCode, 'RATE_LIMIT');
    assert.strictEqual(result.retryable, true);
    assert.equal(typeof result.duration_ms, 'number');
    assert.ok(String(result.content).includes('429 Too Many Requests'));
    assert.deepEqual(result.delivery_evidence?.map(item => ({
      delivery_type: item.delivery_type,
      status: item.status,
      error_code: item.error_code,
    })), [
      {
        delivery_type: 'text',
        status: 'failed',
        error_code: 'RATE_LIMIT',
      },
    ]);
  });

  test('structured ToolExecutionOutput success wins over legacy error-looking prose', async () => {
    const manager = new ToolManager(process.cwd(), {}, [
      createTool('structured_success', async () => ({
        toolContent: '工具执行错误: this is a domain-level note, not an execution failure',
        status: 'success',
      })),
    ]);

    const result = await manager.executeTool(createToolCall('structured_success'), [], {});

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.error_code, undefined);
    assert.match(String(result.content), /domain-level note/);
  });

  test('structured ToolExecutionOutput failure does not need prose prefixes', async () => {
    const manager = new ToolManager(process.cwd(), {}, [
      createTool('structured_failure', async () => ({
        toolContent: 'plain failure payload',
        status: 'failure',
        error_code: 'DEMO_STRUCTURED_FAILURE',
        retryable: true,
        retry_count: 1,
        retry_budget: 3,
      })),
    ]);

    const result = await manager.executeTool(createToolCall('structured_failure'), [], {});

    assert.strictEqual(result.status, 'failure');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error_code, 'DEMO_STRUCTURED_FAILURE');
    assert.strictEqual(result.errorCode, 'DEMO_STRUCTURED_FAILURE');
    assert.strictEqual(result.retryable, true);
    assert.strictEqual(result.retry_count, 1);
    assert.strictEqual(result.retry_budget, 3);
    assert.match(String(result.content), /plain failure payload/);
  });

  test('core read_file failure emits structured FILE_NOT_FOUND', async () => {
    const manager = new ToolManager(process.cwd());

    const result = await manager.executeTool(createToolCall('read_file', {
      file_path: `missing-${Date.now()}.txt`,
    }), [], {});

    assert.strictEqual(result.status, 'failure');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error_code, 'FILE_NOT_FOUND');
    assert.strictEqual(result.retryable, false);
  });

  test('core write_file success emits structured status and artifact manifest', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-manager-structured-'));
    try {
      const manager = new ToolManager(tempDir);

      const result = await manager.executeTool(createToolCall('write_file', {
        file_path: 'report.md',
        content: '# Report\n',
      }), [], {});

      assert.strictEqual(result.status, 'success');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.error_code, undefined);
      assert.deepStrictEqual(result.artifact_manifest?.map(item => ({
        path: item.path,
        type: item.type,
        action: item.action,
      })), [{
        path: 'report.md',
        type: 'md',
        action: 'created',
      }]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('core execute_shell failure emits structured COMMAND_FAILED', async () => {
    const manager = new ToolManager(process.cwd());

    const result = await manager.executeTool(createToolCall('execute_shell', {
      command: 'node -e "process.exit(7)"',
    }), [], {});

    assert.strictEqual(result.status, 'failure');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error_code, 'COMMAND_FAILED');
    assert.strictEqual(result.retryable, false);
  });
});
