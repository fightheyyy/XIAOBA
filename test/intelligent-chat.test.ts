import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventSchemas } from '@ag-ui/core/schemas';
import { A2UIModel, A2UI_VERSION, CATALOG_ID } from '../src/surfaces/dashboard/a2ui';
import { createChatFixture, formMessages, until } from './helpers/intelligent-chat-fixture';
import { PetChatHistoryStore } from '../src/surfaces/pet/chat-history-store';
import { SendUITool } from '../src/capabilities/tools/send-ui-tool';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { McpAppsConnector } from '../src/connectors/mcp-apps';
import { DashboardChatChannel } from '../src/surfaces/dashboard/chat-channel';

describe('A2UI session model', () => {
  test('gives actionable feedback for legacy component wrappers and incorrect data envelopes', () => {
    const model = new A2UIModel();
    model.apply([{ version: A2UI_VERSION, createSurface: { surfaceId: 'x', catalogId: CATALOG_ID } }]);
    assert.throws(() => model.apply([{ version: A2UI_VERSION, updateComponents: { surfaceId: 'x', components: [{ id: 'root', component: { Text: { text: 'Hello' } } }] } }]), /flat component/);
    assert.throws(() => model.apply([{ version: A2UI_VERSION, updateDataModel: { surfaceId: 'x', data: { budget: 300 } } }]), /value.*not data/);
    assert.deepEqual(model.surfaces.get('x')!.data, {});
  });
  test('validates and applies a form atomically, deriving action context only from declared inputs', () => {
    const model = new A2UIModel(); model.apply(formMessages());
    const input = { surfaceId: 'scope', sourceComponentId: 'submit', name: 'update_scope', revision: 2, values: { '/project': 'other', '/period': 'month' }, context: { forged: 'not trusted' } };
    const result = model.action(input);
    assert.deepEqual(result.action.context, { project: 'other', period: 'month' });
    assert.equal(result.action.metadata.dataModel.project, 'other');
    assert.equal(model.surfaces.get('scope')!.data.project, 'xiaobaOS');
    assert.throws(() => model.action({ ...input, revision: 1 }), /stale/);
    assert.throws(() => model.action({ ...input, values: { '/hidden': 'injected' } }), /undeclared/);
    assert.throws(() => model.action({ ...input, values: { '/period': 'invalid' } }), /choice/);
    assert.throws(() => model.action({ ...input, values: { '/project': '' } }), /Required/);
    assert.throws(() => model.action({ ...input, sourceComponentId: 'root' }), /stale/);
    assert.throws(() => model.apply([{ version: A2UI_VERSION, updateComponents: { surfaceId: 'scope', components: [{ id: 'root', component: 'Column', children: ['root'] }] } }]), /Cyclic/);
    assert.equal(model.surfaces.get('scope')!.components.root.children[0], 'form');
  });
  test('rejects executable markup, unsupported catalogs and prototype paths', () => {
    const model = new A2UIModel();
    assert.throws(() => model.apply([{ version: A2UI_VERSION, createSurface: { surfaceId: 'x', catalogId: 'https://other/catalog' } }]), /catalog/);
    model.apply([{ version: A2UI_VERSION, createSurface: { surfaceId: 'x', catalogId: CATALOG_ID } }]);
    assert.throws(() => model.apply([{ version: A2UI_VERSION, updateComponents: { surfaceId: 'x', components: [{ id: 'root', component: 'HTML', html: '<script>alert(1)</script>' }] } }]), /Unsupported/);
    assert.throws(() => model.apply([{ version: A2UI_VERSION, updateDataModel: { surfaceId: 'x', path: '/__proto__/polluted', value: true } }]), /Unsafe/);
    assert.equal(({} as any).polluted, undefined);
  });
  test('UI delivery is unavailable to ordinary channels and children', async () => {
    const tool = new SendUITool();
    assert.equal(tool.isAvailable({ surface: 'pet', channel: { chatId: 'pet:test', reply: async () => {}, sendFile: async () => {} } }), false);
    assert.equal(tool.isAvailable({ parentSessionId: 'parent', channel: { chatId: 'child', reply: async () => {}, sendFile: async () => {}, sendUI: async () => {} } }), false);
    let sent = false;
    const result = await tool.execute({ messages: formMessages() }, { workingDirectory: process.cwd(), conversationHistory: [], sessionId: 'chat:test', surface: 'pet', channel: { chatId: 'chat:test', reply: async () => {}, sendFile: async () => {}, sendUI: async () => { sent = true; } } });
    assert.equal(sent, true); assert.equal(result.delivery_evidence?.[0].delivery_type, 'ui');
  });
});

test('failed UI delivery reports its actual error over AG-UI', async () => {
  const fixture = await createChatFixture(), threadId = fixture.channel.threadId;
  let calls = 0;
  fixture.ai.chatStream = async () => ++calls === 1 ? { content: null, toolCalls: [{ id: randomUUID(), type: 'function', function: { name: 'send_ui', arguments: JSON.stringify({ messages: [{ version: A2UI_VERSION, createSurface: { surfaceId: 'bad', catalogId: 'unsupported' } }] }) } }] } : { content: '' };
  const store = new PetChatHistoryStore(path.join(fixture.root, 'data/chat/sessions'));
  try {
    const response = await fetch(fixture.url + '/api/chat/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaoba-Chat': '1' }, body: JSON.stringify({ threadId, eventId: randomUUID(), text: 'render' }) });
    assert.equal(response.status, 200);
    await until(() => store.read(threadId, 2000).some((event: any) => event.type === 'RUN_FINISHED'));
    const event = store.read(threadId, 2000).find((event: any) => event.type === 'TOOL_CALL_RESULT') as any;
    const result = JSON.parse(event.content);
    assert.equal(result.name, 'send_ui');
    assert.equal(result.status, 'failure');
    assert.match(result.summary, /catalog/);
    assert.notEqual(result.summary, '已交付');
  } finally { await fixture.close(); }
});

test('Dashboard accepts a second user message into the active Main run', async () => {
  const fixture = await createChatFixture();
  let release!: (value: any) => void;
  const held = new Promise<any>(resolve => { release = resolve; });
  const requests: any[][] = [];
  fixture.ai.chatStream = async (messages: any[]) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) return held;
    if (requests.length === 2) {
      assert.ok(messages.some(message => message.role === 'user' && message.content === '只查北京明天'));
      return { content: null, toolCalls: [{ id: randomUUID(), type: 'function', function: {
        name: 'send_text', arguments: JSON.stringify({ text: '收到，改查北京明天。' }),
      } }] };
    }
    return { content: '' };
  };
  const post = (text: string) => fetch(fixture.url + '/api/chat/message', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Xiaoba-Chat': '1' },
    body: JSON.stringify({ threadId: fixture.channel.threadId, text, eventId: randomUUID() }) });
  const events = () => new PetChatHistoryStore(path.join(fixture.root, 'data/chat/sessions')).read(fixture.channel.threadId, 2000) as any[];
  try {
    assert.equal((await post('帮我查天气')).status, 200);
    await until(() => requests.length === 1);
    assert.equal((await post('只查北京明天')).status, 200);
    assert.equal(requests.length, 1);
    release({ content: '旧草稿' });
    await until(() => events().some(event => event.type === 'RUN_FINISHED'));
    assert.equal(events().filter(event => event.type === 'RUN_STARTED').length, 1);
    assert.ok(events().some(event => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta === '收到，改查北京明天。'));
    assert.ok(!events().some(event => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta === '旧草稿'));
  } finally { release({ content: '' }); await fixture.close(); }
});

test('real AgentSession → AG-UI → A2UI action / MCP Apps / asynchronous child lifecycle', async () => {
  const fixture = await createChatFixture(), threadId = fixture.channel.threadId;
  const store = new PetChatHistoryStore(path.join(fixture.root, 'data/chat/sessions'));
  const events = () => store.read(threadId, 2000) as any[];
  const headers = { 'Content-Type': 'application/json', 'X-Xiaoba-Chat': '1' };
  const post = async (route: string, body: any, extra = {}) => fetch(fixture.url + '/api/chat' + route, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal(threadId, 'chat:main');
    assert.equal((await (await fetch(fixture.url + '/api/chat/config')).json()).threadId, threadId);
    assert.equal((await fetch(fixture.url + '/api/chat/sessions')).status, 404);
    assert.equal((await fetch(fixture.url + '/api/chat/events?threadId=chat:other')).status, 400);
    assert.equal((await post('/message', { threadId: 'chat:other', eventId: randomUUID(), text: 'new' })).status, 400);
    const eventId = randomUUID(), message = { threadId, eventId, text: '分析本周项目进展' };
    assert.equal((await post('/message', message)).status, 200);
    await until(() => events().some(event => event.type === 'SUBAGENT_FINISHED' && event.outcome?.type === 'success'));
    await until(() => events().filter(event => event.type === 'RUN_FINISHED').length >= 2);
    const all = events();
    for (const event of all) assert.equal(EventSchemas.safeParse(event).success, true, `Invalid AG-UI event: ${event.type}`);
    assert.ok(all.some(event => event.type === 'CUSTOM' && event.name === 'a2ui'));
    const start = all.find(event => event.type === 'SUBAGENT_STARTED');
    assert.ok(start.parentToolCallId);
    assert.ok(all.some(event => event.type === 'TOOL_CALL_START' && event.toolCallId === start.parentToolCallId));
    assert.ok(all.some(event => event.type === 'ACTIVITY_SNAPSHOT' && event.content.status === 'running'));
    const activity = all.filter(event => event.type === 'ACTIVITY_SNAPSHOT' && event.activityType === 'SUBAGENT');
    assert.ok(activity.some(event => event.content.resultPending === true));
    assert.equal(activity.at(-1).content.resultPending, false);
    assert.ok(all.some(event => event.type === 'TOOL_CALL_RESULT' && event.toolCallId === start.parentToolCallId));
    assert.ok(!all.some(event => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta.includes('hidden provider final')));
    const originalCount = fixture.ai.requests.length;
    assert.equal((await (await post('/message', message)).json()).duplicate, true);
    assert.equal(fixture.ai.requests.length, originalCount);
    assert.equal((await post('/message', { ...message, text: 'changed' })).status, 400);
    assert.equal((await post('/message', { ...message, eventId: randomUUID() }, { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await post('/message', { ...message, threadId: 'chat:role-engineer:bad', eventId: randomUUID() })).status, 400);
    const action = { surfaceId: 'scope', sourceComponentId: 'submit', name: 'update_scope', revision: 2, values: { '/project': 'another', '/period': 'month' }, timestamp: new Date().toISOString() };
    assert.equal((await post('/action', { threadId: 'chat:other', eventId: randomUUID(), action })).status, 400);
    const actionRequest = { threadId, eventId: randomUUID(), action };
    assert.equal((await post('/action', actionRequest)).status, 200);
    await until(() => events().some(event => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta.includes('范围已更新')));
    assert.equal((await (await post('/action', actionRequest)).json()).duplicate, true);
    const app = events().find(event => event.type === 'CUSTOM' && event.name === 'xiaoba.mcp.app').value;
    assert.equal(fixture.counters.reads, 1);
    const document = await fetch(`${fixture.url}/api/chat/apps/${app.appId}/document?threadId=${threadId}`);
    assert.equal(document.status, 200); assert.match(document.headers.get('content-security-policy')!, /sandbox allow-scripts/);
    assert.doesNotMatch(document.headers.get('content-security-policy')!, /allow-same-origin/);
    assert.equal((await fetch(`${fixture.url}/api/chat/apps/${app.appId}/document?threadId=chat:other`)).status, 403);
    assert.equal((await post(`/apps/${app.appId}/rpc`, { threadId, method: 'tools/call', params: { name: 'project_update', arguments: {} } })).status, 403);
    assert.equal(fixture.counters.writes, 0);
    assert.equal((await post(`/apps/${app.appId}/rpc`, { threadId, method: 'tools/call', params: { name: 'project_progress', arguments: {} } })).status, 200);
    assert.equal(fixture.counters.reads, 2);
    assert.equal((await post(`/apps/${app.appId}/rpc`, { threadId: 'chat:other', method: 'initial' })).status, 403);
    const writeArgs = { server: 'projects', tool: 'project_update', arguments: {}, confirmed: true };
    const writeCall = { id: randomUUID(), type: 'function' as const, function: { name: 'mcp_write', arguments: JSON.stringify(writeArgs) } };
    const writeContext = { sessionId: threadId, surface: 'pet' as const, channel: { chatId: threadId, reply: async () => {}, sendFile: async () => {}, sendUI: async () => {} } };
    const deniedWrite = await fixture.toolManager.executeTool(writeCall, [{ role: 'user', content: '展示项目' }, { role: 'user', content: '确认', __injected: true }], writeContext);
    assert.equal(deniedWrite.status, 'blocked'); assert.equal(fixture.counters.writes, 0);
    const proposal = JSON.stringify({ server: writeArgs.server, tool: writeArgs.tool, arguments: writeArgs.arguments });
    const confirmationHistory = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'proposal-delivery', type: 'function', function: { name: 'send_text', arguments: JSON.stringify({ text: proposal }) } }] },
      { role: 'tool', name: 'send_text', tool_call_id: 'proposal-delivery', content: '已发送' },
      { role: 'user', content: '确认' },
    ];
    const mismatch = await fixture.toolManager.executeTool({ ...writeCall, function: { ...writeCall.function, arguments: JSON.stringify({ ...writeArgs, tool: 'different_tool' }) } }, confirmationHistory, writeContext);
    assert.equal(mismatch.status, 'blocked'); assert.equal(fixture.counters.writes, 0);
    const acceptedWrite = await fixture.toolManager.executeTool(writeCall, confirmationHistory, writeContext);
    assert.equal(acceptedWrite.status, 'success', String(acceptedWrite.content)); assert.equal(fixture.counters.writes, 1);
    const journalDir = path.join(fixture.root, 'data/conversations/pet');
    const journal = fs.readdirSync(journalDir).flatMap(file => fs.readFileSync(path.join(journalDir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    assert.ok(journal.some(row => row.content.some((item: any) => item.type === 'ui')));
    assert.ok(!JSON.stringify(journal).includes('<!doctype html>'));
    assert.ok(!JSON.stringify(journal).includes('hidden provider final'));
    assert.ok(fixture.ai.requests.some(request => request.messages.some((message: any) => typeof message.content === 'string' && message.content.includes('"project":"another"'))));
  } finally { await fixture.close(); }
});

test('legacy Chat resumes its latest conversation across service restarts without deleting history', async () => {
  const fixture = await createChatFixture(root => {
    const store = new PetChatHistoryStore(path.join(root, 'data/chat/sessions'));
    store.append('chat:older', { id: 10, sessionKey: 'chat:older', type: 'CUSTOM', name: 'xiaoba.user.message', value: { text: 'older' } });
    store.append('chat:latest', { id: 20, sessionKey: 'chat:latest', type: 'CUSTOM', name: 'xiaoba.user.message', value: { text: 'latest' } });
    fs.appendFileSync(store.filePath('chat:latest'), Array.from({ length: 2001 }, (_, index) => JSON.stringify({ id: 21 + index, sessionKey: 'chat:latest', type: 'CUSTOM', name: 'background-update' }) + '\n').join(''));
    // An unused/failed empty conversation must not displace the real user conversation.
    store.append('chat:empty', { id: 9999, sessionKey: 'chat:empty', type: 'RUN_ERROR', message: 'unused' });
  });
  let restarted: DashboardChatChannel | undefined;
  try {
    assert.equal((await (await fetch(fixture.url + '/api/chat/config')).json()).threadId, 'chat:latest');
    const directory = path.join(fixture.root, 'data/chat/sessions');
    const before = fs.readdirSync(directory).map(file => fs.readFileSync(path.join(directory, file), 'utf8'));
    await fixture.channel.destroy();
    restarted = new DashboardChatChannel({ root: fixture.root, mcp: new McpAppsConnector({ environment: {} }), services: {
      aiService: fixture.ai as any, toolManager: fixture.toolManager, skillManager: new SkillManager('base'),
    } });
    assert.equal(restarted.threadId, 'chat:latest');
    assert.deepEqual(fs.readdirSync(directory).map(file => fs.readFileSync(path.join(directory, file), 'utf8')), before);
    assert.equal(fixture.ai.requests.length, 0);
  } finally { await restarted?.destroy(); await fixture.close(); }
});

test('explicit Base prompt and skills stay independent of the global active role', async () => {
  const original = process.env.XIAOBA_ROLE;
  const originalCurrent = process.env.CURRENT_ROLE;
  process.env.XIAOBA_ROLE = 'inspector-cat'; delete process.env.CURRENT_ROLE;
  try {
    const prompt = await PromptManager.buildSystemPrompt({ roleName: 'base' });
    assert.ok(!prompt.includes('你是 InspectorCat'));
    const skills = new SkillManager('base'); await skills.loadSkills();
    assert.ok(skills.getAllSkills().every(skill => !skill.filePath.includes('/roles/inspector-cat/')));
  } finally {
    if (original === undefined) delete process.env.XIAOBA_ROLE; else process.env.XIAOBA_ROLE = original;
    if (originalCurrent === undefined) delete process.env.CURRENT_ROLE; else process.env.CURRENT_ROLE = originalCurrent;
  }
});

test('MCP configuration rejects non-loopback plaintext and credentials in URLs', () => {
  for (const url of ['http://remote.example/mcp', 'https://token:secret@example.com/mcp', 'file:///etc/passwd']) {
    const connector = new McpAppsConnector({ environment: { XIAOBA_MCP_SERVERS: JSON.stringify({ bad: { url } }) } });
    assert.throws(() => connector.config());
  }
});
