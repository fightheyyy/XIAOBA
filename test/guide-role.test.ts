import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillManager } from '../src/capabilities/skills/skill-manager';
import { getRoleSpecificToolsForRole } from '../src/capabilities/roles/runtime-role-registry';
import { PromptManager } from '../src/runtime/harness/context/prompt-manager';
import { RoleResolver } from '../src/capabilities/roles/role-resolver';

const describeGuideRole = fs.existsSync(path.join(process.cwd(), 'roles', 'guide', 'role.json'))
  ? describe
  : describe.skip;

describeGuideRole('Guide role assets', () => {
  afterEach(() => {
    RoleResolver.clearActiveRole();
  });

  test('role.json exists and declares competition aliases', () => {
    const rolePath = path.join(process.cwd(), 'roles', 'guide', 'role.json');
    assert.ok(fs.existsSync(rolePath));

    const config = JSON.parse(fs.readFileSync(rolePath, 'utf-8'));
    assert.strictEqual(config.name, 'guide');
    assert.strictEqual(config.displayName, 'Guide');
    assert.strictEqual(config.promptFile, 'guide-system-prompt.md');
    assert.ok(config.aliases.includes('travel-guide'));
    assert.ok(config.aliases.includes('tpc-guide'));
    assert.strictEqual(
      config.metadata.phase1Dataset,
      '/Users/guowei/minimind/data/ijcai2026_chinatravel/TPC_IJCAI_2026_phase1_EN',
    );
  });

  test('Guide aliases resolve to canonical role id', () => {
    RoleResolver.activateRole('tpc-guide');

    assert.strictEqual(RoleResolver.getActiveRoleName(), 'guide');
    assert.strictEqual(process.env.XIAOBA_ROLE, 'guide');
    assert.strictEqual(process.env.CURRENT_ROLE, 'guide');
    assert.strictEqual(process.env.CURRENT_ROLE_DISPLAY_NAME, 'Guide');
  });

  test('PromptManager loads Guide competition prompt', async () => {
    RoleResolver.activateRole('guide');

    const prompt = await PromptManager.buildSystemPrompt();

    assert.match(prompt, /You are Guide/);
    assert.match(prompt, /Agentic AI travel planning competition/);
    assert.match(prompt, /schema-valid/);
    assert.match(prompt, /eval_tpc\.py/);
    assert.match(prompt, /TPC_IJCAI_2026_phase1_EN/);
    assert.match(prompt, /Qwen3\.6-27B/);
    assert.match(prompt, /当前角色：Guide/);
  });

  test('SkillManager loads Guide role-local skills', async () => {
    RoleResolver.activateRole('guide');

    const manager = new SkillManager();
    await manager.loadSkills();

    assert.ok(manager.getSkill('tpc-baseline'));
    assert.strictEqual(manager.getSkill('chinatravel-baseline')?.metadata.name, 'tpc-baseline');
    assert.strictEqual(manager.getSkill('verifier-repair')?.metadata.name, 'tpc-baseline');
    assert.ok(manager.getSkill('data-profiling'));
    assert.strictEqual(manager.getSkill('tpc-data-profile')?.metadata.name, 'data-profiling');
    assert.strictEqual(manager.getSkill('guide-data-analysis')?.metadata.name, 'data-profiling');
    assert.ok(manager.getSkill('eval-analysis'));
    assert.strictEqual(manager.getSkill('tpc-eval-analysis')?.metadata.name, 'eval-analysis');
    assert.strictEqual(manager.getSkill('guide-verifier-analysis')?.metadata.name, 'eval-analysis');
  });

  test('Guide exposes TPC baseline, eval-analysis, and env-baseline runtime tools', () => {
    const tools = getRoleSpecificToolsForRole('guide');
    assert.deepStrictEqual(tools.map(tool => tool.definition.name), [
      'guide_tpc_baseline',
      'guide_tpc_eval_analysis',
      'guide_tpc_env_baseline',
    ]);
  });

  test('guide_tpc_baseline writes schema-valid prediction artifacts', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-guide-tpc-'));
    try {
      const datasetDir = path.join(testRoot, 'dataset');
      fs.mkdirSync(datasetDir, { recursive: true });
      fs.writeFileSync(
        path.join(datasetDir, 'task-1.json'),
        `${JSON.stringify({
          uid: 'task-1',
          days: 2,
          people_number: 3,
          start_city: 'Shanghai',
          target_city: 'Chengdu',
          nature_language: 'We are 3 people traveling from Shanghai to Chengdu for 2 days. Requirements: We want to visit Iron Statue Temple Water Street.',
          hard_logic_py: [
            `attraction_name_set=set()\nfor activity in allactivities(plan):\n  if activity_type(activity)=='attraction': attraction_name_set.add(activity_position(activity))\nresult=({"Iron Statue Temple Water Street"}&attraction_name_set)`,
            'result=(day_count(plan)==2)',
            'result=(people_count(plan)==3)',
          ],
        })}\n`,
        'utf-8',
      );
      fs.writeFileSync(
        path.join(datasetDir, 'task-2.json'),
        `${JSON.stringify({
          uid: 'task-2',
          days: 1,
          people_number: 1,
          start_city: 'Chengdu',
          target_city: 'Chengdu',
          nature_language: 'We are 1 person in Chengdu for 1 day.',
          hard_logic_py: ['result=(day_count(plan)==1)', 'result=(people_count(plan)==1)'],
        })}\n`,
        'utf-8',
      );

      const [tool] = getRoleSpecificToolsForRole('guide');
      const result = await tool.execute({
        dataset_dir: datasetDir,
        out_dir: 'output/guide-unit',
        run_id: 'guide-unit',
        include_zip: false,
      }, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'guide',
      });

      assert.equal(typeof result, 'string');
      assert.match(result as string, /guide_tpc_baseline: status=completed_with_blockers/);
      assert.match(result as string, /schema_failed=0/);
      assert.match(result as string, /verifier_status=not_requested/);

      const resultDir = path.join(testRoot, 'output', 'guide-unit', 'results', 'guide_schema_baseline_en');
      const prediction = JSON.parse(fs.readFileSync(path.join(resultDir, 'task-1.json'), 'utf-8'));
      assert.equal(prediction.people_number, 3);
      assert.equal(prediction.start_city, 'Shanghai');
      assert.equal(prediction.target_city, 'Chengdu');
      assert.equal(prediction.itinerary.length, 2);
      assert.equal(prediction.itinerary[0].activities[0].type, 'train');
      assert.equal(prediction.itinerary[0].activities[0].tickets, 3);
      assert.ok(
        prediction.itinerary.flatMap((day: any) => day.activities)
          .some((activity: any) => activity.position === 'Iron Statue Temple Water Street'),
      );

      const report = JSON.parse(fs.readFileSync(path.join(testRoot, 'output', 'guide-unit', 'report.json'), 'utf-8'));
      assert.equal(report.schema_check.status, 'pass');
      assert.equal(report.dataset.files_processed, 2);

      const manifest = tool.getArtifactManifest?.({}, result as string, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'guide',
      }) ?? [];
      assert.deepEqual(manifest.map(item => item.metadata?.artifact_role), [
        'prediction_results',
        'run_manifest',
        'baseline_report',
        'human_report',
        'repair_queue',
      ]);
      assert.ok(manifest.every(item => item.metadata?.source === 'tool_owned'));
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('guide_tpc_eval_analysis records setup blockers as tool-owned artifacts', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-guide-eval-'));
    try {
      const tools = getRoleSpecificToolsForRole('guide');
      const tool = tools.find(item => item.definition.name === 'guide_tpc_eval_analysis');
      assert.ok(tool);

      const result = await tool.execute({
        official_repo_dir: path.join(testRoot, 'missing-official-repo'),
        out_dir: 'output/guide-eval-unit',
        run_id: 'guide-eval-unit',
      }, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'guide',
      });

      assert.equal(typeof result, 'string');
      assert.match(result as string, /guide_tpc_eval_analysis: status=blocked_missing_repo/);
      assert.match(result as string, /analysis=output\/guide-eval-unit\/eval-analysis.json/);

      const reportPath = path.join(testRoot, 'output', 'guide-eval-unit', 'eval-analysis.json');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      assert.equal(report.status, 'blocked_missing_repo');
      assert.match(report.reason, /official_repo_dir not found/);

      const manifest = tool.getArtifactManifest?.({}, result as string, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'guide',
      }) ?? [];
      assert.deepEqual(manifest.map(item => item.metadata?.artifact_role), [
        'eval_analysis_json',
        'eval_analysis_report',
        'run_manifest',
      ]);
      assert.ok(manifest.every(item => item.metadata?.source === 'tool_owned'));
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('guide_tpc_env_baseline records setup blockers as tool-owned artifacts', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-guide-env-'));
    try {
      const tools = getRoleSpecificToolsForRole('guide');
      const tool = tools.find(item => item.definition.name === 'guide_tpc_env_baseline');
      assert.ok(tool);

      const result = await tool.execute({
        official_repo_dir: path.join(testRoot, 'missing-official-repo'),
        out_dir: 'output/guide-env-unit',
        run_id: 'guide-env-unit',
      }, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'guide',
      });

      assert.equal(typeof result, 'string');
      assert.match(result as string, /guide_tpc_env_baseline: status=blocked_missing_repo/);
      assert.match(result as string, /report=output\/guide-env-unit\/report.json/);

      const reportPath = path.join(testRoot, 'output', 'guide-env-unit', 'report.json');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      assert.equal(report.status, 'blocked_missing_repo');
      assert.match(report.reason, /official_repo_dir not found/);

      const manifest = tool.getArtifactManifest?.({}, result as string, {
        workingDirectory: testRoot,
        conversationHistory: [],
        roleName: 'guide',
      }) ?? [];
      assert.deepEqual(manifest.map(item => item.metadata?.artifact_role), [
        'env_baseline_report',
        'human_report',
        'run_manifest',
      ]);
      assert.ok(manifest.every(item => item.metadata?.source === 'tool_owned'));
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
