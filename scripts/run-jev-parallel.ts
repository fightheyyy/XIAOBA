import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import axios from 'axios';
import { AIService } from '../src/runtime/harness/models/ai-service';
import { AgentSession, HandleMessageOptions } from '../src/runtime/sessions/agent-session';
import { createRoleAwareToolManager } from '../src/capabilities/tools/create-tool-manager';
import { ToolManager } from '../src/capabilities/tools/tool-manager';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';
import { SubAgentManager } from '../src/runtime/subagents/sub-agent-manager';
import { Logger } from '../src/runtime/observability/logger';
import { ConfigManager } from '../src/runtime/config';
import { buildCanonicalToolResult } from '../src/runtime/contracts/tool-result';

const MODEL = 'gpt-5.6-luna(low)';
const JEV_URL = 'https://opencode.ai/inference/systemone/v1/systemone';
const MOCK_MS = 500;
const deliveryTools = ['send_text', 'send_file'];
type Case = {
  case_id: string; group: string; user_message: string; setup: Record<string, unknown>;
  expected: { role: string | null; new_spawns: number };
  mock_subagent_result: unknown; required_result_fragments: string[];
};

export function decodeRoute(data: any, choices: string[]): string {
  const route = data?.answers?.route?.choice;
  assert.equal(typeof route, 'string', 'Jev must return a choice');
  assert.ok(choices.includes(route), 'Jev returned an unknown role');
  return route;
}

export function restrictMainTools(manager: ToolManager): void {
  const getDefinitions = manager.getToolDefinitions.bind(manager);
  const getVisibility = manager.getToolVisibilityInfo.bind(manager);
  const execute = manager.executeTool.bind(manager);
  manager.getToolDefinitions = context => getDefinitions(context).filter(t => deliveryTools.includes(t.name));
  manager.getToolVisibilityInfo = context => {
    const info = getVisibility(context);
    const visibleTools = info.visibleTools.filter(name => deliveryTools.includes(name));
    return { ...info, visibleTools, hiddenToolCount: info.hiddenToolCount + info.visibleTools.length - visibleTools.length };
  };
  manager.executeTool = async (call, history, context) => deliveryTools.includes(call.function.name)
    ? execute(call, history, context)
    : buildCanonicalToolResult({ tool_call_id: call.id, name: call.function.name, content: '实验 B Main 仅允许交付工具', status: 'blocked', errorCode: 'TOOL_FORBIDDEN' });
}

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? {
    n: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  } : null;
}

export function installTaskFixtures(manager: SubAgentManager, key: string, tasks: any[]) {
  const fixtures = tasks.map(task => ({ id: task.id, roleName: task.role, status: task.status,
    taskDescription: task.task ?? '已有后台任务', createdAt: Date.now() - 10_000, progressLog: [], outputFiles: [] }));
  const list = manager.listByParent.bind(manager), get = manager.getInfoForParent.bind(manager);
  manager.listByParent = (parent, root) => [...list(parent, root), ...(parent === key ? fixtures : [])];
  manager.getInfoForParent = (parent, id, root) => get(parent, id, root) ?? (parent === key ? fixtures.find(task => task.id === id) : undefined);
  return () => { manager.listByParent = list; manager.getInfoForParent = get; };
}

async function runArm(item: Case, arm: 'A' | 'B', root: string, criteria: Record<string, string>) {
  const workingDirectory = path.join(root, item.case_id, arm);
  fs.mkdirSync(workingDirectory, { recursive: true });
  const key = `pet:jev-experiment:${item.case_id}:${arm}:${path.basename(root)}`;
  const children = SubAgentManager.getInstance();
  const tasks = (item.setup.active_tasks ?? []) as any[];
  const removeFixtures = installTaskFixtures(children, key, tasks);
  const deliveries: any[] = [], calls: any[] = [], spawns: any[] = [], feedback: Promise<void>[] = [];
  const toolEvents: any[] = [], errors: string[] = [];
  let start = 0, initialDone!: () => void, childDone!: () => void;
  let phase = 'initial', rawUsage: any, jev: any = null, childCompletedMs: number | null = null;
  const initialFinished = new Promise<void>(resolve => { initialDone = resolve; });
  const childFinished = new Promise<void>(resolve => { childDone = resolve; });
  const elapsed = () => performance.now() - start;
  const mockCall = async () => {
    await new Promise(resolve => setTimeout(resolve, MOCK_MS));
    return { content: `[MOCK：实验固定结果，没有执行真实任务]\n${JSON.stringify(item.mock_subagent_result ?? { summary: '此题没有预设执行结果，路由错误。' })}`,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  };
  const manager = createRoleAwareToolManager(workingDirectory, {
    roleName: 'base', availableSkillNames: [],
    subAgentServiceFactory: async ({ roleName }) => ({
      aiService: { chat: mockCall, chatStream: mockCall }, skillManager: new SkillManager(roleName),
    }),
  }, 'base');
  const runtimeExecute = manager.executeTool.bind(manager);
  if (arm === 'B') restrictMainTools(manager);
  const config = ConfigManager.getConfig();
  assert.ok(config.apiUrl?.includes('127.0.0.1:8317'), 'Expected local CLIProxyAPI config');
  const ai = new AIService({ ...config, provider: 'openai', model: MODEL });
  // Capture raw SSE usage before the production adapter normalizes cache/reasoning fields away.
  const interceptor = axios.interceptors.response.use(response => {
    if (!response.config.url?.startsWith(config.apiUrl!)) return response;
    if (typeof response.data?.on === 'function') {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      response.data.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        const lines = pending.split('\n'); pending = lines.pop()!;
        for (const line of lines) if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
          try { const data = JSON.parse(line.slice(6)); if (data.usage) rawUsage = data.usage; } catch { /* incomplete/non-JSON event */ }
        }
      });
    } else rawUsage = response.data?.usage;
    return response;
  });
  for (const method of ['chat', 'chatStream'] as const) {
    const original = ai[method].bind(ai) as (...args: any[]) => Promise<any>;
    (ai as any)[method] = async (...args: any[]) => {
      const record: any = { phase, started_ms: elapsed(), tools: args[1]?.map((t: any) => t.name), messages: structuredClone(args[0]) };
      calls.push(record); rawUsage = undefined;
      const response = await original(...args);
      record.finished_ms = elapsed(); record.usage = rawUsage;
      record.response = response;
      assert.ok(rawUsage, 'Provider did not return actual token usage');
      return response;
    };
  }
  const session = new AgentSession(key, { aiService: ai, toolManager: manager, skillManager: new SkillManager('base'), roleName: 'base' }, 'pet');
  const commonContext = `这是受控实验。子任务的 MOCK 返回只代表固定实验结果，不能当成真实执行。\n当前可信上下文：${JSON.stringify(item.setup)}`;
  const parallelContext = '\n专业执行路由由 Runtime 并行处理，你不负责选择角色或派发。你只用 send_text/send_file 与用户交流，无需等待路由，可以先自然回应；没有实际执行状态时不能声称已经启动或完成。Runtime 会回注任务结果，再由你汇报。不要因为没有执行工具而拒绝任务或要求用户提供本题已给的材料。';
  const options: HandleMessageOptions = {
    surface: 'pet', transientContext: commonContext + (arm === 'B' ? parallelContext : ''),
    channel: {
      chatId: key,
      reply: async (_id, text) => { deliveries.push({ kind: 'text', text, phase, at_ms: elapsed() }); },
      sendFile: async () => { throw new Error('No case permits file delivery'); },
    },
    callbacks: {
      onToolStart: (name, id, input) => { toolEvents.push({ name, id, input, at_ms: elapsed() }); },
      onToolEnd: (name, id, _text, facts) => {
        toolEvents.push({ name, id, status: facts?.status, at_ms: elapsed() });
        if (name === 'spawn_subagent' && facts?.status === 'success') spawns.push({ source: 'main', at_ms: elapsed() });
      },
    },
  };
  children.registerPlatformCallbacks(key, {
    onStateChange: info => {
      if (info.status === 'completed' || info.status === 'failed') { childCompletedMs = elapsed(); childDone(); }
    },
    injectMessage: (text, notice) => {
      const task = (async () => {
        await initialFinished;
        await session.waitUntilIdle();
        if (notice && !children.shouldHandleFeedback(key, notice)) return;
        phase = 'feedback';
        const result = await session.handleMessage(text, { ...options, internal: true });
        if (result.text === '不好意思，刚才处理出了点问题，你再试一次？') throw new Error('Main feedback failed');
      })();
      feedback.push(task);
      return task;
    },
  }, workingDirectory);
  await session.init('pet');
  let routePromise: Promise<void> = Promise.resolve();
  start = performance.now();
  try {
    const main = session.handleMessage(item.user_message, options).finally(initialDone);
    if (arm === 'B') routePromise = (async () => {
      const request = {
        model: 'jev-1.13-free', state: JSON.stringify({ user_message: item.user_message, context: item.setup }),
        questions: { route: { type: 'choice',
          instructions: '只判断这条新用户消息是否需要一个专业执行角色。普通聊天、概念解释、讨论、总结已有材料、询问已知任务状态选 none。已有任务不因角色名被提及而重复派发。明确要求执行专业任务才选择对应角色。只能选一个。', criteria } },
      };
      const started = elapsed();
      const response = await fetch(JEV_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.XIAOBA_JEV_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json();
      jev = { started_ms: started, finished_ms: elapsed(), status: response.status, request, response: data };
      assert.equal(response.status, 200, 'Jev unavailable; no failover in this experiment');
      const route = decodeRoute(data, Object.keys(criteria)); jev.route = route;
      if (route !== 'none') {
        const call = { id: `jev-${item.case_id}`, type: 'function' as const, function: { name: 'spawn_subagent', arguments: JSON.stringify({
          role_name: route, task_description: item.user_message, user_message: item.user_message,
        }) } };
        const result = await runtimeExecute(call, [], { sessionId: key, surface: 'pet', permissionProfile: 'strict' });
        toolEvents.push({ source: 'jev', call, result, at_ms: elapsed() });
        assert.equal(result.status, 'success', 'Runtime Spawn failed');
        spawns.push({ source: 'jev', at_ms: elapsed() });
      }
    })();
    const outcomes = await Promise.allSettled([main, routePromise]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(String(outcome.reason?.message ?? 'request failed'));
    if (spawns.length) await Promise.race([childFinished, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Mock child did not finish')), 15_000); timer.unref();
    })]);
    // Completion records the journal before queuing the normal parent callback.
    await new Promise(resolve => setImmediate(resolve));
    await Promise.all(feedback);
  } catch (error: any) { errors.push(error.message); }
  finally {
    initialDone();
    axios.interceptors.response.eject(interceptor);
    children.unregisterPlatformCallbacks(key);
    removeFixtures();
  }
  const infos = children.listByParent(key, workingDirectory);
  const routes = infos.map(info => info.roleName ?? 'base');
  const expectedRoutes = item.expected.role ? [item.expected.role] : [];
  const text = deliveries.map(d => d.text).join('\n');
  const resultText = deliveries.filter(d => childCompletedMs !== null && d.at_ms >= childCompletedMs).map(d => d.text).join('\n');
  const tokens = calls.reduce((sum, c) => ({
    input: sum.input + (c.usage?.prompt_tokens ?? 0), output: sum.output + (c.usage?.completion_tokens ?? 0),
    cached: sum.cached + (c.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    reasoning: sum.reasoning + (c.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    total: sum.total + (c.usage?.total_tokens ?? 0),
  }), { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
  const jevTokens = (jev?.response?.usage?.input_tokens ?? 0) + (jev?.response?.usage?.output_tokens ?? 0);
  return {
    case_id: item.case_id, group: item.group, arm, expected_role: item.expected.role ?? 'none', routes,
    route_correct: JSON.stringify(routes) === JSON.stringify(expectedRoutes), errors,
    first_model_response_ms: calls[0]?.finished_ms ?? null,
    first_reply_ms: deliveries[0]?.at_ms ?? null, final_reply_ms: deliveries.at(-1)?.at_ms ?? null,
    settled_ms: elapsed(), child_completed_ms: childCompletedMs, main_tokens: tokens, jev_tokens: jevTokens, total_tokens: tokens.total + jevTokens,
    main_calls: calls.length, required_facts_present: item.required_result_fragments.every(fragment => resultText.includes(fragment)),
    visible_reply: Boolean(text), exact_duplicate_delivery: new Set(deliveries.map(d => d.text)).size !== deliveries.length,
    deliveries, spawns, child_states: infos, tool_events: toolEvents, calls, jev,
    semantic_review: 'pending manual review; fact fragments and exact duplicates are hard checks only',
  };
}

export function summarize(rows: any[]) {
  const arms = (selection: any[]) => Object.fromEntries(['A', 'B'].map(arm => {
    const items = selection.filter(r => r.arm === arm);
    return [arm, { n: items.length, route_correct: items.filter(r => r.route_correct).length,
      visible_reply: items.filter(r => r.visible_reply).length, required_facts_present: items.filter(r => r.required_facts_present).length,
      errors: items.filter(r => r.errors.length).length,
      first_model_response_ms: distribution(items.flatMap(r => r.calls[0]?.finished_ms === undefined ? [] : [r.calls[0].finished_ms])),
      first_reply_ms: distribution(items.flatMap(r => r.first_reply_ms === null ? [] : [r.first_reply_ms])),
      final_reply_ms: distribution(items.flatMap(r => r.final_reply_ms === null ? [] : [r.final_reply_ms])),
      main_tokens: distribution(items.map(r => r.main_tokens.total)), total_tokens: distribution(items.map(r => r.total_tokens)),
      main_calls: distribution(items.map(r => r.main_calls)),
    }];
  }));
  const ids = [...new Set(rows.map(r => r.case_id))];
  const successfulPairs = ids.flatMap(id => {
    const pair = rows.filter(r => r.case_id === id);
    return pair.length === 2 && pair.every(r => !r.errors.length && r.route_correct && r.visible_reply && r.required_facts_present && !r.exact_duplicate_delivery) ? pair : [];
  });
  return { all: arms(rows), none: arms(rows.filter(r => r.group === 'none')), delegate: arms(rows.filter(r => r.group === 'delegate')),
    hard_check_pairs: { semantic_review_included: false, case_ids: [...new Set(successfulPairs.map(r => r.case_id))], arms: arms(successfulPairs) } };
}

async function main() {
  assert.ok(process.env.XIAOBA_JEV_API_KEY, 'Set XIAOBA_JEV_API_KEY without writing it to the repository');
  for (const name of Object.keys(process.env)) if (name.startsWith('XIAOBA_LLM_BACKUP')) delete process.env[name];
  process.env.CONTEXT_DEBUG = 'false';
  Logger.setSilentMode(true);
  const repo = process.cwd();
  process.env.XIAOBA_APP_ROOT = repo;
  const suitePath = path.resolve('eval/benchmarks/jev-parallel/suite.json');
  const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  assert.equal(suite.rules.runs_per_case, 1);
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('output/test/jev-parallel', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(root, { recursive: true });
  const sourcePrompt = PromptManager.getBaseSystemPrompt('base');
  const criteria = { none: '无需新的专业执行；直接聊天、解释、讨论、总结已有结果或回复已知任务状态',
    ...Object.fromEntries([...sourcePrompt.matchAll(/^- (.+)：`([a-z-]+)`/gm)].map(m => [m[2], m[1]])) };
  assert.deepEqual(Object.keys(criteria).sort(), [...suite.rules.role_choices].sort());
  const manifestPath = path.join(root, 'manifest.json');
  const priorManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  if (priorManifest) { assert.equal(priorManifest.suite.suite_id, suite.suite_id); assert.equal(priorManifest.model, MODEL); }
  fs.writeFileSync(manifestPath, JSON.stringify({
    ...priorManifest,
    suite, model: MODEL, jev_url: JEV_URL, mock_ms: MOCK_MS, route_criteria: criteria,
    git_head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty_files: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim().split('\n'),
    script_sha256: createHash('sha256').update(fs.readFileSync(path.join(repo, 'scripts/run-jev-parallel.ts'))).digest('hex'),
    methodology: 'real AgentSession/ConversationRunner/ToolManager/Spawn; mock child AI only; Main never waits for Jev; fresh initialized pet sessions; alternating AB/BA; no retries of samples; no Jev failover; no production Runtime edits; identical base prompt plus B responsibility note',
  }, null, 2));
  // Keep session/journal/memory artifacts inside this run, away from user state.
  process.chdir(root);
  console.log(`Artifacts: ${root}`);
  const resultsPath = path.join(root, 'results.jsonl');
  const rows: any[] = fs.existsSync(resultsPath) ? fs.readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  assert.equal(new Set(rows.map(r => `${r.case_id}:${r.arm}`)).size, rows.length, 'Duplicate samples');
  for (const [index, item] of (suite.cases as Case[]).entries()) {
    for (const arm of (index % 2 === 0 ? ['A', 'B'] : ['B', 'A']) as ('A' | 'B')[]) {
      if (rows.some(row => row.case_id === item.case_id && row.arm === arm)) continue;
      const row = await runArm(item, arm, root, criteria);
      rows.push(row);
      fs.appendFileSync(path.join(root, 'results.jsonl'), JSON.stringify(row) + '\n');
      fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summarize(rows), null, 2));
      console.log(`${row.case_id} ${arm} route=${row.routes.join(',') || 'none'} correct=${row.route_correct} first=${row.first_reply_ms === null ? 'missing' : Math.round(row.first_reply_ms)+'ms'} final=${row.final_reply_ms === null ? 'missing' : Math.round(row.final_reply_ms)+'ms'} tokens=${row.main_tokens.total}+${row.jev_tokens} errors=${row.errors.length}`);
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
