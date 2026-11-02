import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import axios from 'axios';
import { AIService } from '../src/runtime/harness/models/ai-service';
import { AgentServices } from '../src/runtime/sessions/agent-session';
import { MessageSessionManager } from '../src/runtime/sessions/message-session-manager';
import { ConfigManager } from '../src/runtime/config';
import { createRoleAwareToolManager } from '../src/capabilities/tools/create-tool-manager';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { SubAgentManager } from '../src/runtime/subagents/sub-agent-manager';
import { Logger } from '../src/runtime/observability/logger';
import { SessionTurnLogger } from '../src/runtime/observability/session-turn-logger';
import { shutdownObservability } from '../src/runtime/observability';

const MODEL = 'gpt-5.6-luna(low)';
const store = new AsyncLocalStorage<any>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type LiveCase = { case_id: string; group: string; user_message: string; expected_action: string; expected_roles: string[]; setup?: string; required_fragments: string[] };

export function liveSummary(rows: any[]) {
  const stats = (values: number[]) => {
    const v = [...values].sort((a, b) => a - b);
    return v.length ? { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, p50: v[Math.ceil(v.length * .5) - 1], p95: v[Math.ceil(v.length * .95) - 1] } : null;
  };
  return Object.fromEntries(['all', ...new Set(rows.map(r => r.group))].map(group => [group,
    Object.fromEntries(['A', 'B'].map(arm => {
      const r = rows.filter(row => row.arm === arm && (group === 'all' || row.group === group));
      return [arm, { n: r.length, visible: r.filter(x => x.visible_reply).length, action_correct: r.filter(x => x.action_correct).length,
        task_completed_hard_oracle: r.filter(x => x.task_completed).length, fallback: r.filter(x => x.fallback).length,
        route_decisions: r.filter(x => x.route_correct !== null).length, route_correct: r.filter(x => x.route_correct).length,
        main_tokens: stats(r.map(x => x.main_tokens)), jev_tokens: stats(r.map(x => x.jev_tokens)),
        main_plus_jev_tokens: stats(r.map(x => x.main_tokens + x.jev_tokens)), child_tokens: stats(r.map(x => x.child_tokens)),
        first_visible_ms: stats(r.flatMap(x => x.first_visible_ms === null ? [] : [x.first_visible_ms])),
        last_visible_ms: stats(r.flatMap(x => x.last_visible_ms === null ? [] : [x.last_visible_ms])),
      }];
    }))]));
}

export function summarizePublishedResults(document: any) {
  const rows = document.observations;
  assert.ok(Array.isArray(rows) && rows.length > 0, 'Published observations required');
  assert.equal(new Set(rows.map((row: any) => row.id)).size, rows.length, 'Duplicate observation ID');
  const pairs = new Map<string, any[]>();
  for (const row of rows) {
    const key = `${row.case_id}:${row.repeat}`;
    pairs.set(key, [...(pairs.get(key) || []), row]);
  }
  const eligible = [...pairs.values()].filter(pair => pair.length === 2 && new Set(pair.map(row => row.arm)).size === 2
    && pair.every(row => ['A', 'B'].includes(row.arm) && row.setup_valid && !row.expired && !row.error
      && !row.provider_error_count && row.usage_complete
      && row.calls.filter((call: any) => call.phase !== 'setup').every((call: any) => call.usage)
      && row.jev_attempts.every((attempt: any) => attempt.usage_reported)));
  assert.ok(eligible.length, 'No complete A/B pairs');
  const prices = document.pricing_snapshot.usd_per_million;
  const paired = Object.fromEntries(['A', 'B'].map(arm => {
    const selected = eligible.flat().filter(row => row.arm === arm);
    const totals = { main: 0, child: 0, existing_child_continuation: 0, jev_input: 0 };
    for (const row of selected) {
      for (const call of row.calls.filter((call: any) => call.phase !== 'setup')) {
        const raw = call.raw_usage || {}, usage = call.usage;
        const input = raw.prompt_tokens ?? usage.promptTokens, output = raw.completion_tokens ?? usage.completionTokens;
        const cached = raw.prompt_tokens_details?.cached_tokens ?? 0;
        assert.ok([input, output, cached].every(value => Number.isFinite(value) && value >= 0) && cached <= input, 'Invalid provider usage');
        const rates = prices.main_and_child;
        const cost = ((input - cached) * rates.input + cached * rates.cached_input + output * rates.output) / 1e6;
        totals[call.component === 'main' ? 'main' : 'child'] += cost;
        if (call.component === 'setup-child') totals.existing_child_continuation += cost;
      }
      totals.jev_input += row.jev_attempts.reduce((sum: number, attempt: any) => sum + attempt.input_tokens, 0);
    }
    const cost = Object.fromEntries(Object.entries(prices.jev_input_scenarios).map(([scenario, rate]) => {
      const factor = 1000 / selected.length, jev = totals.jev_input * Number(rate) / 1e6;
      return [scenario, { main: totals.main * factor, child: totals.child * factor,
        existing_child_continuation_included_in_child: totals.existing_child_continuation * factor,
        jev: jev * factor, main_plus_jev: (totals.main + jev) * factor, total: (totals.main + totals.child + jev) * factor }];
    }));
    const mean = (key: string) => selected.reduce((sum, row) => sum + row[key], 0) / selected.length;
    return [arm, { n: selected.length, mean_main_tokens: mean('main_tokens'), mean_jev_tokens: mean('jev_tokens'),
      mean_child_tokens: mean('child_tokens'), mean_main_plus_jev_tokens: mean('main_tokens') + mean('jev_tokens'), cost_per_1000_requests: cost }];
  }));
  return { primary: liveSummary(rows), paired, pricing_snapshot: document.pricing_snapshot,
    followup: liveSummary(document.followup?.observations || []) };
}

async function main() {
  assert.ok(ConfigManager.getConfig().jev?.apiKey, 'Set XIAOBA_JEV_API_KEY');
  for (const key of Object.keys(process.env)) if (key.startsWith('XIAOBA_LLM_BACKUP')) delete process.env[key];
  const repo = process.cwd(); process.env.XIAOBA_APP_ROOT = repo; process.env.CONTEXT_DEBUG = 'false';
  Logger.setSilentMode(true);
  const suite = JSON.parse(fs.readFileSync('eval/benchmarks/jev-v2/suite.json', 'utf8'));
  assert.ok(suite.cases.length >= 30 && suite.runs_per_case === 3 && !suite.mock_subagent_execution);
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('output/test/jev-v2', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(root, { recursive: true });
  const changed = [...execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim().split('\n'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n')];
  const sources = [...new Set([...changed.filter(name => name.startsWith('src/') || name.startsWith('prompts/')), 'scripts/run-jev-v2-live.ts'])];
  const hashes = Object.fromEntries(sources.map(name => [name, createHash('sha256').update(fs.readFileSync(name)).digest('hex')]));
  const manifest = path.join(root, 'manifest.json');
  if (fs.existsSync(manifest)) assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).source_hashes, hashes, 'Code changed; use a fresh run directory');
  else fs.writeFileSync(manifest, JSON.stringify({ suite, source_hashes: hashes, main_model: MODEL, jev: { model: ConfigManager.getConfig().jev?.model, timeout_ms: ConfigManager.getConfig().jev?.timeoutMs, retries: ConfigManager.getConfig().jev?.retries },
    methodology: 'Real Main, Jev, SubAgent models and tools. Isolated fixture files and captured channel transport. Existing MessageSessionManager queue. Setup tokens excluded. Running setup child first real provider response held until user turn ends for deterministic control admission. No fake child responses. Hard completion oracle is NOT independent semantic judgment. Case order AB/BA alternated, three worker sessions overlap and may share provider/cache load.' }, null, 2));
  for (const name of sources) {
    const snapshot = path.join(root, 'source-snapshot', name); fs.mkdirSync(path.dirname(snapshot), { recursive: true }); fs.copyFileSync(name, snapshot);
  }
  process.chdir(root);
  const interceptor = axios.interceptors.response.use(response => {
    const record = store.getStore();
    if (!record) return response;
    if (typeof response.data?.on !== 'function') { record.raw_usage = response.data?.usage; return response; }
    const decoder = new StringDecoder('utf8'); let pending = '';
    response.data.on('data', (chunk: Buffer) => {
      pending += decoder.write(chunk); const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
        try { const d = JSON.parse(line.slice(6)); if (d.usage) record.raw_usage = d.usage; } catch { /* non-JSON SSE event */ }
      }
    });
    return response;
  });
  const services = new Map<string, AgentServices>();
  const defaultManager = createRoleAwareToolManager(root, {}, 'base');
  const pool = new MessageSessionManager({ aiService: new AIService({ model: MODEL }), toolManager: defaultManager, skillManager: new SkillManager('base'), roleName: 'base' }, 'pet', 3600_000, key => services.get(key)!);
  const output = path.join(root, 'results.jsonl');
  const rows: any[] = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const children = SubAgentManager.getInstance();
  async function run(item: LiveCase, arm: 'A' | 'B', repeat: number) {
    const id = `${item.case_id}-${arm}-${repeat}`, key = `pet:jev-v2:${path.basename(root)}:${id}`;
    const workspace = path.join(root, id); fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'input.json'), '{"project":"PROJECT42","count":37}\n');
    fs.writeFileSync(path.join(workspace, 'sample.ts'), 'export function getId(user?: {id: string}) { return user.id; }\n');
    fs.writeFileSync(path.join(workspace, 'numbers.txt'), '10\n14\n12\n');
    fs.writeFileSync(path.join(workspace, 'trace.jsonl'), JSON.stringify({ schema_version: 3, entry_type: 'runtime_event', event_type: 'tool_error', stage: 'tool_execution', error_code: 'TOOL_TIMEOUT' }) + '\n');
    const calls: any[] = [], deliveries: any[] = [], toolFacts: any[] = [], feedback: Promise<void>[] = [];
    let phase = 'setup', start = performance.now(), expired = false, ready = false, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const measuredAI = (component: string, holdFirst = false) => {
      const ai = new AIService({ model: MODEL }); let index = 0;
      for (const name of ['chat', 'chatStream'] as const) {
        const original = ai[name].bind(ai) as (...args: any[]) => Promise<any>;
        (ai as any)[name] = async (...args: any[]) => {
          const record: any = { component, phase, start_ms: performance.now() - start, tools: args[1]?.map((t: any) => t.name) };
          calls.push(record);
          return store.run(record, async () => {
            try {
              const response = await original(...args);
              record.usage = response.usage; record.response = response;
              record.finish_ms = performance.now() - start;
              if (holdFirst && index++ === 0) await held;
              return response;
            } catch (error: any) { record.error = error.code || 'PROVIDER_ERROR'; record.status = error.status || error.response?.status; throw error; }
          });
        };
      }
      return ai;
    };
    const toolManager = createRoleAwareToolManager(workspace, { subAgentServiceFactory: ({ roleName }) => ({ aiService: measuredAI(`child:${roleName}`), skillManager: new SkillManager(roleName) }) }, 'base');
    services.set(key, { aiService: measuredAI('main'), toolManager, skillManager: new SkillManager('base'), roleName: 'base', ...(arm === 'A' ? { jevRouter: false as const } : {}) });
    const session = pool.getOrCreate(key, key);
    const options: any = { surface: 'pet', transientContext: `这是隔离工作区 ${workspace} 的真实执行验收。项目代号 PROJECT42。不要访问工作区外文件或操作真实应用账号；文件是测试输入，但工具和子任务执行都是真实的。只执行用户明确要求。`,
      channel: { chatId: key, reply: async (_id: string, text: string) => { deliveries.push({ kind: 'text', text, at_ms: performance.now() - start }); },
        sendFile: async (_id: string, file: string) => { assert.ok(fs.existsSync(file)); deliveries.push({ kind: 'file', path: file, at_ms: performance.now() - start }); } },
      callbacks: { onToolEnd: (name: string, _id: string, _text: string, facts: any) => toolFacts.push({ name, status: facts?.status, error_code: facts?.error_code }) },
    };
    children.registerPlatformCallbacks(key, { injectMessage: (text, notice) => {
      if (!ready || expired) return Promise.resolve();
      const task = pool.enqueueTurn(key, key, async current => {
        if (expired) return;
        if (notice && !children.shouldHandleFeedback(key, notice)) return;
        const result = await current.handleMessage(text, { ...options, internal: true });
        if (result.finalResponseVisible && result.text) await options.channel.reply(key, result.text);
      }); feedback.push(task); return task;
    } }, workspace);
    const fixtureIds: string[] = [];
    if (item.setup) {
      const count = item.setup === 'two_waiting' ? 2 : 1;
      for (let n = 0; n < count; n++) {
        const running = item.setup === 'running';
        const spawned = children.spawn(key, undefined, `已有验收任务 ${n + 1}`, running
          ? `使用原生 read_file 读取 ${path.join(workspace, 'input.json')}，汇报 count。不要访问其他目录。`
          : `先用 ask_parent 询问“请确认验收文件名”，requires_user_confirmation=true。必须等回答后才能用原生 read_file 读取 ${path.join(workspace, 'input.json')} 并汇报 count。`,
        workspace, measuredAI('setup-child', running), new SkillManager('engineer-cat'), { roleName: 'engineer-cat', parentSessionId: key });
        assert.ok(!('error' in spawned)); fixtureIds.push(spawned.id);
      }
      if (item.setup !== 'running') {
        const end = Date.now() + 45_000;
        while (Date.now() < end && fixtureIds.some(id => children.getInfo(id)?.status === 'running')) await delay(20);
      }
    }
    const setupValid = !item.setup || fixtureIds.every(id => children.getInfo(id)?.status === (item.setup === 'running' ? 'running' : 'waiting_for_input'));
    phase = 'request'; ready = true; start = performance.now();
    const timer = setTimeout(() => { expired = true; session.requestInterrupt(); for (const t of children.listByParent(key, workspace)) children.stopForParent(key, t.id); release(); }, 120_000);
    let error: string | null = null;
    try {
      if (!setupValid) throw new Error('SETUP_NOT_READY');
      await pool.enqueueTurn(key, key, async current => {
        const result = await current.handleMessage(item.user_message.replaceAll('{workspace}', workspace), { ...options, traceId: id });
        if (result.finalResponseVisible && result.text) await options.channel.reply(key, result.text);
      });
      release();
      while (!expired) {
        const tasks = children.listByParent(key, workspace);
        const pending = tasks.some(t => (t.continuationPending || ['running', 'waiting_for_input'].includes(t.status))
          && (!fixtureIds.includes(t.id) || ['resume', 'steer'].includes(item.expected_action)));
        if (!pending && !session.isBusy()) break;
        await delay(20);
      }
      await Promise.allSettled(feedback);
    } catch (e: any) { error = e.message === 'SETUP_NOT_READY' ? e.message : 'CASE_ERROR'; }
    clearTimeout(timer); release();
    const traceFile = (session as any).sessionTurnLogger.getTraceFilePath();
    const traces = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : [];
    const events = traces.flatMap(t => t.events || []), decision = events.find(e => e.event_type === 'jev_decision')?.decision;
    const acts = events.filter(e => e.event_type === 'jev_action');
    const native = [...toolFacts, ...acts.map(e => ({ name: e.tool, status: e.status, error_code: e.error_code }))];
    const current = children.listByParent(key, workspace), newTasks = current.filter(t => !fixtureIds.includes(t.id));
    const actualRoles = newTasks.map(t => t.roleName);
    const roleMatch = JSON.stringify([...actualRoles].sort()) === JSON.stringify([...item.expected_roles].sort());
    const userText = deliveries.filter(d => d.kind === 'text').map(d => d.text).join('\n');
    const executionEvidence = newTasks.map(task => {
      const file = new SessionTurnLogger('subagent', `subagent:${task.id}`).getTraceFilePath();
      const records = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
      return { task_id: task.id, successful_execution_tools: records.flatMap(t => t.assistant?.tool_calls || [])
        .filter(t => t.status === 'success' && !['skill', 'thinking', 'ask_parent'].includes(t.name)).map(t => t.name) };
    });
    const actionCorrect = ['none', 'clarify'].includes(item.expected_action)
      ? !native.some(t => /^(spawn|check|stop|steer|resume)_subagent$/.test(t.name)) && (item.expected_action !== 'clarify' || /[？?]|请.*提供|需要.*确认|哪个/.test(userText))
      : native.some(t => t.name === `${item.expected_action}_subagent` && t.status === 'success') && (item.expected_action !== 'spawn' || roleMatch);
    const providerErrors = events.filter(e => e.event_type === 'provider_error');
    const completed = !expired && !error && !providerErrors.length && setupValid && actionCorrect && deliveries.length > 0
      && item.required_fragments.every(fragment => userText.includes(fragment))
      && (item.expected_action !== 'spawn' || newTasks.length > 0 && newTasks.every(t => t.status === 'completed'))
      && (item.expected_action !== 'spawn' || executionEvidence.every(e => e.successful_execution_tools.length > 0))
      && (!item.user_message.includes('result.txt') || fs.existsSync(path.join(workspace, 'result.txt')) && fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8').includes('DONE42'));
    const used = calls.filter(c => c.phase !== 'setup');
    const tokens = (component: string) => used.filter(c => component === 'child' ? c.component !== 'main' : c.component === 'main').reduce((n, c) => n + (c.usage?.totalTokens || 0), 0);
    const row = { id, case_id: item.case_id, group: item.group, arm, repeat, setup_valid: setupValid, expired, error,
      provider_error_count: providerErrors.length, usage_complete: used.every(c => Boolean(c.usage)),
      route_correct: decision ? decision.action === item.expected_action && (decision.action !== 'spawn' || JSON.stringify([...decision.roles].sort()) === JSON.stringify([...item.expected_roles].sort())) : null,
      action_correct: actionCorrect, task_completed: completed, fallback: events.some(e => e.event_type === 'jev_fallback'), decision,
      first_visible_ms: deliveries[0]?.at_ms ?? null, last_visible_ms: deliveries.at(-1)?.at_ms ?? null, visible_reply: deliveries.length > 0,
      main_tokens: tokens('main'), child_tokens: tokens('child'), jev_tokens: events.filter(e => e.event_type === 'jev_attempt').reduce((n, e) => n + (e.input_tokens || 0) + (e.output_tokens || 0), 0),
      deliveries, calls, events, tasks: current, execution_evidence: executionEvidence, fixture_ids: fixtureIds, trace_file: path.relative(root, traceFile),
      oracle_scope: 'Finite action/state/output checks; task_completed is a hard oracle, not an independent semantic Judge.' };
    for (const t of current) children.stopForParent(key, t.id);
    children.unregisterPlatformCallbacks(key);
    await session.cleanup({ finalizeMemory: false });
    return row;
  }
  console.log(`Artifacts: ${root}`);
  const jobs: Array<{ item: LiveCase; arm: 'A' | 'B'; repeat: number }> = [];
  for (let repeat = 1; repeat <= 3; repeat++) for (const [index, item] of (suite.cases as LiveCase[]).entries()) {
    for (const arm of ((index + repeat) % 2 ? ['A', 'B'] : ['B', 'A']) as ('A' | 'B')[]) if (!rows.some(r => r.case_id === item.case_id && r.arm === arm && r.repeat === repeat)) jobs.push({ item, arm, repeat });
  }
  try {
    let cursor = 0, providerBlocked = false;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (cursor < jobs.length && !providerBlocked) {
        const job = jobs[cursor++];
        const row = await run(job.item, job.arm, job.repeat);
        if (row.events.some(event => event.event_type === 'provider_error' && event.error_code === 'MODEL_RATE_LIMIT')
          || row.calls.some(call => call.status === 429)) providerBlocked = true;
        rows.push(row); fs.appendFileSync(output, JSON.stringify(row) + '\n');
        fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(liveSummary(rows), null, 2));
        console.log(`${rows.length}/180 ${row.id} action=${row.action_correct} complete=${row.task_completed} fallback=${row.fallback} main=${row.main_tokens} jev=${row.jev_tokens} first=${row.first_visible_ms === null ? 'missing' : Math.round(row.first_visible_ms)}ms`);
      }
    }));
    if (providerBlocked) console.log('Paused new admissions after provider 429; verify live account quota versus cached proxy cooldown before continuing.');
  } finally { axios.interceptors.response.eject(interceptor); await pool.destroy(); await shutdownObservability(); }
}

if (require.main === module) {
  if (process.argv[2] === '--summarize') {
    console.log(JSON.stringify(summarizePublishedResults(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))), null, 2));
  } else main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
