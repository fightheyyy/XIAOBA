import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResearchAutoResearchRunTool } from '../src/capabilities/roles/researcher-cat/tools/research-auto-run-tool';
import { ResearchBoardReadTool, ResearchBoardUpdateTool } from '../src/capabilities/roles/researcher-cat/tools/research-board-tools';

describe('ResearcherCat Research Board tools', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-research-board-'));
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('updates durable board JSON, markdown, and event log', async () => {
    const updateTool = new ResearchBoardUpdateTool();

    const output = await updateTool.execute({
      project: 'Rice EPT Paper',
      task_type: 'experiment_run',
      goal: 'verify earliest predictable time before manuscript sync',
      current_storyline: 'DTS may help early-season prediction, but the claim needs seed evidence.',
      claim_board: [
        {
          claim: 'DTS improves early-season Rice F1 at T=12.',
          status: 'unsupported',
          evidence: ['metrics/seed-42.json'],
        },
      ],
      evidence_board: [
        'Need seed inventory before mean/std claim.',
      ],
      experiment_queue: [
        { text: 'Run seed 123', status: 'planned' },
        { text: 'Run seed 2026', status: 'planned' },
      ],
      artifact_board: [
        'research-board/rice-ept.md',
        '/Users/private/raw/result.csv',
      ],
      risk_board: [
        'Single-seed result cannot support submission claim.',
      ],
      handoff: 'ReviewerCat should verify seed aggregation before manuscript update.',
      next_actions: [
        'Build seed inventory',
        'Run missing seeds',
      ],
      run_registry: [
        {
          run_id: 'dts-seed-42',
          method: 'DTS',
          split: 'year-out',
          seed: '42',
          status: 'completed',
          log_path: 'logs/dts-seed-42.log',
          output_path: 'metrics/seed-42.json',
        },
      ],
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'researcher-cat',
    });

    const result = JSON.parse(output);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.project_slug, 'rice-ept-paper');
    assert.deepStrictEqual(result.counts, {
      claims: 1,
      evidence: 1,
      experiments: 2,
      artifacts: 2,
      risks: 1,
      handoffs: 1,
      next_actions: 2,
      runs: 1,
    });

    const boardPath = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'rice-ept-paper', 'board.json');
    const markdownPath = path.join(testRoot, 'output', 'researcher-cat', 'boards', 'rice-ept-paper', 'research-board.md');
    const eventsPath = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'rice-ept-paper', 'events.jsonl');

    assert.ok(fs.existsSync(boardPath));
    assert.ok(fs.existsSync(markdownPath));
    assert.ok(fs.existsSync(eventsPath));

    const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'));
    assert.strictEqual(board.project_goal, 'verify earliest predictable time before manuscript sync');
    assert.strictEqual(board.claim_board[0].status, 'unsupported');
    assert.strictEqual(board.run_registry[0].id, 'dts-seed-42');
    assert.match(board.artifact_board[1].path, /^\[blocked-external-path:/);
    assert.ok(board.artifact_board[1].original_path_hash);

    const markdown = fs.readFileSync(markdownPath, 'utf-8');
    assert.match(markdown, /# Research Board/);
    assert.match(markdown, /DTS improves early-season Rice F1/);
    assert.match(markdown, /Run Registry/);

    const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, 'research_board_update');
  });

  test('reads board state and can list known boards', async () => {
    const updateTool = new ResearchBoardUpdateTool();
    const readTool = new ResearchBoardReadTool();
    const context = {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'researcher-cat',
    };

    await updateTool.execute({
      project: 'TTT Revision',
      goal: 'recover manuscript delivery state',
      claim_board: [{ claim: 'Latest PDF was delivered.', status: 'unsupported' }],
      next_actions: ['Rebuild delivery manifest'],
    }, context);

    const readOutput = await readTool.execute({
      project: 'TTT Revision',
      include_events: true,
      max_events: 5,
    }, context);
    const readResult = JSON.parse(readOutput);
    assert.strictEqual(readResult.ok, true);
    assert.strictEqual(readResult.board.project, 'TTT Revision');
    assert.match(readResult.markdown, /Latest PDF was delivered/);
    assert.strictEqual(readResult.recent_events.length, 1);

    const listOutput = await readTool.execute({ list_only: true }, context);
    const listResult = JSON.parse(listOutput);
    assert.strictEqual(listResult.ok, true);
    assert.strictEqual(listResult.boards.length, 1);
    assert.strictEqual(listResult.boards[0].project_slug, 'ttt-revision');
  });

  test('auto research run scans bounded workspace and updates board evidence', async () => {
    fs.mkdirSync(path.join(testRoot, 'manuscript'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'results'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, 'manuscript', 'main.tex'),
      '\\section{Method} DTS improves early prediction only if seed evidence supports the claim.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'results', 'seed-42-metrics.json'),
      JSON.stringify({ seed: 42, split: 'year-out', f1: 0.71 }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'logs', 'dts-seed-42.log'),
      'epoch=10 completed seed=42 output=results/seed-42-metrics.json\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testRoot, 'reviews', 'reviewer-comments.md'),
      'Reviewer asks for seed inventory and clearer protocol labels before accepting the result claim.\n',
      'utf-8',
    );

    const tool = new ResearchAutoResearchRunTool();
    const output = await tool.execute({
      project: 'Live Auto Rice EPT',
      goal: 'auto research the Rice EPT revision workspace',
      focus: 'seed inventory and manuscript evidence audit',
      workspace_path: '.',
      max_files: 20,
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'researcher-cat',
    });

    const result = JSON.parse(output);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.project_slug, 'live-auto-rice-ept');
    assert.equal(result.discovered_files, 4);
    assert.equal(result.category_counts.manuscript, 1);
    assert.equal(result.category_counts.metrics, 1);
    assert.equal(result.category_counts.log, 1);
    assert.equal(result.category_counts.review, 1);
    assert.equal(result.manifest_path, 'data/researcher-cat/auto-research/live-auto-rice-ept/intake-manifest.json');
    assert.equal(result.report_path, 'output/researcher-cat/auto-research/live-auto-rice-ept/auto-research-report.md');
    assert.equal(result.phase_plan_path, 'data/researcher-cat/auto-research/live-auto-rice-ept/phase-plan.json');
    assert.equal(result.phase_plan_markdown_path, 'output/researcher-cat/auto-research/live-auto-rice-ept/phase-plan.md');
    assert.equal(result.phase_execution_path, 'data/researcher-cat/auto-research/live-auto-rice-ept/phase-execution.json');
    assert.equal(result.phase_execution_markdown_path, 'output/researcher-cat/auto-research/live-auto-rice-ept/phase-execution.md');
    assert.equal(result.reviewer_handoff_packet_path, 'data/researcher-cat/auto-research/live-auto-rice-ept/reviewer-handoff.json');
    assert.equal(result.reviewer_handoff_packet_markdown_path, 'output/researcher-cat/auto-research/live-auto-rice-ept/reviewer-handoff.md');
    assert.ok(result.phase_plan.phases.some((phase: any) => phase.phase_id === 'phase_evidence_audit' && phase.recommended_skill === 'evidence-auditor'));
    assert.ok(result.phase_plan.phases.some((phase: any) => phase.phase_id === 'phase_experiment_review' && phase.recommended_skill === 'experiment-runner'));
    assert.ok(result.phase_plan.phases.some((phase: any) => phase.phase_id === 'phase_reviewer_handoff' && phase.recommended_skill === 'research-case-orchestrator'));
    assert.ok(result.phase_execution.executions.some((execution: any) => execution.run_id === 'exec_evidence_audit' && execution.skill === 'evidence-auditor'));
    assert.ok(result.phase_execution.executions.some((execution: any) => execution.run_id === 'exec_experiment_review' && execution.skill === 'experiment-runner'));
    assert.ok(result.phase_execution.executions.some((execution: any) => execution.run_id === 'exec_reviewer_handoff' && execution.skill === 'research-case-orchestrator'));
    assert.equal(result.reviewer_handoff_packet.status, 'blocked_until_reviewer_verification');
    assert.equal(result.reviewer_handoff_packet.target_role, 'reviewer-cat');
    assert.ok(result.reviewer_handoff_packet.blockers >= 4);
    assert.ok(result.reviewer_handoff_packet.checklist >= 4);

    const manifestPath = path.join(testRoot, result.manifest_path);
    const reportPath = path.join(testRoot, result.report_path);
    const phasePlanPath = path.join(testRoot, result.phase_plan_path);
    const phasePlanMarkdownPath = path.join(testRoot, result.phase_plan_markdown_path);
    const phaseExecutionPath = path.join(testRoot, result.phase_execution_path);
    const phaseExecutionMarkdownPath = path.join(testRoot, result.phase_execution_markdown_path);
    const reviewerHandoffPacketPath = path.join(testRoot, result.reviewer_handoff_packet_path);
    const reviewerHandoffPacketMarkdownPath = path.join(testRoot, result.reviewer_handoff_packet_markdown_path);
    const boardPath = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'live-auto-rice-ept', 'board.json');
    const markdownPath = path.join(testRoot, 'output', 'researcher-cat', 'boards', 'live-auto-rice-ept', 'research-board.md');
    assert.ok(fs.existsSync(manifestPath));
    assert.ok(fs.existsSync(reportPath));
    assert.ok(fs.existsSync(phasePlanPath));
    assert.ok(fs.existsSync(phasePlanMarkdownPath));
    assert.ok(fs.existsSync(phaseExecutionPath));
    assert.ok(fs.existsSync(phaseExecutionMarkdownPath));
    assert.ok(fs.existsSync(reviewerHandoffPacketPath));
    assert.ok(fs.existsSync(reviewerHandoffPacketMarkdownPath));
    assert.ok(fs.existsSync(boardPath));
    assert.ok(fs.existsSync(markdownPath));

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.equal(manifest.phase_plan_path, result.phase_plan_path);
    assert.equal(manifest.phase_execution_path, result.phase_execution_path);
    assert.equal(manifest.reviewer_handoff_packet_path, result.reviewer_handoff_packet_path);
    assert.deepStrictEqual(manifest.files.map((file: any) => file.relative_path).sort(), [
      'logs/dts-seed-42.log',
      'manuscript/main.tex',
      'results/seed-42-metrics.json',
      'reviews/reviewer-comments.md',
    ]);
    assert.ok(!JSON.stringify(manifest).includes(testRoot));

    const report = fs.readFileSync(reportPath, 'utf-8');
    assert.match(report, /Auto Research Intake Report/);
    assert.match(report, /Workspace Intake Summary/);
    assert.match(report, /Phase Plan Summary/);
    assert.match(report, /Bounded Phase Execution Summary/);
    assert.match(report, /ReviewerCat Handoff Packet/);
    assert.match(report, /phase-plan\.json/);
    assert.match(report, /phase-execution\.json/);
    assert.match(report, /reviewer-handoff\.json/);
    assert.ok(!report.includes(testRoot));

    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf-8'));
    assert.equal(phasePlan.status, 'needs_reviewer_verification');
    assert.equal(phasePlan.reviewer_handoff.target_role, 'reviewer-cat');
    assert.ok(phasePlan.phases.some((phase: any) => phase.phase_id === 'phase_manuscript_sync' && phase.status === 'planned'));
    assert.ok(phasePlan.phases.some((phase: any) => phase.phase_id === 'phase_delivery_readiness' && phase.status === 'blocked'));
    assert.ok(!JSON.stringify(phasePlan).includes(testRoot));

    const phasePlanMarkdown = fs.readFileSync(phasePlanMarkdownPath, 'utf-8');
    assert.match(phasePlanMarkdown, /Auto Research Phase Plan/);
    assert.match(phasePlanMarkdown, /recommended skill: evidence-auditor/);
    assert.match(phasePlanMarkdown, /ReviewerCat Handoff/);
    assert.ok(!phasePlanMarkdown.includes(testRoot));

    const phaseExecution = JSON.parse(fs.readFileSync(phaseExecutionPath, 'utf-8'));
    assert.equal(phaseExecution.status, 'needs_reviewer_verification');
    assert.equal(phaseExecution.reviewer_handoff.target_role, 'reviewer-cat');
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_evidence_audit' && execution.status === 'completed'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_experiment_review' && execution.status === 'completed'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_manuscript_sync_readiness' && execution.status === 'completed'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_delivery_readiness' && execution.status === 'blocked'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_bounded_execution' && execution.status === 'blocked'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_reviewer_handoff' && execution.status === 'completed'));
    assert.ok(!JSON.stringify(phaseExecution).includes(testRoot));

    const phaseExecutionMarkdown = fs.readFileSync(phaseExecutionMarkdownPath, 'utf-8');
    assert.match(phaseExecutionMarkdown, /Auto Research Phase Execution/);
    assert.match(phaseExecutionMarkdown, /exec_evidence_audit/);
    assert.match(phaseExecutionMarkdown, /No workspace script was executed/);
    assert.ok(!phaseExecutionMarkdown.includes(testRoot));

    const reviewerHandoffPacket = JSON.parse(fs.readFileSync(reviewerHandoffPacketPath, 'utf-8'));
    assert.equal(reviewerHandoffPacket.status, 'blocked_until_reviewer_verification');
    assert.equal(reviewerHandoffPacket.requested_reviewer.target_role, 'reviewer-cat');
    assert.equal(reviewerHandoffPacket.requested_reviewer.decision_needed, 'closed_next_run_or_blocked');
    assert.equal(reviewerHandoffPacket.acceptance_boundary.researcher_decision, 'no_final_acceptance');
    assert.equal(reviewerHandoffPacket.acceptance_boundary.reviewer_decision_required, true);
    assert.ok(reviewerHandoffPacket.evidence_bundle.board_json_path.endsWith('/board.json'));
    assert.ok(reviewerHandoffPacket.evidence_bundle.phase_execution_path.endsWith('/phase-execution.json'));
    assert.ok(reviewerHandoffPacket.evidence_bundle.reviewer_handoff_packet_path.endsWith('/reviewer-handoff.json'));
    assert.ok(reviewerHandoffPacket.blockers.some((item: any) => item.id === 'reviewer_not_run'));
    assert.ok(reviewerHandoffPacket.review_checklist.some((item: any) => item.id === 'review_claim_evidence' && item.level === 'L5'));
    assert.ok(reviewerHandoffPacket.review_checklist.some((item: any) => item.id === 'review_non_mutating_boundary'));
    assert.ok(!JSON.stringify(reviewerHandoffPacket).includes(testRoot));

    const reviewerHandoffMarkdown = fs.readFileSync(reviewerHandoffPacketMarkdownPath, 'utf-8');
    assert.match(reviewerHandoffMarkdown, /ReviewerCat Handoff Packet/);
    assert.match(reviewerHandoffMarkdown, /review_claim_evidence/);
    assert.match(reviewerHandoffMarkdown, /researcher decision: no_final_acceptance/);
    assert.ok(!reviewerHandoffMarkdown.includes(testRoot));

    const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'));
    assert.equal(board.active_task_type, 'auto_research');
    assert.equal(board.claim_board[0].status, 'unsupported');
    assert.equal(board.handoffs[0].target_role, 'reviewer-cat');
    assert.ok(board.run_registry.some((item: any) => item.id === 'workspace-intake' && item.status === 'completed'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'phase-plan' && item.status === 'completed'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'phase-execution' && item.method === 'research-phase-execution'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'reviewer-handoff-packet' && item.method === 'reviewer-handoff-packaging'));
    assert.match(board.current_storyline, /Workspace intake found 4 candidate evidence files/);
    assert.match(board.current_storyline, /phase-plan\.json/);
    assert.match(board.current_storyline, /phase-execution\.json/);
    assert.match(board.current_storyline, /reviewer-handoff\.json/);
    assert.ok(board.next_actions.some((item: any) => item.text.includes('Review seed inventory')));
    assert.ok(board.next_actions.some((item: any) => item.text.includes('phase_evidence_audit')));
    assert.ok(board.next_actions.some((item: any) => item.text.includes('exec_delivery_readiness')));
    assert.ok(board.artifact_board.some((item: any) => item.path === result.manifest_path));
    assert.ok(board.artifact_board.some((item: any) => item.path === result.phase_plan_path && item.type === 'phase_plan'));
    assert.ok(board.artifact_board.some((item: any) => item.path === result.phase_execution_path && item.type === 'phase_execution'));
    assert.ok(board.artifact_board.some((item: any) => item.path === result.reviewer_handoff_packet_path && item.type === 'reviewer_handoff_packet'));
    assert.ok(board.evidence_board.some((item: any) => item.text.includes('Structured auto research phase plan generated')));
    assert.ok(board.evidence_board.some((item: any) => item.text.includes('Bounded phase execution generated')));
    assert.ok(board.evidence_board.some((item: any) => item.text.includes('ReviewerCat handoff packet generated')));
    assert.ok(board.risk_board.some((item: any) => item.text.includes('no manuscript edit, script run, compile/export, or final acceptance occurred')));
    assert.ok(board.risk_board.some((item: any) => item.text.includes('ResearcherCat has not produced a closed/next_run/blocked decision')));
  });

  test('auto research run restores existing board state before workspace intake', async () => {
    fs.mkdirSync(path.join(testRoot, 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, 'results', 'seed-123-metrics.json'),
      JSON.stringify({ seed: 123, split: 'year-out', f1: 0.72 }, null, 2),
      'utf-8',
    );

    const context = {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'researcher-cat',
    };
    const updateTool = new ResearchBoardUpdateTool();
    await updateTool.execute({
      project: 'Live Resume Rice EPT',
      task_type: 'state_recovery',
      goal: 'resume Rice EPT seed aggregation',
      claim_board: [
        {
          claim: 'DTS improves Rice F1 after seed 42.',
          status: 'unsupported',
          evidence: ['results/seed-42-metrics.json'],
        },
      ],
      risk_board: [
        {
          text: 'Seed 123 is still missing from the aggregation ledger.',
          status: 'blocked',
          evidence: ['results/seed-42-metrics.json'],
        },
      ],
      handoffs: [
        {
          target_role: 'reviewer-cat',
          reason: 'Verify resumed seed aggregation before manuscript sync.',
          status: 'planned',
          evidence: ['results/seed-42-metrics.json'],
        },
      ],
      next_actions: [
        {
          text: 'Recover missing seed 123 output.',
          status: 'planned',
          evidence: ['results/seed-42-metrics.json'],
        },
      ],
      run_registry: [
        {
          run_id: 'dts-seed-42',
          method: 'DTS',
          split: 'year-out',
          seed: '42',
          status: 'completed',
          output_path: 'results/seed-42-metrics.json',
          evidence: ['results/seed-42-metrics.json'],
        },
      ],
    }, context);

    const tool = new ResearchAutoResearchRunTool();
    const output = await tool.execute({
      project: 'Live Resume Rice EPT',
      goal: 'auto research resumed seed aggregation',
      focus: 'recover seed ledger from board and workspace',
      workspace_path: '.',
      max_files: 20,
    }, context);

    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.board_resume.restored, true);
    assert.equal(result.board_resume.open_claims.length, 1);
    assert.equal(result.board_resume.previous_runs.length, 1);

    const manifest = JSON.parse(fs.readFileSync(path.join(testRoot, result.manifest_path), 'utf-8'));
    assert.equal(manifest.board_resume.restored, true);
    assert.equal(manifest.board_resume.open_risks[0].status, 'blocked');
    assert.equal(manifest.phase_plan_path, 'data/researcher-cat/auto-research/live-resume-rice-ept/phase-plan.json');
    assert.equal(manifest.phase_execution_path, 'data/researcher-cat/auto-research/live-resume-rice-ept/phase-execution.json');
    assert.equal(manifest.reviewer_handoff_packet_path, 'data/researcher-cat/auto-research/live-resume-rice-ept/reviewer-handoff.json');
    assert.ok(!JSON.stringify(manifest).includes(testRoot));

    const phasePlan = JSON.parse(fs.readFileSync(path.join(testRoot, result.phase_plan_path), 'utf-8'));
    assert.equal(phasePlan.board_resume.restored, true);
    assert.ok(phasePlan.phases.some((phase: any) => phase.phase_id === 'phase_board_resume' && phase.status === 'completed'));
    assert.ok(phasePlan.phases.some((phase: any) => phase.phase_id === 'phase_experiment_review' && phase.status === 'planned'));
    assert.ok(!JSON.stringify(phasePlan).includes(testRoot));

    const phaseExecution = JSON.parse(fs.readFileSync(path.join(testRoot, result.phase_execution_path), 'utf-8'));
    assert.equal(phaseExecution.status, 'needs_reviewer_verification');
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_experiment_review' && execution.status === 'completed'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_reviewer_handoff'));
    assert.ok(!JSON.stringify(phaseExecution).includes(testRoot));

    const reviewerHandoffPacket = JSON.parse(fs.readFileSync(path.join(testRoot, result.reviewer_handoff_packet_path), 'utf-8'));
    assert.equal(reviewerHandoffPacket.status, 'blocked_until_reviewer_verification');
    assert.ok(reviewerHandoffPacket.review_checklist.some((item: any) => item.id === 'review_board_state'));
    assert.ok(!JSON.stringify(reviewerHandoffPacket).includes(testRoot));

    const report = fs.readFileSync(path.join(testRoot, result.report_path), 'utf-8');
    assert.match(report, /Board Resume Summary/);
    assert.match(report, /Phase Plan Summary/);
    assert.match(report, /Bounded Phase Execution Summary/);
    assert.match(report, /ReviewerCat Handoff Packet/);
    assert.match(report, /Open claims from restored board/);
    assert.match(report, /DTS improves Rice F1 after seed 42/);
    assert.ok(!report.includes(testRoot));

    const boardPath = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'live-resume-rice-ept', 'board.json');
    const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'));
    assert.match(board.current_storyline, /Existing Research Board restored/);
    assert.ok(board.claim_board.some((item: any) => item.claim.includes('DTS improves Rice F1 after seed 42')));
    assert.ok(board.evidence_board.some((item: any) => item.text.includes('Existing Research Board restored before auto research')));
    assert.ok(board.risk_board.some((item: any) => item.text.includes('Restored Research Board state is prior context only')));
    assert.ok(board.next_actions.some((item: any) => item.text.includes('Reconcile restored Research Board open claims')));
    assert.ok(board.run_registry.some((item: any) => item.id === 'dts-seed-42'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'board-restore' && item.status === 'completed'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'workspace-intake' && item.status === 'completed'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'phase-plan' && item.status === 'completed'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'phase-execution' && item.status === 'completed'));
    assert.ok(board.run_registry.some((item: any) => item.id === 'reviewer-handoff-packet' && item.status === 'completed'));
  });

  test('auto research run records delivery artifacts without reading binary content', async () => {
    fs.mkdirSync(path.join(testRoot, 'figures'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'delivery'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'figures', 'confusion-matrix.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(testRoot, 'delivery', 'rebuttal-deck.pptx'), Buffer.from('pptx fixture'));
    fs.writeFileSync(path.join(testRoot, 'delivery', 'submission.pdf'), Buffer.from('%PDF-1.4 fixture'));

    const tool = new ResearchAutoResearchRunTool();
    const output = await tool.execute({
      project: 'Live Artifact Rice EPT',
      goal: 'auto research delivery artifact readiness',
      focus: 'PDF PPT and figure delivery readiness',
      workspace_path: '.',
      max_files: 20,
    }, {
      workingDirectory: testRoot,
      conversationHistory: [],
      roleName: 'researcher-cat',
    });

    const result = JSON.parse(output);
    assert.equal(result.discovered_files, 3);
    assert.equal(result.category_counts.artifact, 3);

    const manifestPath = path.join(testRoot, result.manifest_path);
    const reportPath = path.join(testRoot, result.report_path);
    const phaseExecutionPath = path.join(testRoot, result.phase_execution_path);
    const reviewerHandoffPacketPath = path.join(testRoot, result.reviewer_handoff_packet_path);
    const boardPath = path.join(testRoot, 'data', 'researcher-cat', 'boards', 'live-artifact-rice-ept', 'board.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.deepStrictEqual(manifest.files.map((file: any) => file.relative_path).sort(), [
      'delivery/rebuttal-deck.pptx',
      'delivery/submission.pdf',
      'figures/confusion-matrix.png',
    ]);
    assert.ok(manifest.files.every((file: any) => file.kind === 'artifact'));
    assert.ok(manifest.files.every((file: any) => file.signals.includes('delivery_artifact')));
    assert.ok(!JSON.stringify(manifest).includes(testRoot));

    const report = fs.readFileSync(reportPath, 'utf-8');
    assert.match(report, /delivery\/submission\.pdf/);
    assert.match(report, /figures\/confusion-matrix\.png/);
    assert.match(report, /Bounded Phase Execution Summary/);
    assert.ok(!report.includes(testRoot));

    const phaseExecution = JSON.parse(fs.readFileSync(phaseExecutionPath, 'utf-8'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_delivery_readiness' && execution.status === 'needs_review'));
    assert.ok(phaseExecution.executions.some((execution: any) => execution.run_id === 'exec_bounded_execution' && execution.status === 'blocked'));

    const reviewerHandoffPacket = JSON.parse(fs.readFileSync(reviewerHandoffPacketPath, 'utf-8'));
    assert.ok(reviewerHandoffPacket.blockers.some((item: any) => item.id === 'delivery_not_verified'));
    assert.ok(reviewerHandoffPacket.review_checklist.some((item: any) => item.id === 'review_delivery_readiness'));

    const board = JSON.parse(fs.readFileSync(boardPath, 'utf-8'));
    assert.equal(board.active_task_type, 'auto_research');
    assert.ok(board.artifact_board.some((item: any) => item.path === 'delivery/submission.pdf' && item.type === 'pdf'));
    assert.ok(board.artifact_board.some((item: any) => item.path === 'delivery/rebuttal-deck.pptx' && item.type === 'slides'));
    assert.ok(board.artifact_board.some((item: any) => item.path === 'figures/confusion-matrix.png' && item.type === 'figure'));
    assert.ok(board.artifact_board.some((item: any) => item.path === result.phase_execution_path && item.type === 'phase_execution'));
    assert.ok(board.artifact_board.some((item: any) => item.path === result.reviewer_handoff_packet_path && item.type === 'reviewer_handoff_packet'));
    assert.ok(board.risk_board.some((item: any) => item.text.includes('Workspace intake is discovery evidence only')));
    assert.ok(board.risk_board.some((item: any) => item.text.includes('Bounded phase execution is non-mutating observation only')));
  });
});
