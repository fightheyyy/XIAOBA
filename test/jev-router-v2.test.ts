import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { JevAdapter, buildRouteCandidates, buildJevQuestions, decodeJevDecision, JevRoutingInput, TaskAction } from '../src/runtime/harness/models/jev-router';
import { executeJevAction } from '../src/runtime/subagents/jev-actions';
import { SubAgentManager } from '../src/runtime/subagents/sub-agent-manager';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { createRoleAwareToolManager } from '../src/capabilities/tools/create-tool-manager';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';
import { Logger } from '../src/runtime/observability/logger';

const repo = process.cwd();
const root = path.join(repo, 'output/test/jev-v2/unit-' + randomUUID());
const savedAppRoot = process.env.XIAOBA_APP_ROOT;
const savedJevKey = process.env.XIAOBA_JEV_API_KEY;
const usage = { promptTokens: 11, completionTokens: 3, totalTokens: 14 };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
async function until(predicate: () => boolean) {
  const end = Date.now() + 4000;
  while (!predicate() && Date.now() < end) await delay(5);
  assert.ok(predicate(), 'Timed out waiting for runtime state');
}
before(() => { fs.mkdirSync(root, { recursive: true }); process.env.XIAOBA_APP_ROOT = repo; delete process.env.XIAOBA_JEV_API_KEY; process.chdir(root); Logger.setSilentMode(true); });
after(() => { process.chdir(repo); Logger.setSilentMode(false); if (savedAppRoot === undefined) delete process.env.XIAOBA_APP_ROOT; else process.env.XIAOBA_APP_ROOT = savedAppRoot; if (savedJevKey === undefined) delete process.env.XIAOBA_JEV_API_KEY; else process.env.XIAOBA_JEV_API_KEY = savedJevKey; });

const routingInput = (): JevRoutingInput => ({ message: '执行任务', history: [], tasks: [], roles: [
  { name: 'engineer-cat', description: '代码与测试' }, { name: 'browser-cat', description: '浏览器调研' }, { name: 'reviewer-cat', description: '验收' },
] });

test('finite candidate space bounds plans, keeps IDs atomic, and only offers state-valid actions', () => {
  const input = routingInput();
  input.tasks = [
    { id: 'run', status: 'running', taskDescription: '代码' },
    { id: 'wait', status: 'waiting_for_input', taskDescription: '调研', pendingQuestion: '确认？', pendingQuestionId: 'q1' },
    { id: 'done', status: 'completed', taskDescription: '完成' },
  ] as any;
  const candidates = buildRouteCandidates(input);
  assert.ok(candidates.has('stop:run') && candidates.has('steer:run'));
  assert.ok(candidates.has('resume:wait') && !candidates.has('steer:wait'));
  assert.ok(!candidates.has('stop:done') && !candidates.has('resume:run'));
  assert.ok(candidates.has('spawn:sequential:engineer-cat,browser-cat,reviewer-cat'));
  for (const { decision } of candidates.values()) if (decision.action === 'spawn') {
    assert.ok(decision.roles.length <= 3 && new Set(decision.roles).size === decision.roles.length);
  }
});

test('eight-role plans fit provider limits and inconsistent independent stages clarify instead of executing', () => {
  const input = routingInput(); input.roles = Array.from({ length: 8 }, (_, i) => ({ name: 'role-' + i, description: '角色' + i }));
  const candidates = buildRouteCandidates(input), questions = buildJevQuestions(input, candidates);
  assert.ok(candidates.size > 255);
  assert.ok(Object.values(questions).every(question => Object.keys(question.criteria).length <= 255));
  const answer = (stages: string[]) => ({ answers: { action: { choice: 'spawn:sequential' }, ...Object.fromEntries(stages.map((choice, i) => ['stage_' + (i + 1), { choice }])) } });
  assert.deepEqual(decodeJevDecision(answer(['role-0', 'role-1', 'none']), candidates, questions), { action: 'spawn', roles: ['role-0', 'role-1'], mode: 'sequential' });
  assert.deepEqual(decodeJevDecision(answer(['role-0', 'role-0', 'none']), candidates, questions), { action: 'clarify' });
  assert.deepEqual(decodeJevDecision(answer(['role-0', 'none', 'role-1']), candidates, questions), { action: 'clarify' });
  assert.throws(() => decodeJevDecision(answer(['foreign', 'role-1', 'none']), candidates, questions), /JEV_INVALID_RESPONSE/);
});

async function serverTest(handler: http.RequestListener, run: (url: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as any).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('Jev validates returned candidates and allows at most three extra attempts', async () => {
  let calls = 0;
  await serverTest((_req, res) => { calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ answers: { action: { choice: calls < 4 ? 'foreign-task' : 'none' } }, usage: { input_tokens: 2, output_tokens: 1 } })); }, async url => {
    const attempts: any[] = [], input = routingInput();
    const result = await new JevAdapter({ apiKey: 'test', apiUrl: url, retries: 3, timeoutMs: 1000 })
      .route(input, buildRouteCandidates(input), new AbortController().signal, a => attempts.push(a));
    assert.deepEqual(result, { action: 'none' }); assert.equal(calls, 4);
    assert.equal(attempts.reduce((n, a) => n + a.input_tokens + a.output_tokens, 0), 12);
    assert.equal(attempts[0].error_code, 'JEV_INVALID_RESPONSE');
  });
});

test('one total deadline includes all retry time and cancellation is not a fallback decision', async () => {
  await serverTest(() => {}, async url => {
    const input = routingInput(), started = Date.now();
    await assert.rejects(new JevAdapter({ apiKey: 'test', apiUrl: url, timeoutMs: 60, retries: 3 })
      .route(input, buildRouteCandidates(input), new AbortController().signal, () => {}), /JEV_TIMEOUT/);
    assert.ok(Date.now() - started < 500);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(new JevAdapter({ apiKey: 'test', apiUrl: url }).route(input, buildRouteCandidates(input), abort.signal, () => {}), { name: 'AbortError' });
  });
});

test('429 Retry-After is respected instead of hammering an unavailable provider', async () => {
  let calls = 0;
  await serverTest((_req, response) => { calls++; response.writeHead(429, { 'Retry-After': '60' }); response.end('{}'); }, async url => {
    const input = routingInput();
    await assert.rejects(new JevAdapter({ apiKey: 'test', apiUrl: url, retries: 3 }).route(input, buildRouteCandidates(input), new AbortController().signal, () => {}), /JEV_HTTP_429/);
    assert.equal(calls, 1);
  });
});

test('oversized role catalogs fail before combinatorial enumeration', () => {
  const input = routingInput(); input.roles = Array.from({ length: 1000 }, (_, i) => ({ name: 'role-' + i, description: '' }));
  assert.throws(() => buildRouteCandidates(input), /JEV_CANDIDATE_LIMIT/);
});

function mainSession(router: any, respond?: (index: number, messages: any[], tools: any[]) => any) {
  const requests: any[] = [], delivered: string[] = [];
  const key = 'pet:jev-unit:' + randomUUID();
  const manager = createRoleAwareToolManager(root, {}, 'base');
  const chat = async (messages: any[], tools: any[]) => {
    requests.push({ messages: structuredClone(messages), names: tools.map(t => t.name) });
    return respond?.(requests.length, messages, tools) ?? (requests.length === 1 ? {
      content: null, toolCalls: [{ id: 'send-' + key, type: 'function', function: { name: 'send_text', arguments: JSON.stringify({ text: '我来处理' }) } }], usage,
    } : { content: '', usage });
  };
  const session = new AgentSession(key, { aiService: { chat, chatStream: chat } as any, toolManager: manager, skillManager: new SkillManager('base'), roleName: 'base', jevRouter: router }, 'pet');
  const options: any = { surface: 'pet', channel: { chatId: key, reply: async (_id: string, text: string) => { delivered.push(text); }, sendFile: async () => {} } };
  return { session, options, requests, delivered, key, manager };
}

test('Main delivers before Jev resolves, hides all five tools, and duplicate admission is ignored', async () => {
  const gate = deferred<TaskAction>(); let routeCalls = 0;
  const t = mainSession({ route: async () => { routeCalls++; return gate.promise; } });
  const pending = t.session.handleMessage('你好', { ...t.options, traceId: 'unique-admission' });
  await until(() => t.delivered.length > 0);
  assert.equal(t.session.isBusy(), true);
  assert.equal(t.session.steer('再执行另一个任务'), undefined);
  assert.ok(!t.requests[0].names.some((name: string) => /^(spawn|check|stop|steer|resume)_subagent$/.test(name)));
  assert.ok(t.requests[0].messages.some((message: any) => message.role === 'system' && String(message.content).includes('本轮用户输入已由 Runtime 接收')));
  gate.resolve({ action: 'none' }); await pending;
  await t.session.handleMessage('你好', { ...t.options, traceId: 'unique-admission' });
  assert.equal(routeCalls, 1); assert.equal(t.delivered.length, 1);
  await t.session.handleMessage('内部结果', { ...t.options, internal: true });
  assert.equal(routeCalls, 1);
});

test('technical failure restores original prompt and tools without replaying the user message', async () => {
  const gate = deferred<void>();
  const t = mainSession({ route: async () => { await gate.promise; throw new Error('JEV_NETWORK_ERROR'); } });
  const pending = t.session.handleMessage('查询任务', t.options);
  await until(() => t.delivered.length > 0); gate.resolve(); await pending;
  assert.ok(t.requests.at(-1).names.includes('spawn_subagent'));
  assert.match(t.requests.at(-1).messages[0].content, /Base 分工路由/);
  assert.equal(t.requests.at(-1).messages.filter((m: any) => m.role === 'user' && !m.__injected && m.content === '查询任务').length, 1);
  assert.deepEqual(t.delivered, ['我来处理']);
});

test('cancelled or superseded admission cannot act on a late Jev result', async () => {
  const gate = deferred<TaskAction>();
  const t = mainSession({ route: async () => gate.promise });
  const pending = t.session.handleMessage('执行任务', t.options);
  await until(() => t.delivered.length > 0);
  t.session.requestInterrupt(); gate.resolve({ action: 'spawn', roles: ['engineer-cat'], mode: 'parallel' });
  await pending;
  assert.equal(SubAgentManager.getInstance().listByParent(t.key, root).length, 0);
});

test('Main provider failure cancels only pending Jev and remains a provider error, not user cancellation', async () => {
  const t = mainSession({ route: async (_input: any, _candidates: any, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled route'), { name: 'AbortError' })), { once: true });
  }) }, () => { throw Object.assign(new Error('provider failed'), { status: 500, provider: 'openai' }); });
  const result = await t.session.handleMessage('执行任务', t.options);
  assert.equal(result.finalResponseVisible, true);
  const file = (t.session as any).sessionTurnLogger.getTraceFilePath();
  const traces = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const events = traces.flatMap(trace => trace.events || []);
  assert.ok(events.some(event => event.event_type === 'provider_error'));
  assert.ok(!events.some(event => event.event_type === 'session_cancelled'));
});

function actionFixture(childResponse: (role: string, index: number, messages: any[]) => Promise<any> | any) {
  const key = 'pet:jev-actions:' + randomUUID(), children = SubAgentManager.getInstance();
  const starts: string[] = [], results: any[] = [], notices: any[] = [];
  children.registerPlatformCallbacks(key, { injectMessage: async (_text, notice) => { notices.push(notice); } }, root);
  const manager = createRoleAwareToolManager(root, { subAgentServiceFactory: ({ roleName }) => {
    const role = roleName!; starts.push(role); let index = 0;
    const chat = async (messages: any[]) => childResponse(role, ++index, messages);
    return { aiService: { chat, chatStream: chat }, skillManager: new SkillManager(role) };
  } }, 'base');
  const committed = new Set<string>();
  const context: any = { sessionId: key, roleName: 'base', surface: 'pet', workingDirectory: root, conversationHistory: [], subagentRouting: 'jev' };
  const act = async (decision: TaskAction, id = randomUUID(), message = '用户要求') => executeJevAction({ decision, turnId: id, message, history: [], manager, context,
    committed, isCurrent: () => true, onAction: (call, result) => results.push({ call, result }) });
  return { key, children, starts, results, notices, manager, context, act };
}

test('real Manager supports finite parallel/sequential continuations and action IDs are idempotent', async () => {
  const parallel = actionFixture(async () => ({ content: '结果', usage }));
  await parallel.act({ action: 'spawn', roles: ['engineer-cat', 'browser-cat'], mode: 'parallel' }, 'same-turn');
  await parallel.act({ action: 'spawn', roles: ['engineer-cat', 'browser-cat'], mode: 'parallel' }, 'same-turn');
  assert.equal(parallel.starts.length, 2);
  await until(() => parallel.children.listByParent(parallel.key, root).every(t => t.status === 'completed'));
  const sequence = actionFixture(async (_role, _i, messages) => {
    if (sequence.starts.length > 1) assert.match(JSON.stringify(messages), /前一阶段结果/);
    return { content: '前阶段真实循环结果', usage };
  });
  await sequence.act({ action: 'spawn', roles: ['engineer-cat', 'browser-cat', 'reviewer-cat'], mode: 'sequential' });
  await until(() => sequence.starts.length === 3 && sequence.children.listByParent(sequence.key, root).every(t => t.status === 'completed'));
  assert.deepEqual(sequence.starts, ['engineer-cat', 'browser-cat', 'reviewer-cat']);
});

test('completion remains coalesced while a finite next stage is still being admitted', async () => {
  const key = 'pet:continuation-gap:' + randomUUID(), manager = SubAgentManager.getInstance(), gate = deferred<void>();
  let notifications = 0;
  manager.registerPlatformCallbacks(key, { injectMessage: async () => { notifications++; } }, root);
  const chat = async () => ({ content: '第一阶段结束', usage });
  const child = manager.spawn(key, undefined, '阶段一', '只分析', root, { chat, chatStream: chat } as any, new SkillManager('engineer-cat'), {
    roleName: 'engineer-cat', onFinished: async () => gate.promise,
  });
  assert.ok(!('error' in child));
  await until(() => manager.getInfo(child.id)?.continuationPending === true);
  manager.retryPendingResults(key, root); await delay(5);
  assert.equal(notifications, 0);
  gate.resolve(); await until(() => notifications === 1);
  assert.ok(!manager.getInfo(child.id)?.continuationPending);
  manager.unregisterPlatformCallbacks(key);
});

function questionReply(index: number, confirmation: boolean) {
  return index === 1 ? { content: null, toolCalls: [{ id: randomUUID(), type: 'function', function: { name: 'ask_parent', arguments: JSON.stringify({ question: '需要哪个文件？', requires_user_confirmation: confirmation }) } }], usage }
    : { content: '收到回答，执行结束', usage };
}

test('question bridge consumes exactly once; user resume and Main answer share the same question identity', async () => {
  const t = actionFixture(async (_role, i) => questionReply(i, false));
  await t.act({ action: 'spawn', roles: ['engineer-cat'], mode: 'parallel' });
  await until(() => t.children.listByParent(t.key, root)[0]?.status === 'waiting_for_input');
  const child = t.children.listByParent(t.key, root)[0];
  assert.ok(t.manager.getToolDefinitions(t.context).some(tool => tool.name === 'answer_child_question'));
  const answer = await t.manager.executeTool({ id: 'answer', type: 'function', function: { name: 'answer_child_question', arguments: JSON.stringify({ question_id: child.pendingQuestionId, answer: 'input.txt' }) } }, [], t.context);
  assert.equal(answer.status, 'success');
  await t.act({ action: 'resume', taskId: child.id, questionId: child.pendingQuestionId }, randomUUID(), '另一个答案');
  assert.equal(t.results.at(-1).result.error_code, 'QUESTION_NOT_PENDING');
  await until(() => t.children.getInfo(child.id)?.status === 'completed');
  assert.ok(!t.manager.getToolDefinitions(t.context).some(tool => tool.name === 'answer_child_question'));
});

test('confirmation questions cannot be self-approved; cross-parent control is rejected; stop halts a sequence', async () => {
  const t = actionFixture(async (_role, i) => questionReply(i, true));
  await t.act({ action: 'spawn', roles: ['engineer-cat', 'browser-cat'], mode: 'sequential' });
  await until(() => t.children.listByParent(t.key, root)[0]?.status === 'waiting_for_input');
  const child = t.children.listByParent(t.key, root)[0];
  assert.equal(t.children.answerQuestionForParent(t.key, child.pendingQuestionId!, '确认删除', root), 'user_confirmation_required');
  assert.equal(t.children.resumeForParent('other-parent', child.id, 'yes', child.pendingQuestionId), 'forbidden');
  const hidden = await t.manager.executeTool({ id: 'hidden', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({ subagent_id: child.id, subagentRouting: 'legacy' }) } }, [], t.context);
  assert.equal(hidden.status, 'blocked');
  await t.act({ action: 'check', taskId: child.id }); assert.equal(t.results.at(-1).result.status, 'success');
  await t.act({ action: 'stop', taskId: child.id });
  await until(() => t.children.getInfo(child.id)?.status === 'stopped');
  assert.deepEqual(t.starts, ['engineer-cat']);
});

test('user resume uses current question ID and steer accepts original text only for a running task', async () => {
  const waiting = actionFixture(async (_role, i) => questionReply(i, true));
  await waiting.act({ action: 'spawn', roles: ['engineer-cat'], mode: 'parallel' });
  await until(() => waiting.children.listByParent(waiting.key, root)[0]?.status === 'waiting_for_input');
  const child = waiting.children.listByParent(waiting.key, root)[0];
  await waiting.act({ action: 'resume', taskId: child.id, questionId: child.pendingQuestionId }, randomUUID(), '用户明确回答');
  assert.equal(waiting.results.at(-1).result.status, 'success');
  await until(() => waiting.children.getInfo(child.id)?.status === 'completed');
  const gate = deferred<void>(); const running = actionFixture(async () => { await gate.promise; return { content: '完成', usage }; });
  await running.act({ action: 'spawn', roles: ['engineer-cat'], mode: 'parallel' });
  const active = running.children.listByParent(running.key, root)[0];
  await running.act({ action: 'steer', taskId: active.id }, randomUUID(), '只读，不修改');
  assert.equal(running.results.at(-1).result.status, 'success'); gate.resolve();
  await until(() => running.children.getInfo(active.id)?.status === 'completed');
});

test('normal and Legacy prompts keep non-routing capabilities while switching SubAgent responsibility', () => {
  const normal = PromptManager.getBaseSystemPrompt('base', 'jev');
  const legacy = PromptManager.getBaseSystemPrompt('base', 'legacy');
  assert.match(normal, /answer_child_question/); assert.doesNotMatch(normal, /Base 分工路由/);
  assert.match(legacy, /Base 分工路由/); assert.match(legacy, /resume_subagent/);
  for (const prompt of [normal, legacy]) { assert.match(prompt, /schedule_reminder/); assert.match(prompt, /connector_describe/); }
});
