import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  canonicalizeToolResult,
  normalizeToolExecutionOutputFacts,
  toolBlocked,
  toolFailure,
  toolSuccess,
} from '../src/runtime/contracts/tool-result';

describe('canonical ToolResult', () => {
  test('normalizes success status and strips execution error fields', () => {
    const result = canonicalizeToolResult({
      tool_call_id: 'call-1',
      role: 'tool',
      name: 'demo',
      content: 'domain validation_status=failed but tool executed',
      status: 'success',
      ok: false,
      error_code: 'DOMAIN_VALIDATION_FAILED',
      errorCode: 'DOMAIN_VALIDATION_FAILED',
      blocked_reason: 'domain-level issue',
    });

    assert.equal(result.status, 'success');
    assert.equal(result.ok, true);
    assert.equal(result.error_code, undefined);
    assert.equal(result.errorCode, undefined);
    assert.equal(result.blocked_reason, undefined);
  });

  test('adds canonical execution facts for non-success and blocked results', () => {
    const result = canonicalizeToolResult({
      tool_call_id: 'call-2',
      role: 'tool',
      name: 'demo',
      content: 'permission boundary reached',
      status: 'blocked',
      ok: true,
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'TOOL_BLOCKED');
    assert.equal(result.errorCode, 'TOOL_BLOCKED');
    assert.match(result.blocked_reason || '', /permission boundary/);
    assert.equal(result.duration_ms, 0);
  });

  test('builds structured ToolExecutionOutput facts for tool authors', () => {
    const success = toolSuccess('looks scary: 工具执行错误 but domain-only');
    assert.equal(success.status, 'success');
    assert.equal(success.error_code, undefined);
    assert.equal(success.retryable, false);

    const failure = toolFailure('plain failure payload', 'DEMO_FAILURE', {
      retryable: true,
      retryCount: 1,
      retryBudget: 3,
    });
    assert.deepEqual(normalizeToolExecutionOutputFacts(failure), {
      status: 'failure',
      errorCode: 'DEMO_FAILURE',
      retryable: true,
      retryCount: 1,
      retryBudget: 3,
    });

    const blocked = toolBlocked('blocked payload', 'PATH_DENIED', 'path outside workspace');
    assert.deepEqual(normalizeToolExecutionOutputFacts(blocked), {
      status: 'blocked',
      errorCode: 'PATH_DENIED',
      blockedReason: 'path outside workspace',
      retryable: false,
    });
  });
});
