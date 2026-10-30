import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { SubAgentManager } from '../src/runtime/subagents/sub-agent-manager';
import { SubAgentJournal } from '../src/runtime/subagents/sub-agent-journal';
import { syncSubAgentContext } from '../src/runtime/subagents/sub-agent-context';
import { ToolManager } from '../src/capabilities/tools/tool-manager';
import { Logger } from '../src/runtime/observability/logger';
import { SubAgentSession } from '../src/runtime/subagents/sub-agent-session';
import type { Message } from '../src/runtime/contracts';
import type { SubAgentInfo } from '../src/runtime/subagents/sub-agent-session';

const skills = { loadSkills: async () => {}, getAllSkills: () => [], getUserInvocableSkills: () => [],
  getSkill: () => undefined, findAutoInvocableSkillByText: () => undefined };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function scoped(run: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-main-sub-state-'));
  const cwd = process.cwd();
  process.chdir(root); Logger.setSilentMode(true);
  try { await run(root); }
  finally { process.chdir(cwd); Logger.setSilentMode(false); fs.rmSync(root, { recursive: true, force: true }); }
}
const child = (overrides: Partial<SubAgentInfo> = {}): SubAgentInfo => ({
  id: 'sub-reader', taskDescription: '查北京天气', status: 'running',
  createdAt: 1, progressLog: [], outputFiles: [], ...overrides,
});

test('state projection preserves the prefix, ignores progress, and clears departed work', () => {
  const messages: Message[] = [{ role: 'user', content: '查天气' }];
  syncSubAgentContext(messages, [child()]);
  const prefix = JSON.stringify(messages);
  syncSubAgentContext(messages, [child({ progressLog: ['点击网页'], createdAt: 999 })]);
  assert.equal(JSON.stringify(messages), prefix);
  syncSubAgentContext(messages, [child({ status: 'waiting_for_input', pendingQuestion: '今天还是明天？' })]);
  assert.deepEqual(messages.slice(0, 2), JSON.parse(prefix));
  assert.match(String(messages.at(-1)?.content), /今天还是明天/);
  assert.equal(messages.at(-1)?.__injected, true);
  syncSubAgentContext(messages, []);
  assert.match(String(messages.at(-1)?.content), /\[\]$/);
});

test('state is rebuilt from runtime after compaction rather than trusting a prose summary', () => {
  const messages: Message[] = [{ role: 'system', content: '[session_memory] 之前查过天气' }];
  syncSubAgentContext(messages, [child({ status: 'interrupted', recoveryNote: '先核对产物' })]);
  assert.match(String(messages.at(-1)?.content), /interrupted/);
  assert.match(String(messages.at(-1)?.content), /先核对产物/);
  const empty: Message[] = [{ role: 'system', content: '[session_memory] 旧摘要说还有任务在跑' }];
  syncSubAgentContext(empty, []);
  assert.match(String(empty.at(-1)?.content), /\[\]$/);
});

test('received results survive a fresh projection while another task still needs synthesis', () => {
  const received = child({ id: 'papers', status: 'completed', resultSummary: 'RSI: keep a fixed external evaluation.',
    outputFiles: ['output/papers.md'], resultNotice: { id: 'papers-result', handledAt: 10 } });
  const active = child({ id: 'projects', taskDescription: '研究 personal agent 项目' });
  const compacted: Message[] = [{ role: 'system', content: '[session_memory] 两项调研需要综合结论' }];
  syncSubAgentContext(compacted, [received, active]);
  const rows = JSON.parse(String(compacted.at(-1)?.content).split('\n').at(-1)!);
  assert.equal(rows.find((row: any) => row.id === 'papers').result_pending, false);
  assert.match(rows.find((row: any) => row.id === 'papers').result, /fixed external evaluation/);
  assert.deepEqual(rows.find((row: any) => row.id === 'papers').files, ['output/papers.md']);
  assert.equal(rows.find((row: any) => row.id === 'projects').status, 'running');
  syncSubAgentContext(compacted, [received, { ...active, status: 'completed', resultSummary: 'Use durable reminders.', resultNotice: { id: 'projects-result' } }]);
  const ready = JSON.parse(String(compacted.at(-1)?.content).split('\n').at(-1)!);
  assert.equal(ready.length, 2);
  assert.equal(ready.find((row: any) => row.id === 'projects').result_pending, true);
});

test('two concurrent children can be received silently, followed by one combined delivery', () => scoped(async root => {
  const manager = SubAgentManager.getInstance(), parent = randomUUID();
  const aStarted = deferred(), bStarted = deferred(), aAnswer = deferred<any>(), bAnswer = deferred<any>();
  const reportReceived = deferred();
  const visible: string[] = [], requests: Message[][] = [];
  let reportSent = false, smallTalkSent = false;
  const tools = new ToolManager(root, { roleName: 'base' });
  const session = new AgentSession(parent, { toolManager: tools, skillManager: skills as any, roleName: 'base',
    aiService: { chatStream: async (messages: Message[]) => {
      requests.push(structuredClone(messages));
      const rows = JSON.parse(String(messages.filter(message => message.__subagentState).at(-1)?.content).split('\n').at(-1)!);
      const newest = messages.filter(message => message.role === 'user' && !message.__injected).at(-1)?.content;
      if (newest === '顺便问一句，你能一边做事一边接话吗？' && !smallTalkSent) {
        smallTalkSent = true;
        return { toolCalls: [{ id: 'small-talk', type: 'function', function: { name: 'send_text', arguments: JSON.stringify({ text: '能，你直接说。' }) } }] };
      }
      if (rows.length === 2 && rows.every((row: any) => row.status === 'completed') && !reportSent) {
        assert.match(rows.find((row: any) => row.task === '论文调研').result, /external evaluation/);
        assert.match(rows.find((row: any) => row.task === '项目调研').result, /durable reminders/);
        assert.equal(rows.find((row: any) => row.task === '论文调研').result_pending, false);
        reportSent = true;
        return { toolCalls: [{ id: 'combined', type: 'function', function: { name: 'send_text', arguments: JSON.stringify({ text: '综合两份材料：先用 durable reminders 跟进，再用 external evaluation 验证效果。' }) } }] };
      }
      return { content: '' };
    } } as any,
  }, 'pet');
  let feedback = Promise.resolve();
  let feedbackCalls = 0;
  const channel = { chatId: parent, reply: async (_id: string, text: string) => { visible.push(text); }, sendFile: async () => {} };
  const route = { injectMessage: (text: string, notice: any) => {
    feedbackCalls++;
    feedback = feedback.then(async () => {
      if (!manager.shouldHandleFeedback(parent, notice)) return;
      const result = await session.handleMessage(text, { surface: 'pet', channel, internal: true });
      assert.equal(result.failed, undefined);
      reportReceived.resolve();
    });
    return feedback;
  } };
  manager.registerPlatformCallbacks(parent, route, root);
  const a = manager.spawn(parent, undefined, '论文调研', '研究 RSI', root,
    { chatStream: async () => { aStarted.resolve(); return aAnswer.promise; } } as any, skills as any);
  const b = manager.spawn(parent, undefined, '项目调研', '研究 personal agent', root,
    { chatStream: async () => { bStarted.resolve(); return bAnswer.promise; } } as any, skills as any);
  assert.ok(!('error' in a) && !('error' in b));
  try {
    await Promise.all([aStarted.promise, bStarted.promise]);
    assert.equal(manager.listByParent(parent, root).filter(info => info.status === 'running').length, 2);
    aAnswer.resolve({ content: 'RSI needs external evaluation.' });
    for (let n = 0; n < 20 && !manager.getInfoForParent(parent, a.id, root)?.resultNotice; n++) await tick();
    assert.ok(manager.getInfoForParent(parent, a.id, root)?.resultNotice);
    manager.retryPendingResults(parent, root); await tick();
    assert.equal(feedbackCalls, 0, 'a successful partial result never wakes Main while sibling work is active');
    assert.deepEqual(visible, []);
    assert.equal(manager.listByParent(parent, root).find(info => info.id === b.id)?.status, 'running');
    await session.handleMessage('先收下现有材料，等另一项完成再汇报。', { surface: 'pet', channel });
    assert.deepEqual(visible, []);
    const receivedChild = (manager as any).subAgents.get(a.id) as SubAgentSession;
    receivedChild.completedAt = Date.now() - 31 * 60_000;
    new SubAgentJournal(root).record(parent, receivedChild.getInfo());
    (manager as any).cleanupReceivedResults(parent, root);
    assert.ok(new SubAgentJournal(root).list(parent).some(info => info.id === a.id), 'old collected material survives while the other job is running');
    assert.ok(manager.listByParent(parent, root).some(info => info.id === a.id));
    await session.handleMessage('顺便问一句，你能一边做事一边接话吗？', { surface: 'pet', channel });
    assert.deepEqual(visible, ['能，你直接说。']);
    bAnswer.resolve({ content: 'Personal agents benefit from durable reminders.' });
    await reportReceived.promise; await feedback; await tick();
    assert.equal(visible.length, 2);
    assert.match(visible[1], /durable reminders.*external evaluation/);
    assert.ok(manager.listByParent(parent, root).every(info => info.resultNotice?.handledAt));
    assert.ok(!manager.listByParent(parent, root).some(info => info.id === a.id), 'expired received material is cleaned after synthesis');
    const count = requests.length;
    manager.retryPendingResults(parent, root); await tick();
    assert.equal(requests.length, count);
  } finally {
    aAnswer.resolve({ content: '' }); bAnswer.resolve({ content: '' });
    manager.unregisterPlatformCallbacks(parent, route);
  }
}));

test('stopping the last running child releases previously collected completion feedback', () => scoped(async root => {
  const manager = SubAgentManager.getInstance(), parent = randomUUID();
  const first = deferred<any>(), second = deferred<any>(), notified = deferred();
  let count = 0;
  const route = { injectMessage: async () => { count++; notified.resolve(); } };
  manager.registerPlatformCallbacks(parent, route, root);
  const a = manager.spawn(parent, undefined, '第一项', 'research', root, { chatStream: () => first.promise } as any, skills as any);
  const b = manager.spawn(parent, undefined, '第二项', 'research', root, { chatStream: () => second.promise } as any, skills as any);
  assert.ok(!('error' in a) && !('error' in b));
  try {
    first.resolve({ content: 'collected evidence' });
    for (let n = 0; n < 20 && !manager.getInfoForParent(parent, a.id, root)?.resultNotice; n++) await tick();
    assert.equal(count, 0);
    manager.stopForParent(parent, b.id);
    second.resolve({ content: '' });
    await notified.promise; await tick();
    assert.equal(count, 1);
  } finally { first.resolve({ content: '' }); second.resolve({ content: '' }); manager.unregisterPlatformCallbacks(parent, route); }
}));

test('a failed child wakes Main without waiting for other running work', () => scoped(async root => {
  const manager = SubAgentManager.getInstance(), parent = randomUUID(), held = deferred<any>(), notified = deferred<any>();
  const route = { injectMessage: async (_text: string, notice: any) => { notified.resolve(notice); } };
  manager.registerPlatformCallbacks(parent, route, root);
  const other = manager.spawn(parent, undefined, '仍在研究', 'research', root, { chatStream: () => held.promise } as any, skills as any);
  const failed = manager.spawn(parent, undefined, '失败项', 'research', root, { chatStream: async () => { throw new Error('non-retryable failure'); } } as any, skills as any);
  assert.ok(!('error' in other) && !('error' in failed));
  try {
    const notice = await notified.promise;
    assert.equal(notice.subagentId, failed.id);
    assert.equal(manager.getInfoForParent(parent, other.id, root)?.status, 'running');
  } finally { manager.stopForParent(parent, other.id); held.resolve({ content: '' }); await tick(); manager.unregisterPlatformCallbacks(parent, route); }
}));

test('unhandled results survive retention and a restored route retries once with the same identity', () => scoped(async root => {
  const parent = randomUUID(), journal = new SubAgentJournal(root), manager = SubAgentManager.getInstance();
  const info = child({ id: randomUUID(), status: 'completed', completedAt: Date.now() - 31 * 60_000,
    resultSummary: '找到结果', resultNotice: { id: randomUUID() } });
  journal.record(parent, info);
  assert.equal(journal.list(parent).length, 1);
  let attempts = 0;
  const notified = deferred();
  const route = { injectMessage: async (_text: string, notice: any) => {
    attempts++;
    assert.equal(notice.id, info.resultNotice!.id);
    if (attempts === 1) throw new Error('offline');
    notified.resolve();
  } };
  manager.registerPlatformCallbacks(parent, route, root);
  await tick();
  assert.equal(journal.list(parent)[0].resultNotice?.handledAt, undefined);
  assert.equal(journal.acknowledge('another-parent', info.id, info.resultNotice!.id), false);
  manager.retryPendingResults(parent, root);
  await notified.promise; await tick();
  assert.equal(attempts, 2);
  assert.equal(journal.list(parent).length, 0);
  manager.retryPendingResults(parent, root);
  assert.equal(attempts, 2);
  manager.unregisterPlatformCallbacks(parent, route);
}));

test('the real main loop sees a child finish between tool calls and silently acknowledges its result', () => scoped(async root => {
  const manager = SubAgentManager.getInstance(), parent = randomUUID();
  const childStarted = deferred(), childAnswer = deferred<any>(), toolStarted = deferred(), releaseTool = deferred();
  const route = { injectMessage: async () => { throw new Error('route offline'); } };
  manager.registerPlatformCallbacks(parent, route, root);
  const spawned = manager.spawn(parent, undefined, '查天气', '查北京天气', root,
    { chatStream: async () => { childStarted.resolve(); return childAnswer.promise; } } as any, skills as any);
  assert.ok(!('error' in spawned)); if ('error' in spawned) return;
  await childStarted.promise;
  const requests: Message[][] = [];
  const tools = new ToolManager(root);
  tools.registerTool({ definition: { name: 'hold', description: 'wait', parameters: { type: 'object', properties: {} } },
    execute: async () => { toolStarted.resolve(); await releaseTool.promise; return 'ok'; } });
  const ai = { chatStream: async (messages: Message[]) => {
    requests.push(structuredClone(messages));
    return requests.length === 1 ? { toolCalls: [{ id: 'hold-call', type: 'function',
      function: { name: 'hold', arguments: '{}' } }] } : { content: '' };
  } };
  const session = new AgentSession(parent, { aiService: ai as any, toolManager: tools, skillManager: skills as any }, 'pet');
  const run = session.handleMessage('继续聊', { surface: 'pet' });
  await toolStarted.promise;
  assert.match(String(requests[0].find(message => message.__subagentState)?.content), /running/);
  childAnswer.resolve({ content: '北京晴天' });
  await tick(); await tick();
  releaseTool.resolve();
  const result = await run;
  assert.equal(result.failed, undefined);
  assert.equal(result.finalResponseVisible, false);
  assert.equal(requests.length, 2);
  assert.match(String(requests[1].filter(message => message.__subagentState).at(-1)?.content), /北京晴天/);
  assert.ok(manager.getInfoForParent(parent, spawned.id, root)?.resultNotice?.handledAt);
  assert.ok(new SubAgentJournal(root).list(parent)[0].resultNotice?.handledAt);
  manager.unregisterPlatformCallbacks(parent, route);
}));

test('a failed main inference does not acknowledge a pending result', () => scoped(async root => {
  const parent = randomUUID(), journal = new SubAgentJournal(root);
  journal.record(parent, child({ status: 'completed', completedAt: Date.now(), resultSummary: 'report', resultNotice: { id: 'notice' } }));
  const session = new AgentSession(parent, {
    aiService: { chatStream: async () => { throw new Error('provider unavailable'); } } as any,
    skillManager: skills as any, toolManager: new ToolManager(root),
  }, 'pet');
  const result = await session.handleMessage('看看结果', { surface: 'pet' });
  assert.equal(result.failed, true);
  assert.equal(journal.list(parent)[0].resultNotice?.handledAt, undefined);
}));

test('user steering reaches the running main before its final response without a competing loop', () => scoped(async root => {
  const started = deferred(), answer = deferred<any>();
  const requests: Message[][] = [];
  let active = 0, maxActive = 0;
  const ai = { chatStream: async (messages: Message[]) => {
    active++; maxActive = Math.max(maxActive, active);
    requests.push(structuredClone(messages));
    try {
      if (requests.length === 1) { started.resolve(); return await answer.promise; }
      return { content: '' };
    } finally { active--; }
  } };
  const session = new AgentSession(randomUUID(), { aiService: ai as any, skillManager: skills as any, toolManager: new ToolManager(root) }, 'pet');
  const run = session.handleMessage('帮我查天气', { surface: 'pet' });
  await started.promise;
  const steered = session.steer('只看北京明天');
  assert.ok(steered);
  answer.resolve({ content: '旧回答' });
  await run;
  assert.equal(await steered, true);
  assert.equal(maxActive, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].some(message => message.content === '只看北京明天'));
  assert.equal(session.steer('idle'), undefined);
}));

test('main can steer its running child, another parent cannot, and final children reject input', () => scoped(async root => {
  const manager = SubAgentManager.getInstance(), parent = randomUUID(), started = deferred(), answer = deferred<any>(), done = deferred();
  const requests: Message[][] = [];
  const route = { injectMessage: async () => { done.resolve(); } };
  manager.registerPlatformCallbacks(parent, route, root);
  const spawned = manager.spawn(parent, undefined, '查天气', '查询', root, { chatStream: async (messages: Message[], tools: any[]) => {
    assert.ok(!tools.some(tool => tool.name === 'steer_subagent'));
    requests.push(structuredClone(messages));
    if (requests.length === 1) { started.resolve(); return answer.promise; }
    return { content: '北京明天晴' };
  } } as any, skills as any);
  assert.ok(!('error' in spawned)); if ('error' in spawned) return;
  await started.promise;
  assert.equal(manager.steerForParent('other', spawned.id, '覆盖任务'), 'forbidden');
  assert.equal(manager.steerForParent(parent, spawned.id, '改查北京明天'), 'accepted');
  answer.resolve({ content: '旧结果' });
  await done.promise;
  assert.ok(requests[1].some(message => message.content === '改查北京明天'));
  assert.equal(manager.steerForParent(parent, spawned.id, '继续'), 'not_running');
  manager.unregisterPlatformCallbacks(parent, route);
}));

test('a child reports accepted input that cannot reach another inference at its turn limit', () => scoped(async root => {
  const started = deferred(), answer = deferred<any>();
  const session = new SubAgentSession(randomUUID(), { chatStream: async () => {
    started.resolve(); return answer.promise;
  } } as any, skills as any, { taskDescription: 'bounded work', userMessage: 'do work', workingDirectory: root, maxTurns: 1 });
  const run = session.run();
  await started.promise;
  assert.equal(session.steer('新的要求'), true);
  answer.resolve({ content: '旧结果' });
  await run;
  assert.deepEqual(session.getInfo().undeliveredMessages, ['新的要求']);
}));

test('child retry keeps consumed steering and completed tool results instead of replaying the task', () => scoped(async root => {
  const manager = SubAgentManager.getInstance(), parent = randomUUID();
  const started = deferred(), answer = deferred<any>(), done = deferred();
  let calls = 0, questions = 0;
  const sessionClass = SubAgentSession as any, delay = sessionClass.SESSION_RETRY_BASE_DELAY_MS;
  sessionClass.SESSION_RETRY_BASE_DELAY_MS = 1;
  const route = { injectMessage: async (_text: string, notice: any) => {
    if (notice.question) { questions++; manager.resumeForParent(parent, notice.subagentId, '使用受限MVP'); }
    else done.resolve();
  } };
  manager.registerPlatformCallbacks(parent, route, root);
  try {
    const spawned = manager.spawn(parent, undefined, '审查预算', '原预算1000', root, { chatStream: async (messages: Message[]) => {
      calls++;
      if (calls === 1) return { toolCalls: [{ id: 'ask-once', type: 'function', function: { name: 'ask_parent', arguments: JSON.stringify({ question: '产品范围？' }) } }] };
      if (calls === 2) { started.resolve(); return answer.promise; }
      assert.ok(messages.some(message => message.content === '预算改为300'));
      assert.equal(messages.filter(message => message.role === 'tool' && message.tool_call_id === 'ask-once').length, 1);
      assert.equal(messages.filter(message => message.content === '原预算1000').length, 1);
      if (calls === 3) throw new Error('500 retryable provider error');
      return { content: '最终预算300' };
    } } as any, skills as any);
    assert.ok(!('error' in spawned)); if ('error' in spawned) return;
    await started.promise;
    assert.equal(manager.steerForParent(parent, spawned.id, '预算改为300'), 'accepted');
    answer.resolve({ content: '旧草稿1000' });
    await done.promise;
    assert.equal(calls, 4);
    assert.equal(questions, 1);
    assert.equal(manager.listByParent(parent, root)[0].resultSummary, '最终预算300');
  } finally { sessionClass.SESSION_RETRY_BASE_DELAY_MS = delay; manager.unregisterPlatformCallbacks(parent, route); }
}));

test('queued questions become stale when the Main has already answered them', () => scoped(async root => {
  const manager = SubAgentManager.getInstance(), parent = randomUUID(), asked = deferred<any>(), release = deferred(), done = deferred();
  let request = 0;
  const route = { injectMessage: async (_text: string, notice: any) => {
    if (notice?.question) { asked.resolve(notice); await release.promise; }
    else done.resolve();
  } };
  manager.registerPlatformCallbacks(parent, route, root);
  const spawned = manager.spawn(parent, undefined, '查天气', '查询', root, { chatStream: async () => ++request === 1
    ? { toolCalls: [{ id: 'ask', type: 'function', function: { name: 'ask_parent', arguments: JSON.stringify({ question: '今天还是明天？' }) } }] }
    : { content: '已查明天' } } as any, skills as any);
  assert.ok(!('error' in spawned)); if ('error' in spawned) return;
  const notice = await asked.promise;
  assert.equal(manager.shouldHandleFeedback(parent, notice), true);
  assert.equal(manager.resumeForParent(parent, spawned.id, '明天'), 'resumed');
  assert.equal(manager.shouldHandleFeedback(parent, notice), false);
  release.resolve(); await done.promise;
  manager.unregisterPlatformCallbacks(parent, route);
}));
