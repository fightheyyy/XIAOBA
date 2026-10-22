import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { ToolExecutionContext } from '../src/runtime/contracts/tool';
import { FeishuAuthLoginCompleteTool, FeishuAuthLoginStartTool, FeishuAuthStatusTool } from '../src/capabilities/roles/secretary-cat/tools/feishu-auth-tools';
import {
  FeishuCalendarAgendaTool,
  FeishuCalendarCreateTool,
  FeishuCalendarDeleteTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-calendar-tools';
import {
  FeishuBaseRecordListTool,
  FeishuBaseRecordUpsertConfirmedTool,
  FeishuBaseTableListTool,
  FeishuSheetsAppendConfirmedTool,
  FeishuSheetsReadTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-data-tools';
import {
  FeishuDocsCreateConfirmedTool,
  FeishuDocsFetchTool,
  FeishuDocsSearchTool,
  FeishuDocsUpdateConfirmedTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-doc-tools';
import {
  FeishuDriveDownloadTool,
  FeishuDriveImportConfirmedTool,
  FeishuDriveSearchTool,
  FeishuDriveUploadConfirmedTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-drive-tools';
import {
  FeishuMailDraftCreateTool,
  FeishuMailDraftSendConfirmedTool,
  FeishuMailReadTool,
  FeishuMailTriageTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-mail-tools';
import {
  FeishuContactSearchTool,
  FeishuMessageDraftTool,
  FeishuMessageSendConfirmedTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-message-tools';
import {
  FeishuMinutesDownloadTool,
  FeishuMinutesGetTool,
  FeishuMinutesNotesTool,
  FeishuMinutesSearchTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-minutes-tools';
import {
  FeishuTaskCreateConfirmedTool,
  FeishuTaskListTool,
  FeishuTaskStateConfirmedTool,
  FeishuTaskUpdateConfirmedTool,
} from '../src/capabilities/roles/secretary-cat/tools/feishu-task-tools';
import {
  DefaultLarkCliRunner,
  LarkCliExecFile,
  LarkCliRunner,
  LarkCliRunOptions,
  SecretaryToolError,
  redactSecrets,
} from '../src/capabilities/roles/secretary-cat/utils/lark-cli-runner';

class MockLarkCliRunner implements LarkCliRunner {
  readonly calls: Array<{ args: string[]; options?: LarkCliRunOptions }> = [];

  constructor(private readonly responses: unknown[]) {}

  async run(args: string[], options?: LarkCliRunOptions) {
    this.calls.push({ args, options });
    const response = this.responses.shift() ?? {};
    return {
      stdout: typeof response === 'string' ? response : JSON.stringify(response),
      stderr: '',
      exitCode: 0,
    };
  }
}

const context: ToolExecutionContext = {
  workingDirectory: process.cwd(),
  conversationHistory: [],
  roleName: 'secretary-cat',
};

describe('SecretaryCat lark-cli application binding', () => {
  test('selects the profile matching the configured Feishu Surface App ID without changing global state', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const executor: LarkCliExecFile = async (_command, args, options) => {
      calls.push({ args, env: options.env });
      if (args.join(' ') === 'profile list') {
        return {
          stdout: JSON.stringify([
            { name: 'personal', appId: 'cli_personal', active: true },
            { name: 'xiaoba-surface', appId: 'cli_xiaoba', active: false },
          ]),
          stderr: '',
        };
      }
      return { stdout: JSON.stringify({ appId: 'cli_xiaoba' }), stderr: '' };
    };
    const runner = new DefaultLarkCliRunner('lark-cli', {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      FEISHU_APP_ID: 'cli_xiaoba',
      FEISHU_APP_SECRET: 'surface-secret',
      XIAOBA_LLM_API_KEY: 'llm-secret',
    }, executor);

    await runner.run(['auth', 'status']);
    await runner.run(['calendar', '+agenda', '--as', 'user']);

    assert.deepEqual(calls.map(call => call.args), [
      ['profile', 'list'],
      ['--profile', 'xiaoba-surface', 'auth', 'status'],
      ['--profile', 'xiaoba-surface', 'calendar', '+agenda', '--as', 'user'],
    ]);
    assert.equal(calls.every(call => call.env.FEISHU_APP_SECRET === undefined), true);
    assert.equal(calls.every(call => call.env.XIAOBA_LLM_API_KEY === undefined), true);
    assert.equal(calls.every(call => call.env.HOME === '/tmp/home'), true);
  });

  test('fails closed when no lark-cli profile matches the Feishu Surface application', async () => {
    const executor: LarkCliExecFile = async () => ({
      stdout: JSON.stringify([{ name: 'other', appId: 'cli_other', active: true }]),
      stderr: '',
    });
    const runner = new DefaultLarkCliRunner(
      'lark-cli',
      { FEISHU_APP_ID: 'cli_xiaoba' },
      executor,
    );

    await assert.rejects(
      () => runner.run(['auth', 'status']),
      (error: unknown) => error instanceof SecretaryToolError
        && error.code === 'CLI_NOT_CONFIGURED'
        && /matches the configured Feishu Surface application/.test(error.message),
    );
  });

  test('keeps standalone lark-cli behavior when no Feishu Surface app is configured', async () => {
    const calls: string[][] = [];
    const executor: LarkCliExecFile = async (_command, args) => {
      calls.push(args);
      return { stdout: '{}', stderr: '' };
    };
    const runner = new DefaultLarkCliRunner('lark-cli', { PATH: '/usr/bin' }, executor);

    await runner.run(['auth', 'status']);

    assert.deepEqual(calls, [['auth', 'status']]);
  });
});

describe('SecretaryCat Feishu wrapper tools', () => {
  test('auth status normalizes scopes without exposing raw token fields', async () => {
    const runner = new MockLarkCliRunner([
      {
        identities: {
          user: {
            status: 'ready',
            scope: 'calendar:calendar.event:read calendar:calendar.event:create',
            access_token: 'secret-token',
          },
          bot: { status: 'ready' },
        },
        identity: 'user',
      },
    ]);
    const result = JSON.parse(await new FeishuAuthStatusTool(runner).execute({}, context));

    assert.equal(result.ok, true);
    assert.equal(result.user_identity, 'ready');
    assert.deepEqual(result.scopes, ['calendar:calendar.event:read', 'calendar:calendar.event:create']);
    assert.equal(JSON.stringify(result).includes('secret-token'), false);
    assert.deepEqual(runner.calls[0].args, ['auth', 'status']);
  });

  test('auth login starts non-blocking device flow with recommended scopes', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-auth-'));
    const runner = new MockLarkCliRunner([
      {
        verification_uri: 'https://example.test/device',
        user_code: 'ABCD-EFGH',
        device_code: 'device-code',
        expires_in: 600,
        interval: 5,
      },
    ]);
    try {
      const authContext = { ...context, workingDirectory: testRoot };
      const result = JSON.parse(await new FeishuAuthLoginStartTool(runner).execute({
        domain: 'calendar,contact',
        recommend: true,
      }, authContext));

      assert.equal(result.ok, true);
      assert.equal(result.verification_uri, 'https://example.test/device');
      assert.equal(result.user_code, 'ABCD-EFGH');
      assert.equal(result.device_code, undefined);
      assert.equal(typeof result.auth_request_id, 'string');
      assert.match(result.next_action, /feishu_auth_login_complete/);
      assert.equal(fs.existsSync(path.join(testRoot, 'data', 'secretary-cat', 'auth', 'pending-device-auth.json')), true);
      assert.deepEqual(runner.calls[0].args, [
        'auth',
        'login',
        '--no-wait',
        '--json',
        '--domain',
        'calendar,contact',
        '--recommend',
      ]);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('auth login complete uses stored device code and clears pending request', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-auth-'));
    const runner = new MockLarkCliRunner([
      {
        verification_uri: 'https://example.test/device',
        user_code: 'ABCD-EFGH',
        device_code: 'device-code',
        expires_in: 600,
      },
      {
        identity: 'user',
        identities: {
          user: { status: 'ready' },
        },
      },
    ]);
    try {
      const authContext = { ...context, workingDirectory: testRoot };
      const started = JSON.parse(await new FeishuAuthLoginStartTool(runner).execute({
        domain: 'calendar,contact',
        recommend: true,
      }, authContext));
      const completed = JSON.parse(await new FeishuAuthLoginCompleteTool(runner).execute({
        auth_request_id: started.auth_request_id,
      }, authContext));

      assert.equal(completed.ok, true);
      assert.equal(completed.auth_request_id, started.auth_request_id);
      assert.equal(completed.domain, 'calendar,contact');
      assert.deepEqual(runner.calls[1].args, [
        'auth',
        'login',
        '--device-code',
        'device-code',
        '--json',
      ]);
      const store = JSON.parse(fs.readFileSync(path.join(testRoot, 'data', 'secretary-cat', 'auth', 'pending-device-auth.json'), 'utf-8'));
      assert.deepEqual(store.requests, []);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('auth login complete reports missing pending request without CLI call', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-auth-'));
    const runner = new MockLarkCliRunner([]);
    try {
      const authContext = { ...context, workingDirectory: testRoot };
      const result = JSON.parse(await new FeishuAuthLoginCompleteTool(runner).execute({}, authContext));

      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'VALIDATION_ERROR');
      assert.match(result.error.next_action, /feishu_auth_login_start/);
      assert.equal(runner.calls.length, 0);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('calendar agenda builds lark-cli argument array and normalizes events', async () => {
    const runner = new MockLarkCliRunner([
      {
        events: [
          {
            event_id: 'evt_0',
            summary: 'Project sync',
            start_time: '2026-06-02T10:00:00+08:00',
            end_time: '2026-06-02T10:30:00+08:00',
            app_link: 'https://calendar.example/event',
          },
        ],
      },
    ]);
    const result = JSON.parse(await new FeishuCalendarAgendaTool(runner).execute({
      start: '2026-06-02T09:30:00+08:00',
      end: '2026-06-02T10:30:00+08:00',
    }, context));

    assert.equal(result.ok, true);
    assert.equal(result.events[0].event_id, 'evt_0');
    assert.deepEqual(runner.calls[0].args, [
      'calendar',
      '+agenda',
      '--as',
      'user',
      '--calendar-id',
      'primary',
      '--start',
      '2026-06-02T09:30:00+08:00',
      '--end',
      '2026-06-02T10:30:00+08:00',
      '--format',
      'json',
    ]);
  });

  test('calendar create passes attendee args', async () => {
    const runner = new MockLarkCliRunner([
      {
        event: {
          event_id: 'evt_1',
          summary: 'Gemma4 test',
          start_time: { timestamp: '1780375200' },
          end_time: { timestamp: '1780375800' },
        },
      },
    ]);
    const result = JSON.parse(await new FeishuCalendarCreateTool(runner).execute({
      summary: 'Gemma4 test',
      start: '2026-06-02T10:00:00+08:00',
      end: '2026-06-02T10:10:00+08:00',
      attendee_ids: 'ou_1,ou_2',
    }, context));

    assert.equal(result.ok, true);
    assert.equal(result.event.event_id, 'evt_1');
    assert.deepEqual(runner.calls[0].args, [
      'calendar',
      '+create',
      '--as',
      'user',
      '--calendar-id',
      'primary',
      '--summary',
      'Gemma4 test',
      '--start',
      '2026-06-02T10:00:00+08:00',
      '--end',
      '2026-06-02T10:10:00+08:00',
      '--format',
      'json',
      '--attendee-ids',
      'ou_1,ou_2',
    ]);
  });

  test('calendar delete requires explicit confirmation before any CLI call', async () => {
    const runner = new MockLarkCliRunner([]);
    const result = JSON.parse(await new FeishuCalendarDeleteTool(runner).execute({
      event_id: 'evt_1',
    }, context));

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(runner.calls.length, 0);
  });

  test('contact search and message draft are read-only compose helpers', async () => {
    const runner = new MockLarkCliRunner([
      {
        users: [
          { open_id: 'ou_1', name: 'Zhang San', email: 'zhang@example.test' },
        ],
      },
    ]);
    const contacts = JSON.parse(await new FeishuContactSearchTool(runner).execute({
      query: 'Zhang',
      limit: 5,
    }, context));
    const draft = JSON.parse(await new FeishuMessageDraftTool().execute({
      recipient: 'Zhang San',
      intent: 'Please join the 10am sync',
      tone: 'brief',
    }, context));

    assert.equal(contacts.ok, true);
    assert.equal(contacts.contacts[0].open_id, 'ou_1');
    assert.equal(draft.ok, true);
    assert.equal(draft.confirmation_required, true);
    assert.equal(draft.text, 'Please join the 10am sync');
  });

  test('message send requires confirmation and then uses user identity', async () => {
    const blockedRunner = new MockLarkCliRunner([]);
    const blocked = JSON.parse(await new FeishuMessageSendConfirmedTool(blockedRunner).execute({
      recipient_type: 'user_id',
      recipient_id: 'ou_1',
      text: 'Hello',
    }, context));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(blockedRunner.calls.length, 0);

    const runner = new MockLarkCliRunner([{ message_id: 'om_1' }]);
    const sent = JSON.parse(await new FeishuMessageSendConfirmedTool(runner).execute({
      recipient_type: 'user_id',
      recipient_id: 'ou_1',
      text: 'Hello',
      confirmed: true,
    }, context));
    assert.equal(sent.ok, true);
    assert.deepEqual(runner.calls[0].args, [
      'im',
      '+messages-send',
      '--as',
      'user',
      '--user-id',
      'ou_1',
      '--text',
      'Hello',
    ]);
  });

  test('task wrappers use shortcuts and gate mutations with confirmation', async () => {
    const runner = new MockLarkCliRunner([
      { items: [{ task_id: 'task_1', summary: 'Follow up' }] },
      { task: { guid: 'task_2' } },
      { task: { guid: 'task_2', summary: 'Updated' } },
      { task_id: 'task_2', completed: true },
    ]);

    const listed = JSON.parse(await new FeishuTaskListTool(runner).execute({
      status: 'incomplete',
      query: 'Follow',
      due_start: '2026-06-02',
      due_end: '+7d',
      page_all: true,
      page_limit: 2,
    }, context));
    assert.equal(listed.ok, true);
    assert.deepEqual(runner.calls[0].args, [
      'task',
      '+get-my-tasks',
      '--as',
      'user',
      '--format',
      'json',
      '--complete=false',
      '--query',
      'Follow',
      '--due-start',
      '2026-06-02',
      '--due-end',
      '+7d',
      '--page-all',
      '--page-limit',
      '2',
    ]);

    const blockedRunner = new MockLarkCliRunner([]);
    const blocked = JSON.parse(await new FeishuTaskCreateConfirmedTool(blockedRunner).execute({
      summary: 'Create deck',
    }, context));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(blockedRunner.calls.length, 0);

    await new FeishuTaskCreateConfirmedTool(runner).execute({
      summary: 'Create deck',
      description: 'For Monday review',
      due: '2026-06-05',
      assignee: 'ou_1',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[1].args, [
      'task',
      '+create',
      '--as',
      'user',
      '--summary',
      'Create deck',
      '--format',
      'json',
      '--description',
      'For Monday review',
      '--due',
      '2026-06-05',
      '--assignee',
      'ou_1',
    ]);

    await new FeishuTaskUpdateConfirmedTool(runner).execute({
      task_id: 'task_2',
      summary: 'Updated',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[2].args, [
      'task',
      '+update',
      '--as',
      'user',
      '--task-id',
      'task_2',
      '--format',
      'json',
      '--summary',
      'Updated',
    ]);

    await new FeishuTaskStateConfirmedTool(runner).execute({
      task_id: 'task_2',
      action: 'complete',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[3].args, [
      'task',
      '+complete',
      '--as',
      'user',
      '--task-id',
      'task_2',
      '--format',
      'json',
    ]);
    assertNoDryRun(runner);
  });

  test('mail wrappers separate triage/read, draft creation, and confirmed draft send', async () => {
    const runner = new MockLarkCliRunner([
      { messages: [{ message_id: 'msg_1', subject: 'Budget' }] },
      { message_id: 'msg_1', body_text: 'Hello' },
      { draft_id: 'draft_1' },
      { sent: [{ draft_id: 'draft_1', ok: true }] },
    ]);

    await new FeishuMailTriageTool(runner).execute({
      query: 'budget',
      filter_json: '{"folder":"INBOX"}',
      max: 5,
      labels: true,
    }, context);
    assert.deepEqual(runner.calls[0].args, [
      'mail',
      '+triage',
      '--as',
      'user',
      '--mailbox',
      'me',
      '--max',
      '5',
      '--format',
      'json',
      '--query',
      'budget',
      '--filter',
      '{"folder":"INBOX"}',
      '--labels',
    ]);

    await new FeishuMailReadTool(runner).execute({ message_id: 'msg_1' }, context);
    assert.deepEqual(runner.calls[1].args, [
      'mail',
      '+message',
      '--as',
      'user',
      '--mailbox',
      'me',
      '--message-id',
      'msg_1',
      '--format',
      'json',
      '--html=false',
    ]);

    await new FeishuMailDraftCreateTool(runner).execute({
      to: 'a@example.test',
      subject: 'Follow up',
      body: 'Please review.',
      cc: 'b@example.test',
      priority: 'high',
    }, context);
    assert.deepEqual(runner.calls[2].args, [
      'mail',
      '+draft-create',
      '--as',
      'user',
      '--mailbox',
      'me',
      '--to',
      'a@example.test',
      '--subject',
      'Follow up',
      '--body',
      'Please review.',
      '--plain-text',
      '--cc',
      'b@example.test',
      '--priority',
      'high',
    ]);

    const blockedRunner = new MockLarkCliRunner([]);
    const blocked = JSON.parse(await new FeishuMailDraftSendConfirmedTool(blockedRunner).execute({
      draft_id: 'draft_1',
    }, context));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(blockedRunner.calls.length, 0);

    await new FeishuMailDraftSendConfirmedTool(runner).execute({
      draft_id: 'draft_1',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[3].args, [
      'mail',
      '+draft-send',
      '--as',
      'user',
      '--mailbox',
      'me',
      '--draft-id',
      'draft_1',
      '--format',
      'json',
      '--yes',
    ]);
    assertNoDryRun(runner);
  });

  test('minutes wrappers cover search, metadata, notes, and URL-only media download', async () => {
    const runner = new MockLarkCliRunner([
      { minutes: [{ token: 'min_1' }] },
      { minute: { token: 'min_1', title: 'Weekly sync' } },
      { notes: { summary: 'Done' } },
      { downloads: [{ token: 'min_1', url: 'https://download.example.test' }] },
    ]);

    await new FeishuMinutesSearchTool(runner).execute({
      query: 'weekly',
      owner_ids: 'me',
      start: '2026-06-01',
      page_size: 3,
    }, context);
    assert.deepEqual(runner.calls[0].args, [
      'minutes',
      '+search',
      '--as',
      'user',
      '--page-size',
      '3',
      '--format',
      'json',
      '--query',
      'weekly',
      '--owner-ids',
      'me',
      '--start',
      '2026-06-01',
    ]);

    await new FeishuMinutesGetTool(runner).execute({
      minute_token: 'min_1',
      user_id_type: 'open_id',
    }, context);
    assert.deepEqual(runner.calls[1].args, [
      'minutes',
      'minutes',
      'get',
      '--as',
      'user',
      '--params',
      '{"minute_token":"min_1","user_id_type":"open_id"}',
      '--format',
      'json',
    ]);

    await new FeishuMinutesNotesTool(runner).execute({ minute_tokens: 'min_1' }, context);
    assert.deepEqual(runner.calls[2].args, [
      'vc',
      '+notes',
      '--as',
      'user',
      '--minute-tokens',
      'min_1',
      '--format',
      'json',
    ]);

    await new FeishuMinutesDownloadTool(runner).execute({ minute_tokens: 'min_1' }, context);
    assert.deepEqual(runner.calls[3].args, [
      'minutes',
      '+download',
      '--as',
      'user',
      '--minute-tokens',
      'min_1',
      '--format',
      'json',
      '--url-only',
    ]);

    const blockedRunner = new MockLarkCliRunner([]);
    const blocked = JSON.parse(await new FeishuMinutesDownloadTool(blockedRunner).execute({
      minute_tokens: 'min_1',
      url_only: false,
    }, context));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(blockedRunner.calls.length, 0);
    assertNoDryRun(runner);
  });

  test('docs wrappers use docs v2 and gate create/update', async () => {
    const runner = new MockLarkCliRunner([
      { items: [{ token: 'doc_1' }] },
      { content: '<doc></doc>' },
      { doc_token: 'doc_2' },
      { updated: true },
    ]);

    await new FeishuDocsSearchTool(runner).execute({
      query: 'proposal',
      filter_json: '{"doc_types":["docx"]}',
      page_size: 2,
    }, context);
    assert.deepEqual(runner.calls[0].args, [
      'docs',
      '+search',
      '--as',
      'user',
      '--page-size',
      '2',
      '--format',
      'json',
      '--query',
      'proposal',
      '--filter',
      '{"doc_types":["docx"]}',
    ]);

    await new FeishuDocsFetchTool(runner).execute({
      doc: 'doc_1',
      scope: 'outline',
      detail: 'with-ids',
      doc_format: 'markdown',
    }, context);
    assert.deepEqual(runner.calls[1].args, [
      'docs',
      '+fetch',
      '--api-version',
      'v2',
      '--as',
      'user',
      '--doc',
      'doc_1',
      '--scope',
      'outline',
      '--detail',
      'with-ids',
      '--doc-format',
      'markdown',
      '--format',
      'json',
    ]);

    const blockedRunner = new MockLarkCliRunner([]);
    const blocked = JSON.parse(await new FeishuDocsCreateConfirmedTool(blockedRunner).execute({
      content: '<title>Draft</title>',
    }, context));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(blockedRunner.calls.length, 0);

    await new FeishuDocsCreateConfirmedTool(runner).execute({
      content: '<title>Draft</title>',
      parent_position: 'my_library',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[2].args, [
      'docs',
      '+create',
      '--api-version',
      'v2',
      '--as',
      'user',
      '--content',
      '<title>Draft</title>',
      '--doc-format',
      'xml',
      '--parent-position',
      'my_library',
    ]);

    await new FeishuDocsUpdateConfirmedTool(runner).execute({
      doc: 'doc_2',
      command: 'append',
      content: '<p>Next</p>',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[3].args, [
      'docs',
      '+update',
      '--api-version',
      'v2',
      '--as',
      'user',
      '--doc',
      'doc_2',
      '--command',
      'append',
      '--doc-format',
      'xml',
      '--content',
      '<p>Next</p>',
    ]);
    assertNoDryRun(runner);
  });

  test('drive wrappers search/read safely and gate external writes', async () => {
    const runner = new MockLarkCliRunner([
      { items: [{ token: 'file_1' }] },
      { file_token: 'file_2' },
      { saved_to: 'output/report.pdf' },
      { token: 'sht_1' },
    ]);

    await new FeishuDriveSearchTool(runner).execute({
      query: 'report',
      doc_types: 'file,docx',
      mine: true,
      only_title: true,
    }, context);
    assert.deepEqual(runner.calls[0].args, [
      'drive',
      '+search',
      '--as',
      'user',
      '--page-size',
      '15',
      '--format',
      'json',
      '--query',
      'report',
      '--doc-types',
      'file,docx',
      '--mine',
      '--only-title',
    ]);

    const blockedRunner = new MockLarkCliRunner([]);
    const blocked = JSON.parse(await new FeishuDriveUploadConfirmedTool(blockedRunner).execute({
      file: 'report.pdf',
    }, context));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(blockedRunner.calls.length, 0);

    await new FeishuDriveUploadConfirmedTool(runner).execute({
      file: 'report.pdf',
      folder_token: 'fld_1',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[1].args, [
      'drive',
      '+upload',
      '--as',
      'user',
      '--file',
      'report.pdf',
      '--folder-token',
      'fld_1',
    ]);

    await new FeishuDriveDownloadTool(runner).execute({
      file_token: 'file_2',
      output: 'output/report.pdf',
    }, context);
    assert.deepEqual(runner.calls[2].args, [
      'drive',
      '+download',
      '--as',
      'user',
      '--file-token',
      'file_2',
      '--output',
      'output/report.pdf',
    ]);

    await new FeishuDriveImportConfirmedTool(runner).execute({
      file: 'tracker.xlsx',
      type: 'sheet',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[3].args, [
      'drive',
      '+import',
      '--as',
      'user',
      '--file',
      'tracker.xlsx',
      '--type',
      'sheet',
    ]);
    assertNoDryRun(runner);
  });

  test('drive and minutes tools expose only safe local artifact manifests', async () => {
    const runner = new MockLarkCliRunner([
      { file_token: 'file_2' },
      { saved_to: 'output/secretary/downloads/report.pdf' },
      { token: 'sht_1' },
      {
        files: [
          { path: 'output/secretary/minutes/min_1-summary.md' },
          { file_path: path.join(context.workingDirectory, 'output/secretary/minutes/min_1-transcript.txt') },
        ],
      },
      { downloads: [{ token: 'min_1', saved_to: 'output/secretary/minutes/min_1.mp4' }] },
      { downloads: [{ token: 'min_1', url: 'https://download.example.test/min_1.mp4' }] },
    ]);

    const uploadTool = new FeishuDriveUploadConfirmedTool(runner);
    const uploadResult = await uploadTool.execute({
      file: 'fixtures/secretary/report.pdf',
      folder_token: 'fld_1',
      confirmed: true,
    }, context);
    const uploadManifest = uploadTool.getArtifactManifest?.({
      file: 'fixtures/secretary/report.pdf',
      confirmed: true,
    }, uploadResult, context) ?? [];
    assert.deepEqual(uploadManifest, [{
      path: 'fixtures/secretary/report.pdf',
      type: 'pdf',
      action: 'captured',
      metadata: {
        source: 'tool_owned',
        tool: 'feishu_drive_upload_confirmed',
        artifact_role: 'upload_source',
      },
    }]);

    const downloadTool = new FeishuDriveDownloadTool(runner);
    const downloadResult = await downloadTool.execute({ file_token: 'file_2' }, context);
    const downloadManifest = downloadTool.getArtifactManifest?.({ file_token: 'file_2' }, downloadResult, context) ?? [];
    assert.deepEqual(downloadManifest, [{
      path: 'output/secretary/downloads/report.pdf',
      type: 'pdf',
      action: 'captured',
      metadata: {
        source: 'tool_owned',
        tool: 'feishu_drive_download',
        artifact_role: 'downloaded_file',
      },
    }]);

    const importTool = new FeishuDriveImportConfirmedTool(runner);
    const importResult = await importTool.execute({
      file: 'fixtures/secretary/tracker.xlsx',
      type: 'sheet',
      confirmed: true,
    }, context);
    const importManifest = importTool.getArtifactManifest?.({
      file: 'fixtures/secretary/tracker.xlsx',
      type: 'sheet',
      confirmed: true,
    }, importResult, context) ?? [];
    assert.deepEqual(importManifest.map(item => item.path), ['fixtures/secretary/tracker.xlsx']);
    assert.equal(importManifest[0].metadata?.artifact_role, 'import_source');

    const notesTool = new FeishuMinutesNotesTool(runner);
    const notesResult = await notesTool.execute({
      minute_tokens: 'min_1',
      output_dir: 'output/secretary/minutes',
    }, context);
    const notesManifest = notesTool.getArtifactManifest?.({}, notesResult, context) ?? [];
    assert.deepEqual(notesManifest.map(item => item.path), [
      'output/secretary/minutes/min_1-summary.md',
      'output/secretary/minutes/min_1-transcript.txt',
    ]);
    assert.ok(notesManifest.every(item => item.metadata?.source === 'tool_owned'));
    assert.ok(notesManifest.every(item => item.metadata?.artifact_role === 'minutes_notes'));

    const mediaTool = new FeishuMinutesDownloadTool(runner);
    const mediaResult = await mediaTool.execute({
      minute_tokens: 'min_1',
      url_only: false,
      confirmed: true,
    }, context);
    const mediaManifest = mediaTool.getArtifactManifest?.({
      minute_tokens: 'min_1',
      url_only: false,
      confirmed: true,
    }, mediaResult, context) ?? [];
    assert.deepEqual(mediaManifest.map(item => item.path), ['output/secretary/minutes/min_1.mp4']);
    assert.equal(mediaManifest[0].metadata?.artifact_role, 'minutes_media');

    const urlOnlyResult = await mediaTool.execute({ minute_tokens: 'min_1' }, context);
    assert.deepEqual(mediaTool.getArtifactManifest?.({ minute_tokens: 'min_1' }, urlOnlyResult, context), []);

    const privatePathResult = JSON.stringify({ ok: true, file: '/Users/guowei/private/report.pdf', result: {} });
    assert.deepEqual(uploadTool.getArtifactManifest?.({
      file: '/Users/guowei/private/report.pdf',
      confirmed: true,
    }, privatePathResult, context), []);
    assertNoDryRun(runner);
  });

  test('sheets and base wrappers read structured data and gate mutations', async () => {
    const runner = new MockLarkCliRunner([
      { values: [['Name', 'Status']] },
      { appended: 1 },
      { tables: [{ table_id: 'tbl_1' }] },
      { records: [{ record_id: 'rec_1' }] },
      { record_id: 'rec_2' },
    ]);

    await new FeishuSheetsReadTool(runner).execute({
      spreadsheet_token: 'sht_1',
      range: 'A1:B2',
      sheet_id: 'gid_1',
      value_render_option: 'FormattedValue',
    }, context);
    assert.deepEqual(runner.calls[0].args, [
      'sheets',
      '+read',
      '--as',
      'user',
      '--range',
      'A1:B2',
      '--spreadsheet-token',
      'sht_1',
      '--sheet-id',
      'gid_1',
      '--value-render-option',
      'FormattedValue',
    ]);

    const blockedRunner = new MockLarkCliRunner([]);
    const blocked = JSON.parse(await new FeishuSheetsAppendConfirmedTool(blockedRunner).execute({
      spreadsheet_token: 'sht_1',
      range: 'A2:B2',
      values_json: '[["Alice","Open"]]',
    }, context));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'WRITE_CONFIRMATION_REQUIRED');
    assert.equal(blockedRunner.calls.length, 0);

    await new FeishuSheetsAppendConfirmedTool(runner).execute({
      spreadsheet_token: 'sht_1',
      range: 'A2:B2',
      values_json: '[["Alice","Open"]]',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[1].args, [
      'sheets',
      '+append',
      '--as',
      'user',
      '--range',
      'A2:B2',
      '--values',
      '[["Alice","Open"]]',
      '--spreadsheet-token',
      'sht_1',
    ]);

    await new FeishuBaseTableListTool(runner).execute({ base_token: 'bascn_1', limit: 3 }, context);
    assert.deepEqual(runner.calls[2].args, [
      'base',
      '+table-list',
      '--as',
      'user',
      '--base-token',
      'bascn_1',
      '--limit',
      '3',
    ]);

    await new FeishuBaseRecordListTool(runner).execute({
      base_token: 'bascn_1',
      table_id: 'tbl_1',
      field_ids: 'Name,Status',
      view_id: 'All',
      limit: 5,
    }, context);
    assert.deepEqual(runner.calls[3].args, [
      'base',
      '+record-list',
      '--as',
      'user',
      '--base-token',
      'bascn_1',
      '--table-id',
      'tbl_1',
      '--limit',
      '5',
      '--format',
      'json',
      '--view-id',
      'All',
      '--field-id',
      'Name',
      '--field-id',
      'Status',
    ]);

    await new FeishuBaseRecordUpsertConfirmedTool(runner).execute({
      base_token: 'bascn_1',
      table_id: 'tbl_1',
      fields_json: '{"Name":"Alice","Status":"Open"}',
      confirmed: true,
    }, context);
    assert.deepEqual(runner.calls[4].args, [
      'base',
      '+record-upsert',
      '--as',
      'user',
      '--base-token',
      'bascn_1',
      '--table-id',
      'tbl_1',
      '--json',
      '{"Name":"Alice","Status":"Open"}',
    ]);
    assertNoDryRun(runner);
  });

  test('redacts token and secret fields recursively', () => {
    const redacted = redactSecrets({
      access_token: 'aaa',
      nested: {
        client_secret: 'bbb',
        device_code: 'not-redacted-by-contract',
      },
      header: 'Bearer abc.def',
    });

    assert.deepEqual(redacted, {
      access_token: '[REDACTED]',
      nested: {
        client_secret: '[REDACTED]',
        device_code: 'not-redacted-by-contract',
      },
      header: 'Bearer [REDACTED]',
    });
  });
});

function assertNoDryRun(runner: MockLarkCliRunner): void {
  const forbiddenFlag = ['--dry', 'run'].join('-');
  for (const call of runner.calls) {
    assert.equal(call.args.includes(forbiddenFlag), false, `command must not include forbidden flag: ${call.args.join(' ')}`);
  }
}
