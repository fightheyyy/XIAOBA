import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSession } from '../src/core/agent-session';
import { dispatchHarborInstruction } from '../src/eval/harbor-session';
import { EventDispatcher } from '../src/events/dispatcher';
import { SkillManager } from '../src/skills/skill-manager';
import { ToolManager } from '../src/tools/tool-manager';
import { Message } from '../src/types';
import { ToolDefinition } from '../src/types/tool';
import { Logger } from '../src/utils/logger';
import { MemoryFinalizer } from '../src/utils/memory-finalizer';

test('Harbor stages retain session, tool facts and memory; notices never become authentic user input', async () => {
  const cwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-harbor-'));
  process.chdir(root);
  Logger.setSilentMode(true);
  const key = 'harbor:continuity';
  const requests: Message[][] = [];
  let calls = 0;
  let effects = 0;
  const ai = { async chatStream(messages: Message[], tools: ToolDefinition[]) {
    requests.push(JSON.parse(JSON.stringify(messages)));
    assert.deepEqual(tools.map(tool => tool.name), ['calendar__create_event']);
    if (++calls === 1) return { toolCalls: [{ id: 'create-1', type: 'function', function: {
      name: 'calendar__create_event', arguments: '{"title":"filing deadline"}',
    } }] };
    return { content: 'Stage completed.' };
  } };
  const services = {
    aiService: ai as any, skillManager: new SkillManager(),
    toolManager: new ToolManager(root, { surface: 'agent' }, [{
      definition: { name: 'calendar__create_event', description: 'Task MCP tool',
        parameters: { type: 'object', properties: { title: { type: 'string' } } } },
      execute: async (args: { title: string }) => {
        assert.equal(args.title, 'filing deadline');
        effects++;
        return { toolContent: 'event-id-42', status: 'success' as const };
      },
    }], { inheritBaseTools: false, baseToolAllowlist: [] }),
  };
  const session = new AgentSession(key, services, 'harbor');
  const dispatcher = new EventDispatcher();
  const initial = '[2026-05-20 09:00 +08:00] User Wang Fang says:\n\nHelp recover the loan.';
  const notice = '[2026-05-21 09:00 +08:00] Notice from the Court:\n\nOnline filing is open.';
  try {
    MemoryFinalizer.remember(key, '偏好先列事实', { rootDir: root });
    await dispatchHarborInstruction(session, dispatcher, initial, 0);
    await dispatchHarborInstruction(session, dispatcher, notice, 1);
    await dispatchHarborInstruction(session, dispatcher,
      '[2026-05-21 20:30 +08:00] User Wang Fang says:\n\nWhat comes next?', 2);
    assert.equal(effects, 1);
    const last = requests.at(-1)!;
    assert.ok(last.some(message => message.role === 'tool' && String(message.content).includes('event-id-42')));
    assert.ok(last.some(message => message.content === initial && !message.__injected));
    assert.ok(last.some(message => message.content === notice && message.__injected));
    assert.match(last.map(message => String(message.content)).join('\n'), /偏好先列事实/);
    assert.deepEqual(dispatcher.list().map(record => record.status), ['handled', 'handled', 'handled']);
    const records = dispatcher.list().map(record => record.event);
    assert.equal(records.find(event => event.type === 'harbor.notification')!.source.kind, 'runtime');
    const logRoot = path.join(root, 'logs', 'sessions', 'harbor');
    const traces = fs.readdirSync(logRoot, { recursive: true }).map(String).filter(file => file.endsWith('traces.jsonl'));
    assert.equal(traces.length, 1);
    const rows = fs.readFileSync(path.join(logRoot, traces[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.entry_type === 'trace').length, 3);
    assert.match(JSON.stringify(rows), /calendar__create_event/);
    // A duplicate admitted event must not repeat the external effect or model call.
    await dispatchHarborInstruction(session, dispatcher, initial, 0);
    assert.equal(calls, 4);
    assert.equal(effects, 1);
  } finally {
    await session.cleanup({ checkWakeup: false });
    process.chdir(cwd);
    Logger.setSilentMode(false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Harbor propagates session failures and keeps the Event failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-harbor-failure-'));
  const dispatcher = new EventDispatcher(root);
  let options: any;
  const session = { key: 'harbor:failure', handleMessage: async (_text: string, input: unknown) => {
    options = input;
    return { failed: true, text: 'provider unavailable' };
  } } as unknown as AgentSession;
  try {
    await assert.rejects(dispatchHarborInstruction(session, dispatcher, 'Unknown environment update', 0),
      /XIAOBA_HARBOR_SESSION_FAILED/);
    assert.equal(options.internal, true);
    assert.equal(dispatcher.list()[0].status, 'failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
