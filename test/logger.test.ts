import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextDebugLogger } from '../src/runtime/observability/context-debug-logger';
import { Logger } from '../src/runtime/observability/logger';
import { SessionTurnLogger } from '../src/runtime/observability/session-turn-logger';
import { Observability, resetObservabilityForTests } from '../src/runtime/observability';

const originalContextDebug = process.env.CONTEXT_DEBUG;

describe('Logger', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-logger-'));
    process.chdir(testRoot);
  });

  afterEach(async () => {
    Logger.setSilentMode(false);
    if (originalContextDebug === undefined) {
      delete process.env.CONTEXT_DEBUG;
    } else {
      process.env.CONTEXT_DEBUG = originalContextDebug;
    }
    await waitForFlush();
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    resetObservabilityForTests(undefined);
  });

  test('runtime log lines persist only through session runtime log context', async () => {
    Logger.setSilentMode(true);
    const sessionLogger = new SessionTurnLogger('feishu', 'user:ou_demo');
    const traceLogPath = sessionLogger.getLogFilePath();
    const runtimeLogPath = sessionLogger.getRuntimeLogFilePath();
    for (const filePath of [traceLogPath, runtimeLogPath]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    Logger.info('outside context');
    await Logger.withSessionContext('user:ou_demo', sessionLogger, async () => {
      Logger.info('inside context');
      await Promise.resolve();
      Logger.info('still inside context');
    });

    assert.ok(traceLogPath);
    assert.ok(runtimeLogPath);

    await waitForFlush();

    const plainLogFiles = listFiles(path.join(testRoot, 'logs'))
      .filter(filePath => filePath.endsWith('.log'));
    assert.deepEqual(plainLogFiles.map(filePath => fs.realpathSync(filePath)), [fs.realpathSync(runtimeLogPath)]);
    assert.ok(!fs.existsSync(traceLogPath), 'plain runtime lines should not create trace rows');

    const runtimeLines = fs.readFileSync(runtimeLogPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(runtimeLines.length, 2);
    assert.match(runtimeLines[0], / INFO \[feishu session=user_ou_demo\] inside context$/);
    assert.match(runtimeLines[1], / INFO \[feishu session=user_ou_demo\] still inside context$/);
  });

  test('session JSONL trace logs include benchmark-friendly structured fields', () => {
    const sessionLogger = new SessionTurnLogger('feishu', 'user:ou_demo');
    const sessionLogPath = sessionLogger.getLogFilePath();
    if (fs.existsSync(sessionLogPath)) {
      fs.unlinkSync(sessionLogPath);
    }

    sessionLogger.logTurn(
      '画图并发我',
      '已生成图片',
      [
        {
          id: 'call-1',
          name: 'execute_shell',
          arguments: { command: 'Rscript plot.R' },
          result: 'saved /share/home/example-user/project/output/CD3D_feature.png',
          duration_ms: 12,
        },
        {
          id: 'call-2',
          name: 'execute_shell',
          arguments: { command: 'Rscript retry.R' },
          result: 'timeout while running Rscript',
          duration_ms: 30000,
        },
        {
          id: 'call-3',
          name: 'send_text',
          arguments: { text: 'hello' },
          result: '重试预算已耗尽: 429 Too Many Requests',
          status: 'blocked',
          error_code: 'RATE_LIMIT',
          retryable: false,
          retry_count: 2,
          retry_budget: 2,
          retry_budget_exhausted: true,
          blocked_reason: 'Retry budget exhausted after 2 retries for send_text.',
        },
        {
          id: 'call-4',
          name: 'demo',
          arguments: { step: 2 },
          result: '工具调用已取消: Runner interrupted before executing pending tool calls.',
          status: 'cancelled',
          error_code: 'TOOL_CANCELLED',
          retryable: false,
          blocked_reason: 'Runner interrupted before executing pending tool calls.',
          duration_ms: 0,
        },
      ],
      { prompt: 100, completion: 20 },
      [
        {
          roleName: 'secretary-cat',
          activeSkillName: 'calendar',
          mode: 'skill_scoped',
          visibleTools: ['skill', 'feishu_auth_status', 'feishu_calendar_agenda'],
          hiddenToolCount: 31,
          gatedToolCount: 2,
        },
      ],
    );

    const [entry] = fs.readFileSync(sessionLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    assert.equal(entry.schema_version, 3);
    assert.equal(entry.entry_type, 'trace');
    assert.match(entry.trace_id, /^user_ou_demo\.trace\./);
    assert.equal(entry.trace_index, 1);
    assert.equal(entry.episode_id, entry.trace_id);
    assert.equal(entry.episode_index, 1);
    assert.match(entry.turn_id, /^user_ou_demo\.turn\.1$/);
    assert.equal(entry.turn, 1);
    assert.equal(entry.tokens.prompt, 100);
    assert.equal(entry.tokens.completion, 20);
    assert.deepEqual(entry.tool_visibility, [
      {
        roleName: 'secretary-cat',
        activeSkillName: 'calendar',
        mode: 'skill_scoped',
        visibleTools: ['skill', 'feishu_auth_status', 'feishu_calendar_agenda'],
        hiddenToolCount: 31,
        gatedToolCount: 2,
      },
    ]);
    assert.equal(entry.assistant.tool_calls[0].tool_call_id, 'call-1');
    assert.equal(entry.assistant.tool_calls[0].status, 'success');
    assert.deepEqual(entry.assistant.tool_calls[0].artifact_manifest, [
      {
        path: '/share/home/example-user/project/output/CD3D_feature.png',
        type: 'png',
        action: 'created',
      },
    ]);
    assert.equal(entry.assistant.tool_calls[1].status, 'timeout');
    assert.equal(entry.assistant.tool_calls[1].error_code, 'TOOL_TIMEOUT');
    assert.equal(entry.assistant.tool_calls[2].status, 'blocked');
    assert.equal(entry.assistant.tool_calls[2].error_code, 'RATE_LIMIT');
    assert.equal(entry.assistant.tool_calls[2].retryable, false);
    assert.equal(entry.assistant.tool_calls[2].retry_count, 2);
    assert.equal(entry.assistant.tool_calls[2].retry_budget, 2);
    assert.equal(entry.assistant.tool_calls[2].retry_budget_exhausted, true);
    assert.match(entry.assistant.tool_calls[2].blocked_reason, /Retry budget exhausted/);
    assert.equal(entry.assistant.tool_calls[3].status, 'cancelled');
    assert.equal(entry.assistant.tool_calls[3].error_code, 'TOOL_CANCELLED');
    assert.equal(entry.assistant.tool_calls[3].retryable, false);
    assert.equal(entry.assistant.tool_calls[3].duration_ms, 0);
    assert.match(entry.assistant.tool_calls[3].blocked_reason, /Runner interrupted/);
  });

  test('session JSONL entries project into local observability summary', () => {
    const observability = Observability.fromEnv({} as NodeJS.ProcessEnv);
    resetObservabilityForTests(observability);
    const sessionLogger = new SessionTurnLogger('cli', 'user:projector');

    sessionLogger.logRuntimeEvent('session_started', {
      surface: 'cli',
      status: 'started',
    });
    sessionLogger.logRuntimeEvent('session_completed', {
      surface: 'cli',
      status: 'success',
      duration_ms: 21,
      model_call_count: 1,
    });
    sessionLogger.logTurn(
      'run tool',
      'done',
      [{
        id: 'call-projector',
        name: 'demo_tool',
        arguments: { text: 'ok' },
        result: 'delivered',
        status: 'success',
        duration_ms: 7,
        delivery_evidence: [{
          delivery_type: 'text',
          status: 'delivered',
          timestamp: '2026-06-12T00:00:00.000Z',
          surface: 'cli',
        }],
      }],
      { prompt: 3, completion: 2 },
    );
    const summary = observability.getLocalSummary();
    assert.equal(summary.totals.toolCalls, 1);
    assert.equal(summary.totals.toolResults, 1);
    assert.equal(summary.totals.sessions, 1);
    assert.equal(summary.totals.modelCalls, 1);
    assert.equal(summary.latency.tool.p95Ms, 7);
    assert.equal(summary.latency.session.p95Ms, 21);
    assert.equal(summary.top.tools[0].name, 'demo_tool');
    assert.equal(summary.top.surfaces[0].name, 'cli');
    const tokenEvent = summary.recent.find(event => event.name === 'xiaoba.tokens.prompt');
    assert.match(String(tokenEvent?.attributes['xiaoba.trace.id_hash']), /^[a-f0-9]{16}$/);
    assert.equal(tokenEvent?.attributes['xiaoba.trace.index'], 1);
  });

  test('session JSONL does not hoist domain evidence into success error_code', () => {
    const sessionLogger = new SessionTurnLogger('eval', 'eval:tool_result_semantics');
    const sessionLogPath = sessionLogger.getLogFilePath();
    if (fs.existsSync(sessionLogPath)) {
      fs.unlinkSync(sessionLogPath);
    }

    sessionLogger.logTurn(
      '检查 tool result 语义',
      '已检查',
      [
        {
          id: 'success-with-domain-path-denied',
          name: 'auto_research_run',
          arguments: { project: 'demo' },
          result: JSON.stringify({
            ok: true,
            blocked_external_path: '[blocked-external-path:abc123]',
            note: 'PATH_DENIED here is domain evidence, not tool execution failure.',
          }),
          status: 'success',
          error_code: 'PATH_DENIED',
          blocked_reason: 'Domain artifact contained a blocked external path marker.',
          duration_ms: 8,
        },
        {
          id: 'failed-path-denied',
          name: 'read_file',
          arguments: { path: '../private.txt' },
          result: '读取路径超出工作目录: ../private.txt',
          status: 'failure',
          duration_ms: 3,
        },
      ],
      { prompt: 12, completion: 4 },
    );

    const [entry] = fs.readFileSync(sessionLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    assert.equal(entry.assistant.tool_calls[0].status, 'success');
    assert.equal(entry.assistant.tool_calls[0].error_code, undefined);
    assert.equal(entry.assistant.tool_calls[0].blocked_reason, undefined);
    assert.equal(entry.assistant.tool_calls[1].status, 'failure');
    assert.equal(entry.assistant.tool_calls[1].error_code, 'PATH_DENIED');
  });

  test('session JSONL preserves local raw trace facts', () => {
    const sessionLogger = new SessionTurnLogger('cli', 'user:local_truth_demo');
    const sessionLogPath = sessionLogger.getLogFilePath();
    if (fs.existsSync(sessionLogPath)) {
      fs.unlinkSync(sessionLogPath);
    }

    sessionLogger.logTurn(
      '请记录 password="plain-secret" 和 /Users/guowei/private/input.csv',
      'api_key=sk-test-abcdefghijklmnopqrstuvwxyz 已忽略',
      [
        {
          id: 'secret-call',
          name: 'send_text',
          arguments: {
            token: 'tok_1234567890',
            file_path: '/Users/guowei/project/private-output.csv',
            nested: { password: 'nested-secret' },
          },
          result: 'saved /Users/guowei/project/private-output.csv with sk-test-abcdefghijklmnopqrstuvwxyz',
          delivery_evidence: [
            {
              delivery_type: 'text',
              status: 'delivered',
              timestamp: '2026-06-04T00:00:00.000Z',
              channel_id: 'chat-secret-id',
              text_preview: 'api_key=sk-test-abcdefghijklmnopqrstuvwxyz',
            },
          ],
        },
      ],
      { prompt: 10, completion: 5 },
    );

    const raw = fs.readFileSync(sessionLogPath, 'utf-8');
    assert.ok(raw.includes('plain-secret'));
    assert.ok(raw.includes('tok_1234567890'));
    assert.ok(raw.includes('nested-secret'));
    assert.ok(raw.includes('sk-test-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(raw.includes('/Users/guowei'));

    const [entry] = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entry.user.text, '请记录 password="plain-secret" 和 /Users/guowei/private/input.csv');
    assert.equal(entry.assistant.text, 'api_key=sk-test-abcdefghijklmnopqrstuvwxyz 已忽略');
    assert.equal(entry.assistant.tool_calls[0].arguments.token, 'tok_1234567890');
    assert.equal(entry.assistant.tool_calls[0].arguments.nested.password, 'nested-secret');
    assert.equal(entry.assistant.tool_calls[0].arguments.file_path, '/Users/guowei/project/private-output.csv');
    assert.equal(entry.assistant.tool_calls[0].result, 'saved /Users/guowei/project/private-output.csv with sk-test-abcdefghijklmnopqrstuvwxyz');
    assert.equal(entry.assistant.tool_calls[0].delivery_evidence[0].channel_id, 'chat-secret-id');
    assert.equal(entry.assistant.tool_calls[0].delivery_evidence[0].text_preview, 'api_key=sk-test-abcdefghijklmnopqrstuvwxyz');
  });

  test('session runtime logs preserve local debug text before persistence', () => {
    const sessionLogger = new SessionTurnLogger('eval', 'eval:base-runtime_local_truth_demo');
    const sessionLogPath = sessionLogger.getLogFilePath();
    if (fs.existsSync(sessionLogPath)) {
      fs.unlinkSync(sessionLogPath);
    }

    const workspaceFile = path.join(process.cwd(), 'output', 'researcher-cat', 'board.json');
    sessionLogger.logRuntime('INFO', `工具完成: board_json_path=${workspaceFile} token=runtime-secret-12345`);

    const raw = fs.readFileSync(sessionLogger.getRuntimeLogFilePath(), 'utf-8');
    assert.ok(raw.includes(workspaceFile));
    assert.ok(raw.includes('runtime-secret-12345'));

    assert.match(raw, /INFO \[eval session=eval_base-runtime_local_truth_demo\] 工具完成: board_json_path=.*output\/researcher-cat\/board\.json token=runtime-secret-12345/);
  });

  test('session runtime events preserve local nested evidence before trace persistence', () => {
    const sessionLogger = new SessionTurnLogger('eval', 'eval:provider_error_local_truth_demo');
    const sessionLogPath = sessionLogger.getLogFilePath();
    if (fs.existsSync(sessionLogPath)) {
      fs.unlinkSync(sessionLogPath);
    }

    const workspaceFile = path.join(process.cwd(), 'output', 'provider', 'trace.jsonl');
    sessionLogger.logRuntimeEvent('provider_error', {
      surface: 'cli',
      status: 'blocked',
      error_code: 'MODEL_RATE_LIMIT',
      retryable: true,
      retry_count: 1,
      retry_budget: 1,
      retry_budget_exhausted: true,
      blocked_reason: `Provider retry budget exhausted at ${workspaceFile}`,
      provider_failure_budget: {
        scope: 'session',
        fingerprint: 'sha256:1234567890abcdef',
        prior_failure_count: 1,
      },
      provider_error: {
        provider: 'openai-compatible',
        model: 'gpt-test',
        status: 429,
        error_code: 'MODEL_RATE_LIMIT',
        retryable: true,
        message: `failed at ${workspaceFile} api_key=sk-test-abcdefghijklmnopqrstuvwxyz`,
        token: 'runtime-token-secret',
      },
      tokens: { prompt: 1, completion: 0 },
    });
    sessionLogger.logTurn(
      '触发 provider error',
      'provider fallback',
      [],
      { prompt: 1, completion: 0 },
    );

    const raw = fs.readFileSync(sessionLogPath, 'utf-8');
    assert.ok(raw.includes(workspaceFile));
    assert.ok(raw.includes('sk-test-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(raw.includes('runtime-token-secret'));

    const [traceEntry] = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(traceEntry.entry_type, 'trace');
    const [entry] = traceEntry.events;
    assert.equal(entry.entry_type, 'runtime_event');
    assert.equal(entry.event_type, 'provider_error');
    assert.equal(entry.surface, 'cli');
    assert.equal(entry.status, 'blocked');
    assert.equal(entry.error_code, 'MODEL_RATE_LIMIT');
    assert.equal(entry.retry_count, 1);
    assert.equal(entry.retry_budget, 1);
    assert.equal(entry.retry_budget_exhausted, true);
    assert.equal(entry.blocked_reason, `Provider retry budget exhausted at ${workspaceFile}`);
    assert.deepEqual(entry.provider_failure_budget, {
      scope: 'session',
      fingerprint: 'sha256:1234567890abcdef',
      prior_failure_count: 1,
    });
    assert.equal(entry.provider_error.error_code, 'MODEL_RATE_LIMIT');
    assert.equal(entry.provider_error.retryable, true);
    assert.equal(
      entry.provider_error.message,
      `failed at ${workspaceFile} api_key=sk-test-abcdefghijklmnopqrstuvwxyz`,
    );
    assert.equal(entry.provider_error.token, 'runtime-token-secret');
    assert.deepEqual(entry.tokens, { prompt: 1, completion: 0 });
  });

  test('context compaction events point at same-session after snapshots', () => {
    const sessionLogger = new SessionTurnLogger('pet', 'pet:compact-demo');
    const sessionLogPath = sessionLogger.getLogFilePath();
    const snapshotPath = sessionLogger.getContextSnapshotFilePath();
    if (fs.existsSync(sessionLogPath)) {
      fs.unlinkSync(sessionLogPath);
    }
    if (fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
    }

    const event = sessionLogger.logContextCompaction({
      source: 'agent_session_pre_message',
      status: 'success',
      reason: 'threshold_exceeded',
      surface: 'pet',
      tokens_before: 190000,
      tokens_after: 42000,
      message_tokens_before: 190000,
      message_tokens_after: 42000,
      max_tokens: 258400,
      threshold_ratio: 0.7,
      threshold_tokens: 180880,
      usage_percent_before: 74,
      usage_percent_after: 16,
      messages_before: 42,
      messages_after: 3,
      messages: [
        { role: 'system', content: '[compact_boundary] 39 older messages summarized. Pre-compact tokens: 190000' },
        { role: 'system', content: '[session_memory]\n用户要求不要改无关文件。' },
        { role: 'user', content: '继续刚才的问题' },
      ],
    });
    sessionLogger.logTurn(
      '继续刚才的问题',
      '继续处理',
      [],
      { prompt: 10, completion: 2 },
    );

    const [traceEntry] = fs.readFileSync(sessionLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const compactEvent = traceEntry.events.find((item: any) => item.event_type === 'context_compaction');
    assert.ok(compactEvent);
    assert.equal(compactEvent.event_id, event.event_id);
    assert.equal(compactEvent.source, 'agent_session_pre_message');
    assert.equal(compactEvent.status, 'success');
    assert.equal(compactEvent.snapshot_kind, 'compact_after');
    assert.equal(compactEvent.snapshot_status, 'written');
    assert.match(compactEvent.snapshot_ref, /^context-snapshots\/pet_compact-demo\.jsonl#/);
    assert.equal(compactEvent.snapshot_id, compactEvent.snapshot_ref.split('#')[1]);
    assert.equal(compactEvent.older_messages_summarized, 39);
    assert.equal(compactEvent.pre_compact_tokens, 190000);

    const [snapshot] = fs.readFileSync(snapshotPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(snapshot.entry_type, 'context_snapshot');
    assert.equal(snapshot.kind, 'compact_after');
    assert.equal(snapshot.event_id, compactEvent.event_id);
    assert.equal(snapshot.snapshot_id, compactEvent.snapshot_id);
    assert.equal(snapshot.session_id, 'pet:compact-demo');
    assert.equal(snapshot.message_count, 3);
    assert.equal(snapshot.messages[0].content, '[compact_boundary] 39 older messages summarized. Pre-compact tokens: 190000');
  });

  test('context debug SDK boundary dumps preserve raw local provider payloads', () => {
    process.env.CONTEXT_DEBUG = 'true';
    ContextDebugLogger.dumpSdkBoundary('before', 'req-secret-debug', {
      apiUrl: 'https://api.example.test/v1/chat/completions',
      body: {
        model: 'debug-model',
        messages: [
          { role: 'user', content: 'please send password="plain-debug-secret" to ou_secret' },
        ],
        tool_calls: [
          {
            function: {
              name: 'send_text',
              arguments: '{"text":"plain-debug-secret"}',
            },
          },
        ],
        api_key: 'sk-debug-secret-abcdefghijklmnopqrstuvwxyz',
      },
    });

    const debugFiles = listFiles(path.join(testRoot, 'logs', 'context-debug'));
    assert.equal(debugFiles.length, 1);
    const raw = fs.readFileSync(debugFiles[0], 'utf-8');
    assert.ok(raw.includes('plain-debug-secret'));
    assert.ok(raw.includes('ou_secret'));
    assert.ok(raw.includes('sk-debug-secret-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(raw.includes('"raw_payload_stored": true'));

    const dump = JSON.parse(raw);
    assert.equal(dump.data.apiUrl, 'https://api.example.test/v1/chat/completions');
    assert.equal(dump.data.body.model, 'debug-model');
    assert.equal(dump.data.body.messages[0].content, 'please send password="plain-debug-secret" to ou_secret');
    assert.equal(dump.data.body.tool_calls[0].function.arguments, '{"text":"plain-debug-secret"}');
    assert.equal(dump.data.body.api_key, 'sk-debug-secret-abcdefghijklmnopqrstuvwxyz');
  });

  test('session JSONL state boundary refs are relative and provider transcript stays reference-only', () => {
    const sessionLogger = new SessionTurnLogger('pet', 'pet:xiaoba');
    const sessionLogPath = sessionLogger.getLogFilePath();
    if (fs.existsSync(sessionLogPath)) {
      fs.unlinkSync(sessionLogPath);
    }

    sessionLogger.logTurn(
      '检查状态边界',
      '状态边界已记录',
      [],
      { prompt: 20, completion: 8 },
      undefined,
      {
        durable_session: {
          kind: 'durable_session',
          ref: path.resolve(process.cwd(), 'data', 'sessions', 'pet', 'pet_xiaoba.jsonl'),
          scope: 'surface_restore',
        },
        working_trace: {
          kind: 'working_trace',
          ref: sessionLogPath,
          schema: 'session-log-v3',
        },
        provider_transcript: {
          kind: 'provider_transcript',
          ref: `${sessionLogPath}#provider-transcript`,
          mode: 'raw',
          raw_messages_stored: true,
          tool_result_payload_stored: true,
        },
        visible_history: {
          kind: 'visible_history',
          ref: path.resolve(process.cwd(), 'data', 'chat', 'sessions', 'pet_xiaoba.jsonl'),
          scope: 'surface_visible_history',
        },
      },
    );

    const [entry] = fs.readFileSync(sessionLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    assert.equal(entry.state_boundary.durable_session.ref, 'data/sessions/pet/pet_xiaoba.jsonl');
    assert.match(entry.state_boundary.working_trace.ref, /^logs\/sessions\/pet\/\d{4}-\d{2}-\d{2}\/pet_xiaoba\/traces\.jsonl$/);
    assert.equal(entry.state_boundary.provider_transcript.ref, `${entry.state_boundary.working_trace.ref}#provider-transcript`);
    assert.equal(entry.state_boundary.provider_transcript.kind, 'provider_transcript_ref');
    assert.equal(entry.state_boundary.provider_transcript.mode, 'reference');
    assert.equal(entry.state_boundary.provider_transcript.raw_messages_stored, false);
    assert.equal(entry.state_boundary.provider_transcript.tool_result_payload_stored, false);
    assert.equal(entry.state_boundary.visible_history.ref, 'data/chat/sessions/pet_xiaoba.jsonl');
  });
});

function waitForFlush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        result.push(fullPath);
      }
    }
  };
  visit(root);
  return result;
}
