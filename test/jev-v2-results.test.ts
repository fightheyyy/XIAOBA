import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { summarizePublishedResults } from '../scripts/run-jev-v2-live';

const document = JSON.parse(fs.readFileSync(path.resolve('eval/benchmarks/jev-v2/2026-11-02.json'), 'utf8'));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('published 180 observations reproduce the paired estimates without pooling the follow-up', () => {
  const summary = summarizePublishedResults(document);
  assert.equal(document.observations.length, 180);
  assert.equal(document.followup.observations.length, 6);
  assert.equal(summary.primary.all.A.n, 90);
  assert.equal(summary.primary.all.B.route_correct, 90);
  assert.equal(summary.primary.all.A.task_completed_hard_oracle, 72);
  assert.equal(summary.primary.all.B.task_completed_hard_oracle, 74);
  assert.equal(summary.paired.A.n, 89);
  assert.equal(summary.paired.B.n, 89);
  close(summary.paired.A.mean_main_tokens, 22556.786516853932);
  close(summary.paired.B.mean_main_plus_jev_tokens, 25090.460674157304);
  close(summary.paired.A.cost_per_1000_requests.official_paid.total, 3.8043550561797743);
  close(summary.paired.B.cost_per_1000_requests.official_paid.total, 3.42035);
  close(summary.paired.B.cost_per_1000_requests.user_discount_assumption.total, 3.289986719101125);
  assert.equal(document.observations.filter((row: any) => !row.usage_complete).length, 1);
  assert.doesNotMatch(JSON.stringify(document), /\/Users\/|\/private\/tmp\/|oc_sk_|Bearer /);
});

test('cost includes request-phase existing-child continuation and discounts cached input only once', () => {
  const copy = structuredClone(document);
  const a = structuredClone(document.observations.find((row: any) => row.arm === 'A'));
  const b = structuredClone(document.observations.find((row: any) => row.arm === 'B'));
  for (const row of [a, b]) {
    row.case_id = 'one-pair'; row.repeat = 1; row.setup_valid = true;
    row.expired = false; row.error = null; row.provider_error_count = 0; row.usage_complete = true;
    row.calls = [
      { component: 'main', phase: 'request', usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
        raw_usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } } },
      { component: 'setup-child', phase: 'request', usage: { promptTokens: 250, completionTokens: 10, totalTokens: 260 } },
      { component: 'setup-child', phase: 'setup', usage: { promptTokens: 999999, completionTokens: 999999, totalTokens: 1999998 } },
    ];
    row.jev_attempts = row.arm === 'B' ? [{ input_tokens: 1000, output_tokens: 500, usage_reported: true }] : [];
  }
  copy.observations = [a, b];
  const summary = summarizePublishedResults(copy);
  close(summary.paired.B.cost_per_1000_requests.official_paid.main, .248);
  close(summary.paired.B.cost_per_1000_requests.official_paid.child, .062);
  close(summary.paired.B.cost_per_1000_requests.official_paid.jev, .042);
  close(summary.paired.B.cost_per_1000_requests.official_paid.total, .352);
  assert.throws(() => summarizePublishedResults({ ...copy, observations: [a, b, a] }), /Duplicate observation ID/);
});
