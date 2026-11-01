import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { decodeRoute, distribution, installTaskFixtures, restrictMainTools, summarize } from '../scripts/run-jev-parallel';

test('Jev accepts one known choice and rejects malformed or unknown routes', () => {
  const choices = ['none', 'engineer-cat'];
  assert.equal(decodeRoute({ answers: { route: { choice: 'none' } } }, choices), 'none');
  assert.throws(() => decodeRoute({}, choices));
  assert.throws(() => decodeRoute({ answers: { route: { choice: ['engineer-cat'] } } }, choices));
  assert.throws(() => decodeRoute({ answers: { route: { choice: 'router-cat' } } }, choices));
});

test('B hides and blocks Main dispatch, without delaying delivery on any routing promise', async () => {
  const executed: string[] = [];
  const manager: any = {
    getToolDefinitions: () => ['spawn_subagent', 'send_text', 'send_file'].map(name => ({ name })),
    getToolVisibilityInfo: () => ({ visibleTools: ['spawn_subagent', 'send_text', 'send_file'], hiddenToolCount: 2 }),
    executeTool: async (call: any) => { executed.push(call.function.name); return { status: 'success' }; },
  };
  restrictMainTools(manager);
  assert.deepEqual(manager.getToolDefinitions().map((t: any) => t.name), ['send_text', 'send_file']);
  assert.equal(manager.getToolVisibilityInfo().hiddenToolCount, 3);
  assert.equal((await manager.executeTool({ id: 'blocked', function: { name: 'spawn_subagent' } })).status, 'blocked');
  assert.equal((await manager.executeTool({ id: 'sent', function: { name: 'send_text' } })).status, 'success');
  assert.deepEqual(executed, ['send_text']);
});

test('latency excludes missing deliveries and combined tokens include Jev', () => {
  assert.equal(distribution([]), null);
  assert.deepEqual(distribution([30, 10, 20]), { n: 3, mean: 20, p50: 20, p95: 30 });
  const summary: any = summarize([{ arm: 'B', group: 'none', route_correct: true, errors: [], visible_reply: false,
    required_facts_present: true, first_reply_ms: null, final_reply_ms: null, main_tokens: { total: 20 }, total_tokens: 27, main_calls: 1, calls: [] }]);
  assert.equal(summary.all.B.first_reply_ms, null);
  assert.equal(summary.all.B.total_tokens.mean, 27);
  assert.equal(summary.all.B.visible_reply, 0);
});

test('existing-task fixtures agree with Runtime list and ID queries and stay parent-scoped', () => {
  const manager: any = { listByParent: () => [], getInfoForParent: () => undefined };
  const restore = installTaskFixtures(manager, 'parent', [{ id: 'sub-known-842', role: 'engineer-cat', status: 'running' }]);
  assert.equal(manager.listByParent('parent')[0].id, 'sub-known-842');
  assert.equal(manager.getInfoForParent('parent', 'sub-known-842').status, 'running');
  assert.deepEqual(manager.listByParent('other'), []);
  assert.equal(manager.getInfoForParent('other', 'sub-known-842'), undefined);
  restore();
  assert.deepEqual(manager.listByParent('parent'), []);
});

test('public observations retain all 40 samples and reconcile provider usage without private traces', () => {
  const root = path.resolve(__dirname, '../eval/benchmarks/jev-parallel');
  const suite = JSON.parse(readFileSync(path.join(root, 'suite.json'), 'utf8'));
  const result = JSON.parse(readFileSync(path.join(root, '2026-11-02.json'), 'utf8'));
  const rows = result.observations;
  assert.equal(result.suite_id, suite.suite_id);
  assert.equal(result.source_provenance.runtime_tree_clean, false);
  assert.equal(rows.length, 40);
  assert.equal(new Set(rows.map((r: any) => `${r.case_id}:${r.arm}`)).size, 40);
  for (const item of suite.cases) for (const arm of ['A', 'B']) {
    const row = rows.find((r: any) => r.case_id === item.case_id && r.arm === arm);
    assert.ok(row);
    assert.equal(row.main_calls, row.calls.length);
    assert.equal(row.main_tokens.total, row.calls.reduce((sum: number, c: any) => sum + c.usage.total_tokens, 0));
    assert.equal(row.jev_tokens, row.jev ? row.jev.usage.input_tokens + row.jev.usage.output_tokens : 0);
    assert.equal(row.total_tokens, row.main_tokens.total + row.jev_tokens);
    assert.equal(row.first_reply_ms !== null, row.visible_reply);
    assert.ok(row.route_correct);
    if (arm === 'B') {
      assert.ok(row.calls[0].started_ms < row.jev.finished_ms);
      assert.ok(row.calls.every((c: any) => c.tools.every((name: string) => ['send_text', 'send_file'].includes(name))));
    }
  }
  const sum = (arm: string, field: string) => rows.filter((r: any) => r.arm === arm).reduce((n: number, r: any) => n + r[field], 0);
  assert.equal(sum('A', 'total_tokens'), 324026);
  assert.equal(sum('B', 'total_tokens'), 243153);
  assert.doesNotMatch(JSON.stringify(result), /oc_sk_|Bearer\s|\/Users\/|\/home\/|"messages"|"headers"/);
});
