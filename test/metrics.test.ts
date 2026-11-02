import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Observability, resetObservabilityForTests } from '../src/runtime/observability';
import { Metrics } from '../src/runtime/observability/metrics';
import { AgentSession } from '../src/runtime/sessions/agent-session';
import { SubAgentSession } from '../src/runtime/subagents/sub-agent-session';
import { ContextCompressor } from '../src/runtime/harness/context/context-compressor';
import { ConversationRunner } from '../src/runtime/harness/loop/conversation-runner';
import type { AIService } from '../src/runtime/harness/models/ai-service';
import type { AgentServices } from '../src/runtime/sessions/agent-session';
import type { SkillManager } from '../src/capabilities/skills/skill-manager';
import type { Message } from '../src/runtime/contracts';
import type { ToolExecutor } from '../src/runtime/contracts/tool';

const usage = (promptTokens: number, completionTokens: number) => ({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
const skills = {
  loadSkills: async () => {}, getAllSkills: () => [], getUserInvocableSkills: () => [],
  getSkill: () => undefined, findAutoInvocableSkillByText: () => undefined,
} as unknown as SkillManager;
const tools: ToolExecutor = {
  getToolDefinitions: () => [{ name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }],
  executeTool: async call => ({ role: 'tool', tool_call_id: call.id, name: 'probe', content: 'done', status: 'success', ok: true }),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('Metrics owns snapshots and counts tool names that collide with Object.prototype', () => {
  const first = new Metrics(), second = new Metrics(), tokens = usage(10, 2);
  first.recordAICall('test', tokens);
  tokens.promptTokens = 999;
  for (const name of ['constructor', '__proto__']) first.recordToolCall(name, 5);
  const summary = first.getSummary();
  assert.equal(summary.totalPromptTokens, 10);
  assert.equal(summary.toolDurationMs, 10);
  assert.deepEqual(summary.toolBreakdown.constructor, { count: 1, totalMs: 5 });
  assert.deepEqual(summary.toolBreakdown.__proto__, { count: 1, totalMs: 5 });
  second.recordAICall('other', usage(20, 3));
  second.recordAICall('usage omitted');
  assert.equal(second.getSummary().aiCalls, 2);
  first.reset();
  assert.equal(second.getSummary().totalTokens, 23);
  assert.equal(first.getSummary().totalTokens, 0);
});

test('concurrent main requests and a child keep separate trace tokens and tool counts', async () => {
  const cwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-metrics-'));
  const entered = deferred(), release = deferred();
  let runA: Promise<unknown> | undefined;
  const observability = Observability.fromEnv({});
  resetObservabilityForTests(observability);
  try {
    process.chdir(root);
    let calls = 0;
    const aiA = { async chatStream() {
      calls++;
      if (calls === 1) return { content: null, usage: usage(10, 1), toolCalls: [{ id: 'probe-1', type: 'function', function: { name: 'probe', arguments: '{}' } }] };
      if (calls === 2) { entered.resolve(); await release.promise; return { content: 'A done', usage: usage(20, 2) }; }
      return { content: 'A next request', usage: usage(7, 1) };
    } } as unknown as AIService;
    const services = (aiService: AIService): AgentServices => ({ aiService, skillManager: skills, roleName: 'base',
      toolManager: { ...tools, getWorkingDirectory: () => root } as unknown as AgentServices['toolManager'] });
    const a = new AgentSession('metrics-a', services(aiA), 'chat');
    const b = new AgentSession('metrics-b', services({ chatStream: async () => ({ content: 'B done', usage: usage(100, 3) }) } as unknown as AIService), 'chat');
    runA = a.handleMessage('A request');
    await Promise.race([entered.promise, runA.then(() => { throw new Error('Main request ended before the interleaving boundary'); })]);
    assert.ok(!(await b.handleMessage('B request')).failed);
    const child = new SubAgentSession('metrics-child', { chatStream: async () => ({ content: 'child done', usage: usage(1000, 4) }) } as unknown as AIService,
      skills, { roleName: 'base', taskDescription: 'child', userMessage: 'child request', workingDirectory: root, parentSessionId: a.key });
    await child.run();
    assert.equal(child.status, 'completed');
    const childTokens = observability.getLocalSummary().recent.filter(event => event.name === 'xiaoba.tokens.total'
      && event.attributes['xiaoba.session.id_hash'] === observability.sessionIdHash('subagent:metrics-child'));
    assert.equal(childTokens.length, 1);
    assert.equal(childTokens[0].value, 1004);
    release.resolve();
    await runA;
    assert.ok(!(await a.handleMessage('A next request')).failed);
    const entries = fs.readdirSync(path.join(root, 'logs'), { recursive: true }).filter(file => String(file).endsWith('traces.jsonl'))
      .flatMap(file => fs.readFileSync(path.join(root, 'logs', String(file)), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    const row = (input: string) => entries.find(entry => entry.user.text === input);
    assert.deepEqual(row('A request').tokens, { prompt: 30, completion: 3 });
    assert.deepEqual(row('B request').tokens, { prompt: 100, completion: 3 });
    assert.deepEqual(row('child request').tokens, { prompt: 1000, completion: 4 });
    assert.deepEqual(row('A next request').tokens, { prompt: 7, completion: 1 });
    assert.equal(row('A request').events.find((event: any) => event.event_type === 'session_completed').tool_call_count, 1);
    assert.equal(row('B request').events.find((event: any) => event.event_type === 'session_completed').tool_call_count, 0);
    const summary = observability.getLocalSummary();
    assert.equal(summary.totals.modelCalls, 5);
    assert.equal(summary.totals.toolCalls, 1);
  } finally {
    release.resolve();
    await runA;
    resetObservabilityForTests(undefined);
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compression and its runner share only their explicitly supplied collector', async () => {
  const metrics = new Metrics(), unrelated = new Metrics();
  const aiService = { chatStream: async () => ({ content: '<summary>retained context</summary>', usage: usage(100, 50) }) } as unknown as AIService;
  const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message ${index}` }));
  await new ContextCompressor(aiService, { metrics }).compact(messages);
  assert.equal(metrics.getSummary().aiCalls, 1);
  await new ConversationRunner(aiService, tools, { metrics, enableCompression: false }).run([{ role: 'user', content: 'continue' }]);
  assert.equal(metrics.getSummary().totalTokens, 300);
  assert.equal(unrelated.getSummary().aiCalls, 0);
});

test('failed children retain token usage from calls completed before the failure', async () => {
  const cwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-failed-metrics-'));
  const observability = Observability.fromEnv({});
  resetObservabilityForTests(observability);
  try {
    process.chdir(root);
    let calls = 0;
    const child = new SubAgentSession('metrics-failed-child', { async chatStream() {
      if (calls++ === 0) return { content: null, usage: usage(40, 5), toolCalls: [{ id: 'unknown-tool', type: 'function', function: { name: 'unknown', arguments: '{}' } }] };
      throw new Error('Invalid API credentials');
    } } as unknown as AIService, skills, { roleName: 'base', taskDescription: 'fail after a call', userMessage: 'child failure', workingDirectory: root });
    await child.run();
    assert.equal(child.status, 'failed');
    const file = fs.readdirSync(path.join(root, 'logs'), { recursive: true }).find(file => String(file).endsWith('traces.jsonl'))!;
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'logs', String(file)), 'utf8').trim());
    assert.deepEqual(entry.tokens, { prompt: 40, completion: 5 });
    assert.equal(entry.assistant.tool_calls.length, 1);
    assert.equal(entry.assistant.tool_calls[0].name, 'unknown');
    assert.equal(observability.getLocalSummary().totals.modelCalls, 2);
    assert.equal(observability.getLocalSummary().totals.toolCalls, 1);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
    resetObservabilityForTests(undefined);
  }
});

test('a response arriving during cancellation still records reported usage', async () => {
  const metrics = new Metrics(), controller = new AbortController();
  const aiService = { async chatStream() {
    controller.abort();
    return { content: 'late response', usage: usage(12, 3) };
  } } as unknown as AIService;
  const result = await new ConversationRunner(aiService, tools, {
    metrics, enableCompression: false, toolExecutionContext: { abortSignal: controller.signal },
  }).run([{ role: 'user', content: 'cancel this request' }]);
  assert.equal(result.cancelled, true);
  assert.equal(metrics.getSummary().aiCalls, 1);
  assert.equal(metrics.getSummary().totalTokens, 15);
});
