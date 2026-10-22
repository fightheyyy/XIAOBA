import * as fs from 'fs';
import * as path from 'path';
import { ArtifactManifestItem, Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';
import { ResearchBoard, ResearchBoardStore, ResearchBoardUpdateInput } from '../utils/research-board-store';

interface ResearchAutoRunInput {
  project: string;
  goal?: string;
  focus?: string;
  workspace_path?: string;
  max_files?: number;
  max_file_bytes?: number;
}

interface IntakeFile {
  relative_path: string;
  bytes: number;
  kind: IntakeFileKind;
  signals: string[];
}

interface BoardResumeSummary {
  restored: boolean;
  project_slug: string;
  updated_at?: string;
  counts: Record<string, number>;
  open_claims: Array<{
    id: string;
    claim: string;
    status: string;
    evidence_count: number;
  }>;
  open_risks: Array<{
    id: string;
    text: string;
    status: string;
    evidence_count: number;
  }>;
  pending_next_actions: Array<{
    id: string;
    text: string;
    status: string;
    evidence_count: number;
  }>;
  previous_runs: Array<{
    id: string;
    status: string;
    output_path?: string;
    log_path?: string;
  }>;
  handoff_roles: string[];
}

type ResearchPhaseStatus = 'completed' | 'planned' | 'blocked' | 'needs_review';

type ResearchPhaseSkill =
  | 'research-case-orchestrator'
  | 'paper-reader'
  | 'evidence-auditor'
  | 'experiment-runner'
  | 'manuscript-sync'
  | 'latex-compiler'
  | 'revision-planner';

interface ResearchPhase {
  phase_id: string;
  title: string;
  status: ResearchPhaseStatus;
  reason: string;
  recommended_skill: ResearchPhaseSkill;
  evidence: string[];
  blocked_by: string[];
  next_action: string;
}

interface ResearchPhasePlan {
  schema_version: 1;
  project: string;
  project_slug: string;
  goal: string;
  focus: string;
  workspace_path: string;
  generated_at: string;
  status: 'needs_reviewer_verification';
  artifacts: {
    intake_manifest_path: string;
    intake_report_path: string;
    phase_plan_path: string;
    phase_plan_markdown_path: string;
  };
  category_counts: Record<string, number>;
  board_resume: {
    restored: boolean;
    summary: string;
    evidence: string[];
  };
  phases: ResearchPhase[];
  next_actions: string[];
  reviewer_handoff: {
    target_role: 'reviewer-cat';
    status: 'planned';
    reason: string;
    evidence: string[];
  };
}

type ResearchSkillExecutionStatus = 'completed' | 'blocked' | 'needs_review';

interface ResearchSkillExecution {
  run_id: string;
  phase_id: string;
  skill: ResearchPhaseSkill;
  status: ResearchSkillExecutionStatus;
  objective: string;
  evidence: string[];
  outputs: string[];
  findings: string[];
  blockers: string[];
  next_action: string;
}

interface ResearchPhaseExecution {
  schema_version: 1;
  project: string;
  project_slug: string;
  goal: string;
  focus: string;
  workspace_path: string;
  generated_at: string;
  status: 'needs_reviewer_verification';
  phase_plan_path: string;
  artifacts: {
    intake_manifest_path: string;
    intake_report_path: string;
    phase_plan_path: string;
    phase_plan_markdown_path: string;
    phase_execution_path: string;
    phase_execution_markdown_path: string;
  };
  executions: ResearchSkillExecution[];
  reviewer_handoff: {
    target_role: 'reviewer-cat';
    status: 'planned';
    reason: string;
    evidence: string[];
  };
}

type ResearchReviewReadinessStatus = 'blocked' | 'needs_review' | 'ready_for_review';

interface ResearchReviewerHandoffPacket {
  schema_version: 1;
  project: string;
  project_slug: string;
  goal: string;
  focus: string;
  workspace_path: string;
  generated_at: string;
  status: 'blocked_until_reviewer_verification';
  requested_reviewer: {
    target_role: 'reviewer-cat';
    decision_needed: 'closed_next_run_or_blocked';
    review_scope: string[];
  };
  evidence_bundle: {
    board_json_path: string;
    board_markdown_path: string;
    events_jsonl_path: string;
    intake_manifest_path: string;
    intake_report_path: string;
    phase_plan_path: string;
    phase_plan_markdown_path: string;
    phase_execution_path: string;
    phase_execution_markdown_path: string;
    reviewer_handoff_packet_path: string;
    reviewer_handoff_packet_markdown_path: string;
  };
  readiness_summary: Array<{
    area: string;
    status: ResearchReviewReadinessStatus;
    summary: string;
    evidence: string[];
  }>;
  blockers: Array<{
    id: string;
    severity: 'high' | 'medium';
    text: string;
    evidence: string[];
  }>;
  review_checklist: Array<{
    id: string;
    level: 'L4' | 'L5';
    reviewer_action: string;
    required_evidence: string[];
  }>;
  acceptance_boundary: {
    researcher_decision: 'no_final_acceptance';
    reviewer_decision_required: true;
    forbidden_researcher_claims: string[];
  };
}

type IntakeFileKind =
  | 'manuscript'
  | 'review'
  | 'metrics'
  | 'log'
  | 'script'
  | 'artifact'
  | 'note';

const DEFAULT_PROJECT = 'research-project';
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_SCAN_DEPTH = 6;
const TEXT_EXTENSIONS = new Set([
  '.bib',
  '.csv',
  '.json',
  '.jsonl',
  '.log',
  '.md',
  '.py',
  '.r',
  '.rst',
  '.sh',
  '.tex',
  '.tsv',
  '.txt',
  '.yaml',
  '.yml',
]);
const ARTIFACT_EXTENSIONS = new Set([
  '.gif',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.svg',
  '.webp',
]);
const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.DS_Store',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'data',
  'output',
]);

export class ResearchAutoResearchRunTool implements Tool {
  definition: ToolDefinition = {
    name: 'auto_research_run',
    description: [
      'ResearcherCat tool: run a bounded auto-research intake over the current workspace,',
      'discover manuscript/result/log/review evidence, update the durable Research Board,',
      'and write a manifest, phase plan, bounded phase execution report, and progress report.',
      'This is an intake/orchestration tool, not final ReviewerCat acceptance.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Stable research project name, for example Rice EPT Revision.',
        },
        goal: {
          type: 'string',
          description: 'Research goal the user wants ResearcherCat to advance.',
        },
        focus: {
          type: 'string',
          description: 'Optional narrower focus, for example seed inventory, rebuttal triage, or manuscript evidence audit.',
        },
        workspace_path: {
          type: 'string',
          description: 'Workspace subdirectory to scan. Must stay inside the current working directory. Defaults to ".".',
          default: '.',
        },
        max_files: {
          type: 'number',
          description: 'Maximum candidate files to include in the intake manifest. Defaults to 40.',
          default: DEFAULT_MAX_FILES,
        },
        max_file_bytes: {
          type: 'number',
          description: 'Maximum file size for text inspection. Defaults to 262144 bytes.',
          default: DEFAULT_MAX_FILE_BYTES,
        },
      },
      required: ['project'],
    },
  };

  async execute(args: ResearchAutoRunInput, context: ToolExecutionContext): Promise<string> {
    const project = readString(args?.project, DEFAULT_PROJECT);
    const goal = readString(args?.goal, `Auto research intake for ${project}`);
    const focus = readString(args?.focus, goal);
    const rootDir = context.workingDirectory;
    const workspaceDir = resolveWorkspacePath(rootDir, args?.workspace_path);
    const workspaceRel = toRelativePath(rootDir, workspaceDir) || '.';
    const maxFiles = clampNumber(args?.max_files, 1, 200, DEFAULT_MAX_FILES);
    const maxFileBytes = clampNumber(args?.max_file_bytes, 1024, 1024 * 1024, DEFAULT_MAX_FILE_BYTES);
    const projectSlug = safeSegment(project);
    const store = new ResearchBoardStore(rootDir);
    const boardResume = summarizeExistingBoard(readExistingBoard(store, project), projectSlug);

    const intakeFiles = scanWorkspace(rootDir, workspaceDir, {
      maxFiles,
      maxFileBytes,
    });
    const categoryCounts = countByKind(intakeFiles);
    const dataDir = path.join(rootDir, 'data', 'researcher-cat', 'auto-research', projectSlug);
    const outputDir = path.join(rootDir, 'output', 'researcher-cat', 'auto-research', projectSlug);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const generatedAt = new Date().toISOString();
    const manifestRel = path.posix.join('data', 'researcher-cat', 'auto-research', projectSlug, 'intake-manifest.json');
    const reportRel = path.posix.join('output', 'researcher-cat', 'auto-research', projectSlug, 'auto-research-report.md');
    const phasePlanRel = path.posix.join('data', 'researcher-cat', 'auto-research', projectSlug, 'phase-plan.json');
    const phasePlanMarkdownRel = path.posix.join('output', 'researcher-cat', 'auto-research', projectSlug, 'phase-plan.md');
    const phaseExecutionRel = path.posix.join('data', 'researcher-cat', 'auto-research', projectSlug, 'phase-execution.json');
    const phaseExecutionMarkdownRel = path.posix.join('output', 'researcher-cat', 'auto-research', projectSlug, 'phase-execution.md');
    const reviewerHandoffPacketRel = path.posix.join('data', 'researcher-cat', 'auto-research', projectSlug, 'reviewer-handoff.json');
    const reviewerHandoffPacketMarkdownRel = path.posix.join('output', 'researcher-cat', 'auto-research', projectSlug, 'reviewer-handoff.md');
    const boardJsonRel = path.posix.join('data', 'researcher-cat', 'boards', projectSlug, 'board.json');
    const boardMarkdownRel = path.posix.join('output', 'researcher-cat', 'boards', projectSlug, 'research-board.md');
    const eventsJsonlRel = path.posix.join('data', 'researcher-cat', 'boards', projectSlug, 'events.jsonl');
    const phasePlan = buildResearchPhasePlan({
      project,
      projectSlug,
      goal,
      focus,
      workspaceRel,
      generatedAt,
      categoryCounts,
      intakeFiles,
      boardResume,
      manifestRel,
      reportRel,
      phasePlanRel,
      phasePlanMarkdownRel,
    });
    const phaseExecution = buildResearchPhaseExecution({
      project,
      projectSlug,
      goal,
      focus,
      workspaceRel,
      generatedAt,
      intakeFiles,
      manifestRel,
      reportRel,
      phasePlanRel,
      phasePlanMarkdownRel,
      phaseExecutionRel,
      phaseExecutionMarkdownRel,
    });
    const reviewerHandoffPacket = buildReviewerHandoffPacket({
      project,
      projectSlug,
      goal,
      focus,
      workspaceRel,
      generatedAt,
      intakeFiles,
      boardJsonRel,
      boardMarkdownRel,
      eventsJsonlRel,
      manifestRel,
      reportRel,
      phasePlanRel,
      phasePlanMarkdownRel,
      phaseExecutionRel,
      phaseExecutionMarkdownRel,
      reviewerHandoffPacketRel,
      reviewerHandoffPacketMarkdownRel,
      phaseExecution,
    });
    const manifest = {
      schema_version: 1,
      project,
      project_slug: projectSlug,
      goal,
      focus,
      workspace_path: workspaceRel,
      generated_at: generatedAt,
      limits: {
        max_files: maxFiles,
        max_file_bytes: maxFileBytes,
        max_depth: MAX_SCAN_DEPTH,
      },
      category_counts: categoryCounts,
      board_resume: boardResume,
      phase_plan_path: phasePlanRel,
      phase_plan_markdown_path: phasePlanMarkdownRel,
      phase_execution_path: phaseExecutionRel,
      phase_execution_markdown_path: phaseExecutionMarkdownRel,
      reviewer_handoff_packet_path: reviewerHandoffPacketRel,
      reviewer_handoff_packet_markdown_path: reviewerHandoffPacketMarkdownRel,
      files: intakeFiles,
    };
    const report = renderIntakeReport(manifest, phasePlan, phaseExecution, reviewerHandoffPacket);
    fs.writeFileSync(path.join(dataDir, 'intake-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'phase-plan.json'), `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'phase-plan.md'), renderPhasePlanMarkdown(phasePlan), 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'phase-execution.json'), `${JSON.stringify(phaseExecution, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'phase-execution.md'), renderPhaseExecutionMarkdown(phaseExecution), 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'reviewer-handoff.json'), `${JSON.stringify(reviewerHandoffPacket, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'reviewer-handoff.md'), renderReviewerHandoffMarkdown(reviewerHandoffPacket), 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'auto-research-report.md'), report, 'utf-8');

    const boardInput = buildBoardUpdateInput({
      project,
      goal,
      focus,
      workspaceRel,
      projectSlug,
      intakeFiles,
      manifestRel,
      reportRel,
      phasePlanRel,
      phasePlanMarkdownRel,
      phasePlan,
      phaseExecutionRel,
      phaseExecutionMarkdownRel,
      phaseExecution,
      reviewerHandoffPacketRel,
      reviewerHandoffPacketMarkdownRel,
      reviewerHandoffPacket,
      boardResume,
    });
    const boardResult = store.update(boardInput);

    return `${JSON.stringify({
      ok: true,
      project,
      project_slug: projectSlug,
      status: 'needs_reviewer_verification',
      workspace_path: workspaceRel,
      discovered_files: intakeFiles.length,
      category_counts: categoryCounts,
      board_resume: boardResume,
      manifest_path: manifestRel,
      report_path: reportRel,
      phase_plan_path: phasePlanRel,
      phase_plan_markdown_path: phasePlanMarkdownRel,
      phase_execution_path: phaseExecutionRel,
      phase_execution_markdown_path: phaseExecutionMarkdownRel,
      reviewer_handoff_packet_path: reviewerHandoffPacketRel,
      reviewer_handoff_packet_markdown_path: reviewerHandoffPacketMarkdownRel,
      phase_plan: {
        status: phasePlan.status,
        phases: phasePlan.phases.map(phase => ({
          phase_id: phase.phase_id,
          status: phase.status,
          recommended_skill: phase.recommended_skill,
          next_action: phase.next_action,
        })),
      },
      phase_execution: {
        status: phaseExecution.status,
        executions: phaseExecution.executions.map(execution => ({
          run_id: execution.run_id,
          phase_id: execution.phase_id,
          skill: execution.skill,
          status: execution.status,
          next_action: execution.next_action,
        })),
      },
      reviewer_handoff_packet: {
        status: reviewerHandoffPacket.status,
        target_role: reviewerHandoffPacket.requested_reviewer.target_role,
        blockers: reviewerHandoffPacket.blockers.length,
        checklist: reviewerHandoffPacket.review_checklist.length,
      },
      board_json_path: boardResult.board_json_path,
      board_markdown_path: boardResult.board_markdown_path,
      events_jsonl_path: boardResult.events_jsonl_path,
      board_counts: boardResult.counts,
      next_actions: boardInput.next_actions,
      handoff: 'reviewer-cat',
    }, null, 2)}\n`;
  }

  getArtifactManifest(_args: ResearchAutoRunInput, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    const parsed = parseToolJsonResult(result);
    return [
      toolArtifact(parsed.manifest_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.report_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.phase_plan_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.phase_plan_markdown_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.phase_execution_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.phase_execution_markdown_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.reviewer_handoff_packet_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.reviewer_handoff_packet_markdown_path, 'generated', context.workingDirectory),
      toolArtifact(parsed.board_json_path, 'updated', context.workingDirectory),
      toolArtifact(parsed.board_markdown_path, 'updated', context.workingDirectory),
      toolArtifact(parsed.events_jsonl_path, 'updated', context.workingDirectory),
    ].filter((item): item is ArtifactManifestItem => Boolean(item));
  }
}

function parseToolJsonResult(result: unknown): Record<string, unknown> {
  if (typeof result !== 'string') return {};
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toolArtifact(
  pathValue: unknown,
  action: ArtifactManifestItem['action'],
  workingDirectory: string,
): ArtifactManifestItem | undefined {
  if (typeof pathValue !== 'string' || !pathValue.trim()) return undefined;
  const normalized = workspaceRelativeArtifactPath(pathValue, workingDirectory);
  return {
    path: normalized,
    type: artifactType(normalized),
    action,
  };
}

function workspaceRelativeArtifactPath(pathValue: string, workingDirectory: string): string {
  const normalized = pathValue.trim().replace(/\\/g, '/');
  const cwd = workingDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.startsWith(`${cwd}/`)) {
    return normalized.slice(cwd.length + 1);
  }
  return normalized.replace(/^\/+/, '');
}

function artifactType(pathValue: string): string {
  const match = pathValue.match(/\.([A-Za-z0-9]+)(?:$|[?#])/);
  return match ? match[1].toLowerCase() : 'file';
}

function buildBoardUpdateInput(input: {
  project: string;
  goal: string;
  focus: string;
  workspaceRel: string;
  projectSlug: string;
  intakeFiles: IntakeFile[];
  manifestRel: string;
  reportRel: string;
  phasePlanRel: string;
  phasePlanMarkdownRel: string;
  phasePlan: ResearchPhasePlan;
  phaseExecutionRel: string;
  phaseExecutionMarkdownRel: string;
  phaseExecution: ResearchPhaseExecution;
  reviewerHandoffPacketRel: string;
  reviewerHandoffPacketMarkdownRel: string;
  reviewerHandoffPacket: ResearchReviewerHandoffPacket;
  boardResume: BoardResumeSummary;
}): ResearchBoardUpdateInput {
  const evidencePaths = input.intakeFiles.map(item => item.relative_path);
  const metricsPaths = input.intakeFiles.filter(item => item.kind === 'metrics').map(item => item.relative_path);
  const logPaths = input.intakeFiles.filter(item => item.kind === 'log').map(item => item.relative_path);
  const manuscriptPaths = input.intakeFiles.filter(item => item.kind === 'manuscript').map(item => item.relative_path);
  const reviewPaths = input.intakeFiles.filter(item => item.kind === 'review').map(item => item.relative_path);
  const artifactPaths = input.intakeFiles.filter(item => item.kind === 'artifact').map(item => item.relative_path);
  const evidenceSample = evidencePaths.slice(0, 6);
  const resultEvidence = uniqueStrings([...metricsPaths, ...logPaths]).slice(0, 6);
  const boardJsonRel = path.posix.join('data', 'researcher-cat', 'boards', input.projectSlug, 'board.json');
  const resumeEvidence = input.boardResume.restored
    ? [boardJsonRel, input.manifestRel]
    : [input.manifestRel];
  const resumeEvidenceBoard = input.boardResume.restored
    ? [{
      text: `Existing Research Board restored before auto research: ${formatBoardResumeSummary(input.boardResume)}.`,
      status: 'weakly_supported',
      evidence: resumeEvidence,
    }]
    : [];
  const evidenceBoard = input.intakeFiles.length > 0
    ? input.intakeFiles.slice(0, 12).map(file => ({
      text: `${file.kind} evidence discovered during workspace intake: ${file.relative_path}`,
      status: file.kind === 'metrics' || file.kind === 'log' ? 'weakly_supported' : 'unknown',
      evidence: [file.relative_path],
    }))
    : [{
      text: `No candidate research evidence files were discovered under ${input.workspaceRel}.`,
      status: 'blocked',
      evidence: [input.manifestRel],
    }];

  const experimentEvidence = resultEvidence.length ? resultEvidence : [input.manifestRel];
  const resumeNextActions = input.boardResume.restored
    ? [
      'Reconcile restored Research Board open claims with newly discovered workspace evidence before changing claim status.',
    ]
    : [];
  const nextActions = [
    ...resumeNextActions,
    'Review seed inventory and protocol labels for discovered result files.',
    'Map evidence files to manuscript claims before writing claims as supported.',
    'Ask ReviewerCat to verify the Research Board before manuscript acceptance.',
  ];
  const resumeRunRegistry = input.boardResume.restored
    ? [{
      run_id: 'board-restore',
      method: 'research-board-restore',
      split: 'workspace',
      seed: 'n/a',
      config: input.projectSlug,
      command: `auto_research_run --resume-board ${input.projectSlug}`,
      status: 'completed',
      log_path: boardJsonRel,
      output_path: input.manifestRel,
      manuscript_target: 'Research Board resume context',
      evidence: resumeEvidence,
    }]
    : [];
  const resumeStoryline = input.boardResume.restored
    ? `Existing Research Board restored (${formatBoardResumeSummary(input.boardResume)}); `
    : '';
  const phasePlanEvidence = [input.phasePlanRel, input.phasePlanMarkdownRel];
  const phaseExecutionEvidence = [input.phaseExecutionRel, input.phaseExecutionMarkdownRel];
  const reviewerHandoffEvidence = [input.reviewerHandoffPacketRel, input.reviewerHandoffPacketMarkdownRel];
  const phaseQueueEntries = input.phasePlan.phases
    .filter(phase => phase.phase_id !== 'phase_board_resume')
    .map(phase => ({
      id: phase.phase_id,
      text: `Phase plan ${phase.phase_id} recommends ${phase.recommended_skill}: ${phase.next_action}`,
      status: queueStatusFromPhaseStatus(phase.status),
      evidence: phase.evidence.length ? phase.evidence : phasePlanEvidence,
    }));
  const phaseExecutionQueueEntries = input.phaseExecution.executions.map(execution => ({
    id: execution.run_id,
    text: `Bounded execution ${execution.run_id} used ${execution.skill} policy in observation mode for ${execution.phase_id}: ${execution.next_action}`,
    status: queueStatusFromExecutionStatus(execution.status),
    evidence: execution.evidence.length ? execution.evidence : phaseExecutionEvidence,
  }));
  const phaseNextActions = input.phasePlan.phases
    .filter(phase => phase.status !== 'completed')
    .slice(0, 5)
    .map(phase => `Follow phase plan ${phase.phase_id}: ${phase.next_action}`);
  const phaseExecutionNextActions = input.phaseExecution.executions
    .filter(execution => execution.status !== 'completed')
    .slice(0, 6)
    .map(execution => `Resolve bounded execution ${execution.run_id}: ${execution.next_action}`);

  return {
    project: input.project,
    task_type: 'auto_research',
    goal: input.goal,
    current_storyline: `${resumeStoryline}Workspace intake found ${input.intakeFiles.length} candidate evidence files for ${input.focus}; phase-plan.json records skill recommendations and blocked phases; phase-execution.json records bounded non-mutating skill observations; reviewer-handoff.json packages ReviewerCat review checklist and blockers; claims remain in evidence-audit state until protocol, seed inventory, and ReviewerCat verification are complete.`,
    claim_board: [
      {
        claim: `Research goal "${input.focus}" needs evidence audit before manuscript sync.`,
        status: 'unsupported',
        evidence: evidenceSample,
      },
      ...(resultEvidence.length ? [{
        claim: 'Visible metric/log evidence can guide the next experiment review but is not submission-ready until seed inventory and protocol labels are verified.',
        status: 'weakly_supported',
        evidence: resultEvidence,
      }] : []),
    ],
    evidence_board: [
      ...resumeEvidenceBoard,
      {
        text: `Structured auto research phase plan generated with ${input.phasePlan.phases.length} phase(s), recommended ResearcherCat skills, blockers, and ReviewerCat handoff.`,
        status: 'weakly_supported',
        evidence: phasePlanEvidence,
      },
      {
        text: `Bounded phase execution generated with ${input.phaseExecution.executions.length} observation-mode execution record(s), skill findings, blockers, and ReviewerCat handoff.`,
        status: 'weakly_supported',
        evidence: phaseExecutionEvidence,
      },
      {
        text: `ReviewerCat handoff packet generated with ${input.reviewerHandoffPacket.review_checklist.length} review checklist item(s), ${input.reviewerHandoffPacket.blockers.length} blocker(s), and explicit no-final-acceptance boundary.`,
        status: 'weakly_supported',
        evidence: reviewerHandoffEvidence,
      },
      ...evidenceBoard,
    ],
    experiment_queue: [
      ...phaseQueueEntries,
      ...phaseExecutionQueueEntries,
      {
        text: resultEvidence.length
          ? 'Review seed inventory and protocol labels before manuscript sync.'
          : 'Locate experiment outputs, logs, or metric files before making result claims.',
        status: 'planned',
        evidence: experimentEvidence,
      },
      {
        text: 'Build claim-to-evidence map from discovered manuscript, review, and result files.',
        status: manuscriptPaths.length || reviewPaths.length ? 'planned' : 'blocked',
        evidence: uniqueStrings([...manuscriptPaths, ...reviewPaths, input.manifestRel]).slice(0, 6),
      },
    ],
    artifact_board: [
      {
        path: input.manifestRel,
        type: 'manifest',
        status: 'completed',
        evidence: evidenceSample,
        note: 'Auto research intake manifest with workspace-relative evidence paths.',
      },
      {
        path: input.reportRel,
        type: 'report',
        status: 'completed',
        evidence: [input.manifestRel],
        note: 'Human-readable auto research progress report.',
      },
      {
        path: input.phasePlanRel,
        type: 'phase_plan',
        status: 'completed',
        evidence: [input.manifestRel, input.reportRel],
        note: 'Structured phase plan with recommended ResearcherCat skill routing and blockers; not final acceptance.',
      },
      {
        path: input.phasePlanMarkdownRel,
        type: 'phase_plan_report',
        status: 'completed',
        evidence: [input.phasePlanRel],
        note: 'Human-readable phase plan for continued auto research and ReviewerCat review.',
      },
      {
        path: input.phaseExecutionRel,
        type: 'phase_execution',
        status: 'completed',
        evidence: [input.phasePlanRel, input.manifestRel],
        note: 'Structured bounded skill execution observations; non-mutating and not final acceptance.',
      },
      {
        path: input.phaseExecutionMarkdownRel,
        type: 'phase_execution_report',
        status: 'completed',
        evidence: [input.phaseExecutionRel],
        note: 'Human-readable bounded phase execution summary for ReviewerCat verification.',
      },
      {
        path: input.reviewerHandoffPacketRel,
        type: 'reviewer_handoff_packet',
        status: 'needs_review',
        evidence: [input.phaseExecutionRel, input.manifestRel],
        note: 'Structured ReviewerCat review packet; requires ReviewerCat closed/next_run/blocked decision and is not final acceptance.',
      },
      {
        path: input.reviewerHandoffPacketMarkdownRel,
        type: 'reviewer_handoff_report',
        status: 'needs_review',
        evidence: [input.reviewerHandoffPacketRel],
        note: 'Human-readable ReviewerCat review checklist, blocker list, and no-final-acceptance boundary.',
      },
      ...manuscriptPaths.slice(0, 3).map(filePath => ({
        path: filePath,
        type: 'manuscript',
        status: 'planned',
        evidence: [filePath],
        note: 'Candidate manuscript artifact discovered; requires evidence sync before claim update.',
      })),
      ...artifactPaths.slice(0, 6).map(filePath => ({
        path: filePath,
        type: artifactTypeForPath(filePath),
        status: 'planned',
        evidence: [filePath],
        note: 'Candidate delivery artifact discovered; requires version, compile/export, and ReviewerCat verification before delivery.',
      })),
    ],
    risk_board: [
      ...(input.boardResume.restored ? [{
        text: 'Restored Research Board state is prior context only; open claims, risks, and prior runs must be reconciled against current workspace evidence before manuscript changes.',
        status: input.boardResume.open_claims.length || input.boardResume.open_risks.length ? 'weakly_supported' : 'unknown',
        evidence: resumeEvidence,
      }] : []),
      {
        text: 'Workspace intake is discovery evidence only; unsupported claims must not be promoted without protocol and seed verification.',
        status: 'unsupported',
        evidence: [input.manifestRel, input.reportRel],
      },
      {
        text: resultEvidence.length
          ? 'Metric/log files need seed inventory, split labels, and target manuscript mapping before table updates.'
          : 'No metric/log files were found, so result claims are currently blocked.',
        status: resultEvidence.length ? 'weakly_supported' : 'blocked',
        evidence: experimentEvidence,
      },
      {
        text: 'Phase plan is a planning artifact only; bounded skill execution artifacts and ReviewerCat verification are still required before research acceptance.',
        status: 'unsupported',
        evidence: phasePlanEvidence,
      },
      {
        text: 'Bounded phase execution is non-mutating observation only; no manuscript edit, script run, compile/export, or final acceptance occurred.',
        status: 'weakly_supported',
        evidence: phaseExecutionEvidence,
      },
      {
        text: 'Reviewer handoff packet is a review input only; ResearcherCat has not produced a closed/next_run/blocked decision.',
        status: 'weakly_supported',
        evidence: reviewerHandoffEvidence,
      },
    ],
    handoffs: [
      {
        target_role: 'reviewer-cat',
        reason: 'Verify auto research board evidence, bounded skill execution observations, unsupported claims, seed inventory, artifact readiness, and reviewer-handoff packet before accepting conclusions.',
        status: 'planned',
        evidence: [input.manifestRel, input.reportRel, input.phasePlanRel, input.phaseExecutionRel, input.reviewerHandoffPacketRel],
      },
    ],
    next_actions: uniqueStrings([...nextActions, ...phaseNextActions, ...phaseExecutionNextActions]),
    run_registry: [
      ...resumeRunRegistry,
      {
        run_id: 'workspace-intake',
        method: 'workspace-intake',
        split: 'workspace',
        seed: 'n/a',
        config: input.workspaceRel,
        command: `auto_research_run --workspace ${input.workspaceRel}`,
        status: 'completed',
        log_path: input.manifestRel,
        output_path: input.reportRel,
        manuscript_target: 'Research Board intake',
        evidence: [input.manifestRel, input.reportRel],
      },
      {
        run_id: 'phase-plan',
        method: 'research-phase-planning',
        split: 'workspace',
        seed: 'n/a',
        config: input.projectSlug,
        command: `auto_research_run --phase-plan ${input.projectSlug}`,
        status: 'completed',
        log_path: input.phasePlanRel,
        output_path: input.phasePlanMarkdownRel,
        manuscript_target: 'Research phase plan',
        evidence: [input.manifestRel, input.phasePlanRel, input.phasePlanMarkdownRel],
      },
      {
        run_id: 'phase-execution',
        method: 'research-phase-execution',
        split: 'workspace',
        seed: 'n/a',
        config: input.projectSlug,
        command: `auto_research_run --phase-execution ${input.projectSlug}`,
        status: 'completed',
        log_path: input.phaseExecutionRel,
        output_path: input.phaseExecutionMarkdownRel,
        manuscript_target: 'Bounded research phase execution observations',
        evidence: [input.phasePlanRel, input.phaseExecutionRel, input.phaseExecutionMarkdownRel],
      },
      {
        run_id: 'reviewer-handoff-packet',
        method: 'reviewer-handoff-packaging',
        split: 'workspace',
        seed: 'n/a',
        config: input.projectSlug,
        command: `auto_research_run --reviewer-handoff ${input.projectSlug}`,
        status: 'completed',
        log_path: input.reviewerHandoffPacketRel,
        output_path: input.reviewerHandoffPacketMarkdownRel,
        manuscript_target: 'ReviewerCat review packet',
        evidence: [input.reviewerHandoffPacketRel, input.reviewerHandoffPacketMarkdownRel],
      },
    ],
    mode: 'merge',
  };
}

function buildResearchPhasePlan(input: {
  project: string;
  projectSlug: string;
  goal: string;
  focus: string;
  workspaceRel: string;
  generatedAt: string;
  categoryCounts: Record<string, number>;
  intakeFiles: IntakeFile[];
  boardResume: BoardResumeSummary;
  manifestRel: string;
  reportRel: string;
  phasePlanRel: string;
  phasePlanMarkdownRel: string;
}): ResearchPhasePlan {
  const manuscriptPaths = pathsByKind(input.intakeFiles, 'manuscript');
  const reviewPaths = pathsByKind(input.intakeFiles, 'review');
  const metricsPaths = pathsByKind(input.intakeFiles, 'metrics');
  const logPaths = pathsByKind(input.intakeFiles, 'log');
  const scriptPaths = pathsByKind(input.intakeFiles, 'script');
  const artifactPaths = pathsByKind(input.intakeFiles, 'artifact');
  const evidencePaths = input.intakeFiles.map(file => file.relative_path);
  const boardJsonRel = path.posix.join('data', 'researcher-cat', 'boards', input.projectSlug, 'board.json');
  const boardResumeEvidence = input.boardResume.restored ? [boardJsonRel, input.manifestRel] : [input.manifestRel];
  const resultEvidence = uniqueStrings([...metricsPaths, ...logPaths]);
  const manuscriptEvidence = uniqueStrings([...manuscriptPaths, ...reviewPaths]);
  const allPlanEvidence = uniqueStrings([
    input.manifestRel,
    input.reportRel,
    ...evidencePaths.slice(0, 8),
  ]);
  const phases: ResearchPhase[] = [];

  if (input.boardResume.restored) {
    phases.push({
      phase_id: 'phase_board_resume',
      title: 'Restore existing Research Board state',
      status: 'completed',
      reason: `Existing board restored before workspace intake: ${formatBoardResumeSummary(input.boardResume)}.`,
      recommended_skill: 'research-case-orchestrator',
      evidence: boardResumeEvidence,
      blocked_by: [],
      next_action: 'Reconcile restored open claims, risks, and prior runs against current workspace evidence.',
    });
  }

  phases.push({
    phase_id: 'phase_evidence_audit',
    title: 'Claim-to-evidence audit',
    status: evidencePaths.length ? 'planned' : 'blocked',
    reason: evidencePaths.length
      ? 'Workspace intake found candidate manuscript, review, result, log, script, or artifact files that need claim mapping.'
      : 'No candidate research evidence files were found in the bounded workspace intake.',
    recommended_skill: 'evidence-auditor',
    evidence: evidencePaths.length ? allPlanEvidence : [input.manifestRel],
    blocked_by: evidencePaths.length ? [] : ['No manuscript, review, result, log, script, or artifact candidates were discovered.'],
    next_action: 'Build a claim-to-evidence map and keep every unmapped claim unsupported.',
  });

  phases.push({
    phase_id: 'phase_experiment_review',
    title: 'Experiment result and protocol review',
    status: resultEvidence.length ? 'planned' : 'blocked',
    reason: resultEvidence.length
      ? 'Metric/log files are present and need seed inventory, split labels, and run registry review.'
      : 'No metric or log evidence was discovered, so result claims cannot advance.',
    recommended_skill: 'experiment-runner',
    evidence: resultEvidence.length ? uniqueStrings([...resultEvidence, input.manifestRel]) : [input.manifestRel],
    blocked_by: resultEvidence.length ? [] : ['Missing metric/log files for experiment review.'],
    next_action: resultEvidence.length
      ? 'Review seed inventory, split labels, command/config, and metric aggregation before manuscript sync.'
      : 'Locate or run bounded experiment outputs before making result claims.',
  });

  phases.push({
    phase_id: 'phase_manuscript_sync',
    title: 'Manuscript and review sync',
    status: manuscriptPaths.length ? 'planned' : 'blocked',
    reason: manuscriptPaths.length
      ? 'Candidate manuscript files exist and should be synced only after evidence audit and reviewer comment triage.'
      : 'No manuscript source was found, so manuscript sync is blocked.',
    recommended_skill: reviewPaths.length ? 'revision-planner' : 'manuscript-sync',
    evidence: manuscriptEvidence.length ? uniqueStrings([...manuscriptEvidence, input.manifestRel]) : [input.manifestRel],
    blocked_by: manuscriptPaths.length ? [] : ['Missing manuscript source file.'],
    next_action: reviewPaths.length
      ? 'Triage reviewer comments against manuscript sections and only queue edits backed by evidence.'
      : 'Map audited evidence to manuscript sections before editing text or tables.',
  });

  phases.push({
    phase_id: 'phase_delivery_readiness',
    title: 'PDF/PPT/figure delivery readiness',
    status: artifactPaths.length ? 'needs_review' : 'blocked',
    reason: artifactPaths.length
      ? 'Delivery artifacts were discovered, but they require version, compile/export, and visibility checks before delivery.'
      : 'No PDF, PPT, figure, or other delivery artifact was discovered.',
    recommended_skill: 'latex-compiler',
    evidence: artifactPaths.length ? uniqueStrings([...artifactPaths, input.manifestRel]) : [input.manifestRel],
    blocked_by: artifactPaths.length ? ['ReviewerCat has not verified artifact version, compile/export, and figure visibility.'] : ['Missing delivery artifact candidate.'],
    next_action: artifactPaths.length
      ? 'Verify artifact versions, compile/export logs, and figure/table visibility before any delivery claim.'
      : 'Generate or locate candidate PDF/PPT/figure artifacts after evidence and manuscript readiness are clear.',
  });

  if (scriptPaths.length) {
    phases.push({
      phase_id: 'phase_bounded_execution',
      title: 'Bounded script execution planning',
      status: 'planned',
      reason: 'Script candidates exist, but auto_research_run only plans bounded execution; it does not execute scripts in this intake step.',
      recommended_skill: 'experiment-runner',
      evidence: uniqueStrings([...scriptPaths, input.manifestRel]),
      blocked_by: ['Execution budget and ReviewerCat acceptance criteria must be explicit before running scripts.'],
      next_action: 'Prepare a bounded command plan with inputs, outputs, timeout, and expected scorecard before execution.',
    });
  }

  phases.push({
    phase_id: 'phase_reviewer_handoff',
    title: 'ReviewerCat verification handoff',
    status: 'planned',
    reason: 'ResearcherCat can organize evidence and next actions, but ReviewerCat owns closed/next_run/blocked decisions.',
    recommended_skill: 'research-case-orchestrator',
    evidence: uniqueStrings([input.manifestRel, input.reportRel, input.phasePlanRel]),
    blocked_by: ['ReviewerCat verification has not run yet.'],
    next_action: 'Ask ReviewerCat to verify board evidence, unsupported claims, artifact readiness, and remaining blockers.',
  });

  return {
    schema_version: 1,
    project: input.project,
    project_slug: input.projectSlug,
    goal: input.goal,
    focus: input.focus,
    workspace_path: input.workspaceRel,
    generated_at: input.generatedAt,
    status: 'needs_reviewer_verification',
    artifacts: {
      intake_manifest_path: input.manifestRel,
      intake_report_path: input.reportRel,
      phase_plan_path: input.phasePlanRel,
      phase_plan_markdown_path: input.phasePlanMarkdownRel,
    },
    category_counts: input.categoryCounts,
    board_resume: {
      restored: input.boardResume.restored,
      summary: formatBoardResumeSummary(input.boardResume),
      evidence: boardResumeEvidence,
    },
    phases,
    next_actions: phases
      .filter(phase => phase.status !== 'completed')
      .map(phase => phase.next_action),
    reviewer_handoff: {
      target_role: 'reviewer-cat',
      status: 'planned',
      reason: 'Verify phase plan, Research Board evidence, unsupported claims, artifact readiness, and blockers before acceptance.',
      evidence: uniqueStrings([input.manifestRel, input.reportRel, input.phasePlanRel]),
    },
  };
}

function buildResearchPhaseExecution(input: {
  project: string;
  projectSlug: string;
  goal: string;
  focus: string;
  workspaceRel: string;
  generatedAt: string;
  intakeFiles: IntakeFile[];
  manifestRel: string;
  reportRel: string;
  phasePlanRel: string;
  phasePlanMarkdownRel: string;
  phaseExecutionRel: string;
  phaseExecutionMarkdownRel: string;
}): ResearchPhaseExecution {
  const manuscriptPaths = pathsByKind(input.intakeFiles, 'manuscript');
  const reviewPaths = pathsByKind(input.intakeFiles, 'review');
  const metricsPaths = pathsByKind(input.intakeFiles, 'metrics');
  const logPaths = pathsByKind(input.intakeFiles, 'log');
  const scriptPaths = pathsByKind(input.intakeFiles, 'script');
  const artifactPaths = pathsByKind(input.intakeFiles, 'artifact');
  const evidencePaths = input.intakeFiles.map(file => file.relative_path);
  const resultEvidence = uniqueStrings([...metricsPaths, ...logPaths]);
  const manuscriptEvidence = uniqueStrings([...manuscriptPaths, ...reviewPaths]);
  const baseArtifacts = [
    input.manifestRel,
    input.reportRel,
    input.phasePlanRel,
    input.phasePlanMarkdownRel,
    input.phaseExecutionRel,
    input.phaseExecutionMarkdownRel,
  ];
  const executions: ResearchSkillExecution[] = [
    {
      run_id: 'exec_evidence_audit',
      phase_id: 'phase_evidence_audit',
      skill: 'evidence-auditor',
      status: evidencePaths.length ? 'completed' : 'blocked',
      objective: 'Create an initial claim-to-evidence observation map from bounded workspace candidates.',
      evidence: evidencePaths.length ? uniqueStrings([input.manifestRel, ...evidencePaths.slice(0, 10)]) : [input.manifestRel],
      outputs: [input.phaseExecutionRel],
      findings: evidencePaths.length
        ? [
          `Found ${evidencePaths.length} candidate evidence file(s) for claim mapping.`,
          'Unmapped or future manuscript claims must remain unsupported until ReviewerCat verification.',
        ]
        : ['No candidate evidence files were found in the bounded workspace intake.'],
      blockers: evidencePaths.length ? [] : ['Evidence audit cannot support claims without candidate evidence files.'],
      next_action: evidencePaths.length
        ? 'Map each manuscript claim to specific evidence refs and keep unsupported claims explicit.'
        : 'Add manuscript, review, result, log, script, or artifact evidence before advancing claims.',
    },
    {
      run_id: 'exec_experiment_review',
      phase_id: 'phase_experiment_review',
      skill: 'experiment-runner',
      status: resultEvidence.length ? 'completed' : 'blocked',
      objective: 'Review visible metric/log evidence for seed, split, protocol, and run-registry readiness.',
      evidence: resultEvidence.length ? uniqueStrings([input.manifestRel, ...resultEvidence]) : [input.manifestRel],
      outputs: [input.phaseExecutionRel],
      findings: resultEvidence.length
        ? [
          `Found ${metricsPaths.length} metric file(s) and ${logPaths.length} log file(s).`,
          'Seed inventory, split label, command/config, and manuscript target still require explicit verification.',
        ]
        : ['No metric or log evidence was available for experiment review.'],
      blockers: resultEvidence.length ? ['Seed inventory and protocol labels are not independently verified.'] : ['Missing metric/log files for experiment review.'],
      next_action: resultEvidence.length
        ? 'Verify seed inventory, split labels, command/config, and aggregation policy before manuscript sync.'
        : 'Locate or produce bounded experiment outputs before making result claims.',
    },
    {
      run_id: 'exec_manuscript_sync_readiness',
      phase_id: 'phase_manuscript_sync',
      skill: reviewPaths.length ? 'revision-planner' : 'manuscript-sync',
      status: manuscriptPaths.length ? 'completed' : 'blocked',
      objective: 'Assess manuscript/review sync readiness without editing manuscript files.',
      evidence: manuscriptEvidence.length ? uniqueStrings([input.manifestRel, ...manuscriptEvidence]) : [input.manifestRel],
      outputs: [input.phaseExecutionRel],
      findings: manuscriptPaths.length
        ? [
          `Found ${manuscriptPaths.length} manuscript candidate(s) and ${reviewPaths.length} review/comment candidate(s).`,
          'No manuscript edit was performed; sync remains gated by claim evidence and review triage.',
        ]
        : ['No manuscript source was found for sync readiness.'],
      blockers: manuscriptPaths.length ? ['Claim-to-evidence map and ReviewerCat verification are not complete.'] : ['Missing manuscript source file.'],
      next_action: reviewPaths.length
        ? 'Triage reviewer comments to manuscript sections and queue only evidence-backed edits.'
        : 'Map audited evidence to manuscript sections before editing text, tables, or claims.',
    },
    {
      run_id: 'exec_delivery_readiness',
      phase_id: 'phase_delivery_readiness',
      skill: 'latex-compiler',
      status: artifactPaths.length ? 'needs_review' : 'blocked',
      objective: 'Assess PDF/PPT/figure delivery readiness without compiling, exporting, or sending artifacts.',
      evidence: artifactPaths.length ? uniqueStrings([input.manifestRel, ...artifactPaths]) : [input.manifestRel],
      outputs: [input.phaseExecutionRel],
      findings: artifactPaths.length
        ? [
          `Found ${artifactPaths.length} delivery artifact candidate(s).`,
          'Artifact existence is not delivery acceptance; version, compile/export logs, figure visibility, and ReviewerCat verification are missing.',
        ]
        : ['No PDF, PPT, figure, or delivery artifact candidate was found.'],
      blockers: artifactPaths.length
        ? ['ReviewerCat has not verified artifact version, compile/export, and visibility checks.']
        : ['Missing delivery artifact candidate.'],
      next_action: artifactPaths.length
        ? 'Collect version notes, compile/export logs, and visual checks before any delivery claim.'
        : 'Generate or locate candidate delivery artifacts after evidence/manuscript readiness is clear.',
    },
    {
      run_id: 'exec_bounded_execution',
      phase_id: 'phase_bounded_execution',
      skill: 'experiment-runner',
      status: scriptPaths.length ? 'needs_review' : 'blocked',
      objective: 'Prepare bounded script execution readiness without running workspace scripts.',
      evidence: scriptPaths.length ? uniqueStrings([input.manifestRel, ...scriptPaths]) : [input.manifestRel],
      outputs: [input.phaseExecutionRel],
      findings: scriptPaths.length
        ? [
          `Found ${scriptPaths.length} script candidate(s).`,
          'No arbitrary command was executed; execution requires explicit timeout, inputs, outputs, and scorecard.',
        ]
        : ['No script candidates were found for bounded execution planning.'],
      blockers: scriptPaths.length
        ? ['Execution budget and ReviewerCat acceptance criteria must be explicit before running scripts.']
        : ['Missing script candidates for bounded execution planning.'],
      next_action: scriptPaths.length
        ? 'Prepare command plan with working directory, inputs, outputs, timeout, and expected scorecard before execution.'
        : 'Add or identify scripts only after the experiment objective and scorecard are clear.',
    },
    {
      run_id: 'exec_reviewer_handoff',
      phase_id: 'phase_reviewer_handoff',
      skill: 'research-case-orchestrator',
      status: 'completed',
      objective: 'Package auto research evidence for independent ReviewerCat verification.',
      evidence: uniqueStrings(baseArtifacts),
      outputs: [input.phaseExecutionRel, input.phaseExecutionMarkdownRel],
      findings: [
        'ReviewerCat handoff evidence is packaged, but ReviewerCat has not run a final semantic review.',
        'ResearcherCat must not mark the research accepted from its own execution artifacts.',
      ],
      blockers: ['ReviewerCat verification has not run yet.'],
      next_action: 'Ask ReviewerCat to verify board evidence, unsupported claims, artifact readiness, and execution blockers.',
    },
  ];

  return {
    schema_version: 1,
    project: input.project,
    project_slug: input.projectSlug,
    goal: input.goal,
    focus: input.focus,
    workspace_path: input.workspaceRel,
    generated_at: input.generatedAt,
    status: 'needs_reviewer_verification',
    phase_plan_path: input.phasePlanRel,
    artifacts: {
      intake_manifest_path: input.manifestRel,
      intake_report_path: input.reportRel,
      phase_plan_path: input.phasePlanRel,
      phase_plan_markdown_path: input.phasePlanMarkdownRel,
      phase_execution_path: input.phaseExecutionRel,
      phase_execution_markdown_path: input.phaseExecutionMarkdownRel,
    },
    executions,
    reviewer_handoff: {
      target_role: 'reviewer-cat',
      status: 'planned',
      reason: 'Verify bounded execution findings, unsupported claims, artifact readiness, and remaining blockers before acceptance.',
      evidence: uniqueStrings(baseArtifacts),
    },
  };
}

function buildReviewerHandoffPacket(input: {
  project: string;
  projectSlug: string;
  goal: string;
  focus: string;
  workspaceRel: string;
  generatedAt: string;
  intakeFiles: IntakeFile[];
  boardJsonRel: string;
  boardMarkdownRel: string;
  eventsJsonlRel: string;
  manifestRel: string;
  reportRel: string;
  phasePlanRel: string;
  phasePlanMarkdownRel: string;
  phaseExecutionRel: string;
  phaseExecutionMarkdownRel: string;
  reviewerHandoffPacketRel: string;
  reviewerHandoffPacketMarkdownRel: string;
  phaseExecution: ResearchPhaseExecution;
}): ResearchReviewerHandoffPacket {
  const manuscriptPaths = pathsByKind(input.intakeFiles, 'manuscript');
  const reviewPaths = pathsByKind(input.intakeFiles, 'review');
  const metricsPaths = pathsByKind(input.intakeFiles, 'metrics');
  const logPaths = pathsByKind(input.intakeFiles, 'log');
  const scriptPaths = pathsByKind(input.intakeFiles, 'script');
  const artifactPaths = pathsByKind(input.intakeFiles, 'artifact');
  const resultEvidence = uniqueStrings([...metricsPaths, ...logPaths]);
  const allEvidence = uniqueStrings(input.intakeFiles.map(file => file.relative_path));
  const baseEvidence = uniqueStrings([
    input.boardJsonRel,
    input.boardMarkdownRel,
    input.manifestRel,
    input.reportRel,
    input.phasePlanRel,
    input.phaseExecutionRel,
  ]);
  const blockers: ResearchReviewerHandoffPacket['blockers'] = [
    {
      id: 'reviewer_not_run',
      severity: 'high',
      text: 'ReviewerCat has not run an independent closed/next_run/blocked review.',
      evidence: [input.reviewerHandoffPacketRel, input.phaseExecutionRel],
    },
    {
      id: 'claims_not_fully_supported',
      severity: 'high',
      text: 'Research claims remain unsupported or weakly supported until claim-to-evidence mapping is reviewed.',
      evidence: allEvidence.length ? uniqueStrings([input.manifestRel, ...allEvidence.slice(0, 8)]) : [input.manifestRel],
    },
    {
      id: 'experiment_protocol_unverified',
      severity: resultEvidence.length ? 'medium' : 'high',
      text: resultEvidence.length
        ? 'Metric/log evidence exists, but seed inventory, split labels, command/config, and aggregation policy are not independently verified.'
        : 'No metric/log evidence was found for experiment review.',
      evidence: resultEvidence.length ? uniqueStrings([input.manifestRel, ...resultEvidence]) : [input.manifestRel],
    },
    {
      id: 'delivery_not_verified',
      severity: artifactPaths.length ? 'medium' : 'high',
      text: artifactPaths.length
        ? 'Delivery artifacts are candidates only; version, compile/export logs, visual checks, and ReviewerCat verification are missing.'
        : 'No delivery artifact candidate was found.',
      evidence: artifactPaths.length ? uniqueStrings([input.manifestRel, ...artifactPaths]) : [input.manifestRel],
    },
    {
      id: 'non_mutating_boundary',
      severity: 'medium',
      text: 'auto_research_run did not edit manuscripts, run scripts, compile/export delivery artifacts, or deliver files.',
      evidence: [input.phaseExecutionRel, input.phaseExecutionMarkdownRel],
    },
  ];

  if (scriptPaths.length > 0) {
    blockers.push({
      id: 'script_execution_requires_review',
      severity: 'medium',
      text: 'Script candidates require explicit timeout, inputs, outputs, and scorecard before execution.',
      evidence: uniqueStrings([input.manifestRel, ...scriptPaths]),
    });
  }

  return {
    schema_version: 1,
    project: input.project,
    project_slug: input.projectSlug,
    goal: input.goal,
    focus: input.focus,
    workspace_path: input.workspaceRel,
    generated_at: input.generatedAt,
    status: 'blocked_until_reviewer_verification',
    requested_reviewer: {
      target_role: 'reviewer-cat',
      decision_needed: 'closed_next_run_or_blocked',
      review_scope: [
        'Research Board state and event evidence',
        'Claim-to-evidence discipline',
        'Experiment protocol and seed inventory readiness',
        'Manuscript/reviewer-comment sync readiness',
        'PDF/PPT/figure delivery artifact readiness',
        'Non-mutating auto research boundary',
      ],
    },
    evidence_bundle: {
      board_json_path: input.boardJsonRel,
      board_markdown_path: input.boardMarkdownRel,
      events_jsonl_path: input.eventsJsonlRel,
      intake_manifest_path: input.manifestRel,
      intake_report_path: input.reportRel,
      phase_plan_path: input.phasePlanRel,
      phase_plan_markdown_path: input.phasePlanMarkdownRel,
      phase_execution_path: input.phaseExecutionRel,
      phase_execution_markdown_path: input.phaseExecutionMarkdownRel,
      reviewer_handoff_packet_path: input.reviewerHandoffPacketRel,
      reviewer_handoff_packet_markdown_path: input.reviewerHandoffPacketMarkdownRel,
    },
    readiness_summary: [
      {
        area: 'claim_evidence',
        status: allEvidence.length ? 'needs_review' : 'blocked',
        summary: allEvidence.length
          ? `${allEvidence.length} candidate evidence file(s) need claim mapping before support status can change.`
          : 'No candidate evidence files were found.',
        evidence: allEvidence.length ? uniqueStrings([input.manifestRel, ...allEvidence.slice(0, 8)]) : [input.manifestRel],
      },
      {
        area: 'experiment_protocol',
        status: resultEvidence.length ? 'needs_review' : 'blocked',
        summary: resultEvidence.length
          ? 'Metric/log candidates exist, but seed inventory, split labels, command/config, and aggregation policy need review.'
          : 'Experiment protocol review is blocked because metric/log evidence is missing.',
        evidence: resultEvidence.length ? uniqueStrings([input.manifestRel, ...resultEvidence]) : [input.manifestRel],
      },
      {
        area: 'manuscript_sync',
        status: manuscriptPaths.length ? 'needs_review' : 'blocked',
        summary: manuscriptPaths.length
          ? 'Manuscript sync can be reviewed after claim evidence and reviewer-comment triage are mapped.'
          : 'Manuscript sync is blocked because no manuscript source was found.',
        evidence: manuscriptPaths.length ? uniqueStrings([input.manifestRel, ...manuscriptPaths, ...reviewPaths]) : [input.manifestRel],
      },
      {
        area: 'delivery_artifacts',
        status: artifactPaths.length ? 'needs_review' : 'blocked',
        summary: artifactPaths.length
          ? 'Delivery artifacts are candidates only and need version, compile/export, visual checks, and ReviewerCat review.'
          : 'Delivery readiness is blocked because no PDF/PPT/figure artifact candidate was found.',
        evidence: artifactPaths.length ? uniqueStrings([input.manifestRel, ...artifactPaths]) : [input.manifestRel],
      },
      {
        area: 'phase_execution',
        status: 'needs_review',
        summary: `${input.phaseExecution.executions.length} bounded execution observation(s) were produced without mutating workspace state.`,
        evidence: [input.phaseExecutionRel, input.phaseExecutionMarkdownRel],
      },
    ],
    blockers,
    review_checklist: [
      {
        id: 'review_board_state',
        level: 'L4',
        reviewer_action: 'Open board.json and research-board.md, then verify project goal, claims, risks, next actions, and run registry are coherent.',
        required_evidence: [input.boardJsonRel, input.boardMarkdownRel, input.eventsJsonlRel],
      },
      {
        id: 'review_claim_evidence',
        level: 'L5',
        reviewer_action: 'Reject any supported claim that lacks concrete manuscript/result/log/review evidence refs.',
        required_evidence: uniqueStrings([input.manifestRel, ...allEvidence.slice(0, 10)]),
      },
      {
        id: 'review_experiment_protocol',
        level: 'L5',
        reviewer_action: 'Verify seed inventory, split labels, command/config, metric aggregation, and manuscript target before allowing result claims.',
        required_evidence: resultEvidence.length ? uniqueStrings([input.manifestRel, ...resultEvidence]) : [input.manifestRel],
      },
      {
        id: 'review_delivery_readiness',
        level: 'L5',
        reviewer_action: 'Verify artifact version notes, compile/export logs, visual checks, and delivery path before any sendable package claim.',
        required_evidence: artifactPaths.length ? uniqueStrings([input.manifestRel, ...artifactPaths]) : [input.manifestRel],
      },
      {
        id: 'review_non_mutating_boundary',
        level: 'L4',
        reviewer_action: 'Confirm auto_research_run did not run scripts, edit manuscript files, compile/export artifacts, send files, or self-approve.',
        required_evidence: [input.phaseExecutionRel, input.phaseExecutionMarkdownRel],
      },
    ],
    acceptance_boundary: {
      researcher_decision: 'no_final_acceptance',
      reviewer_decision_required: true,
      forbidden_researcher_claims: [
        'ResearcherCat may not mark this review closed.',
        'ResearcherCat may not mark delivery artifacts verified.',
        'ResearcherCat may not promote unsupported claims to supported without ReviewerCat evidence review.',
      ],
    },
  };
}

function renderPhasePlanMarkdown(plan: ResearchPhasePlan): string {
  const lines = [
    '# Auto Research Phase Plan',
    '',
    `Project: ${plan.project}`,
    `Goal: ${plan.goal}`,
    `Focus: ${plan.focus}`,
    `Workspace: ${plan.workspace_path}`,
    `Generated: ${plan.generated_at}`,
    `Status: ${plan.status}`,
    '',
    '## Artifacts',
    `- Intake manifest: ${plan.artifacts.intake_manifest_path}`,
    `- Intake report: ${plan.artifacts.intake_report_path}`,
    `- Phase plan JSON: ${plan.artifacts.phase_plan_path}`,
    '',
    '## Board Resume',
    `- restored: ${plan.board_resume.restored}`,
    `- summary: ${plan.board_resume.summary}`,
    `- evidence: ${plan.board_resume.evidence.join('; ') || 'none'}`,
    '',
    '## Phases',
    ...plan.phases.flatMap(phase => [
      `- [${phase.status}] ${phase.phase_id}: ${phase.title}`,
      `  - recommended skill: ${phase.recommended_skill}`,
      `  - reason: ${phase.reason}`,
      `  - evidence: ${phase.evidence.join('; ') || 'none'}`,
      `  - blocked by: ${phase.blocked_by.join('; ') || 'none'}`,
      `  - next action: ${phase.next_action}`,
    ]),
    '',
    '## ReviewerCat Handoff',
    `- [${plan.reviewer_handoff.status}] ${plan.reviewer_handoff.target_role}: ${plan.reviewer_handoff.reason}`,
    `- evidence: ${plan.reviewer_handoff.evidence.join('; ')}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function renderPhaseExecutionMarkdown(execution: ResearchPhaseExecution): string {
  const lines = [
    '# Auto Research Phase Execution',
    '',
    `Project: ${execution.project}`,
    `Goal: ${execution.goal}`,
    `Focus: ${execution.focus}`,
    `Workspace: ${execution.workspace_path}`,
    `Generated: ${execution.generated_at}`,
    `Status: ${execution.status}`,
    '',
    '## Artifacts',
    `- Intake manifest: ${execution.artifacts.intake_manifest_path}`,
    `- Intake report: ${execution.artifacts.intake_report_path}`,
    `- Phase plan JSON: ${execution.artifacts.phase_plan_path}`,
    `- Phase plan report: ${execution.artifacts.phase_plan_markdown_path}`,
    `- Phase execution JSON: ${execution.artifacts.phase_execution_path}`,
    `- Phase execution report: ${execution.artifacts.phase_execution_markdown_path}`,
    '',
    '## Execution Records',
    ...execution.executions.flatMap(item => [
      `- [${item.status}] ${item.run_id}: ${item.skill} for ${item.phase_id}`,
      `  - objective: ${item.objective}`,
      `  - evidence: ${item.evidence.join('; ') || 'none'}`,
      `  - outputs: ${item.outputs.join('; ') || 'none'}`,
      `  - findings: ${item.findings.join('; ') || 'none'}`,
      `  - blockers: ${item.blockers.join('; ') || 'none'}`,
      `  - next action: ${item.next_action}`,
    ]),
    '',
    '## Non-Mutating Boundary',
    '- No manuscript edit was performed.',
    '- No workspace script was executed.',
    '- No PDF/PPT compile, export, or delivery was performed.',
    '- ReviewerCat verification is still required before acceptance.',
    '',
    '## ReviewerCat Handoff',
    `- [${execution.reviewer_handoff.status}] ${execution.reviewer_handoff.target_role}: ${execution.reviewer_handoff.reason}`,
    `- evidence: ${execution.reviewer_handoff.evidence.join('; ')}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function renderReviewerHandoffMarkdown(packet: ResearchReviewerHandoffPacket): string {
  const lines = [
    '# ReviewerCat Handoff Packet',
    '',
    `Project: ${packet.project}`,
    `Goal: ${packet.goal}`,
    `Focus: ${packet.focus}`,
    `Workspace: ${packet.workspace_path}`,
    `Generated: ${packet.generated_at}`,
    `Status: ${packet.status}`,
    '',
    '## Requested Reviewer',
    `- target role: ${packet.requested_reviewer.target_role}`,
    `- decision needed: ${packet.requested_reviewer.decision_needed}`,
    ...packet.requested_reviewer.review_scope.map(item => `- scope: ${item}`),
    '',
    '## Evidence Bundle',
    ...Object.entries(packet.evidence_bundle).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Readiness Summary',
    ...packet.readiness_summary.flatMap(item => [
      `- [${item.status}] ${item.area}: ${item.summary}`,
      `  - evidence: ${item.evidence.join('; ') || 'none'}`,
    ]),
    '',
    '## Blockers',
    ...packet.blockers.flatMap(item => [
      `- [${item.severity}] ${item.id}: ${item.text}`,
      `  - evidence: ${item.evidence.join('; ') || 'none'}`,
    ]),
    '',
    '## Review Checklist',
    ...packet.review_checklist.flatMap(item => [
      `- [${item.level}] ${item.id}: ${item.reviewer_action}`,
      `  - required evidence: ${item.required_evidence.join('; ') || 'none'}`,
    ]),
    '',
    '## Acceptance Boundary',
    `- researcher decision: ${packet.acceptance_boundary.researcher_decision}`,
    `- reviewer decision required: ${packet.acceptance_boundary.reviewer_decision_required}`,
    ...packet.acceptance_boundary.forbidden_researcher_claims.map(item => `- forbidden ResearcherCat claim: ${item}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function queueStatusFromPhaseStatus(status: ResearchPhaseStatus): 'completed' | 'planned' | 'blocked' {
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'planned';
}

function queueStatusFromExecutionStatus(status: ResearchSkillExecutionStatus): 'completed' | 'planned' | 'blocked' {
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'planned';
}

function readExistingBoard(store: ResearchBoardStore, project: string): ResearchBoard | undefined {
  try {
    return store.read(project, { includeEvents: false }).board;
  } catch {
    return undefined;
  }
}

function summarizeExistingBoard(board: ResearchBoard | undefined, projectSlug: string): BoardResumeSummary {
  if (!board) {
    return {
      restored: false,
      project_slug: projectSlug,
      counts: {
        claims: 0,
        evidence: 0,
        experiments: 0,
        artifacts: 0,
        risks: 0,
        handoffs: 0,
        next_actions: 0,
        runs: 0,
      },
      open_claims: [],
      open_risks: [],
      pending_next_actions: [],
      previous_runs: [],
      handoff_roles: [],
    };
  }

  return {
    restored: true,
    project_slug: board.project_slug || projectSlug,
    updated_at: board.updated_at,
    counts: {
      claims: board.claim_board.length,
      evidence: board.evidence_board.length,
      experiments: board.experiment_queue.length,
      artifacts: board.artifact_board.length,
      risks: board.risk_board.length,
      handoffs: board.handoffs.length,
      next_actions: board.next_actions.length,
      runs: board.run_registry.length,
    },
    open_claims: board.claim_board
      .filter(item => isOpenResearchStatus(item.status))
      .slice(0, 6)
      .map(item => ({
        id: item.id,
        claim: item.claim,
        status: item.status,
        evidence_count: item.evidence.length,
      })),
    open_risks: board.risk_board
      .filter(item => isOpenResearchStatus(String(item.status ?? 'unknown')))
      .slice(0, 6)
      .map(item => ({
        id: item.id,
        text: item.text,
        status: String(item.status ?? 'unknown'),
        evidence_count: item.evidence.length,
      })),
    pending_next_actions: board.next_actions
      .filter(item => isPendingQueueStatus(String(item.status ?? 'planned')))
      .slice(0, 6)
      .map(item => ({
        id: item.id,
        text: item.text,
        status: String(item.status ?? 'planned'),
        evidence_count: item.evidence.length,
      })),
    previous_runs: board.run_registry
      .slice(-8)
      .map(item => ({
        id: item.id,
        status: item.status,
        ...(item.output_path ? { output_path: item.output_path } : {}),
        ...(item.log_path ? { log_path: item.log_path } : {}),
      })),
    handoff_roles: uniqueStrings(board.handoffs.map(item => item.target_role)),
  };
}

function formatBoardResumeSummary(summary: BoardResumeSummary): string {
  if (!summary.restored) {
    return 'no existing Research Board found';
  }
  return [
    `${summary.open_claims.length} open claim(s)`,
    `${summary.open_risks.length} open risk(s)`,
    `${summary.pending_next_actions.length} pending next action(s)`,
    `${summary.previous_runs.length} prior run(s)`,
    summary.handoff_roles.length ? `handoff roles: ${summary.handoff_roles.join(', ')}` : 'no handoff roles',
  ].join(', ');
}

function isOpenResearchStatus(status: string): boolean {
  return ['unknown', 'unsupported', 'weakly_supported', 'contradicted', 'blocked', 'running', 'planned', 'failed'].includes(status);
}

function isPendingQueueStatus(status: string): boolean {
  return ['unknown', 'planned', 'running', 'blocked', 'failed'].includes(status);
}

function scanWorkspace(rootDir: string, workspaceDir: string, options: { maxFiles: number; maxFileBytes: number }): IntakeFile[] {
  const files: IntakeFile[] = [];

  const visit = (currentDir: string, depth: number): void => {
    if (files.length >= options.maxFiles || depth > MAX_SCAN_DEPTH) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= options.maxFiles) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const relativeDir = toRelativePath(rootDir, fullPath);
        if (!EXCLUDED_DIRS.has(entry.name) && relativeDir !== 'logs/sessions' && !relativeDir.startsWith('logs/sessions/')) {
          visit(fullPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || !isCandidateFile(entry.name)) {
        continue;
      }
      const isText = isCandidateTextFile(entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (isText && stat.size > options.maxFileBytes) {
        continue;
      }
      if (!isText && stat.size > DEFAULT_MAX_ARTIFACT_BYTES) {
        continue;
      }
      const relativePath = toRelativePath(rootDir, fullPath);
      if (!relativePath || relativePath.startsWith('data/researcher-cat/') || relativePath.startsWith('output/researcher-cat/')) {
        continue;
      }
      const text = isText ? safeReadSmallText(fullPath, Math.min(stat.size, 4096)) : '';
      files.push({
        relative_path: relativePath,
        bytes: stat.size,
        kind: classifyFile(relativePath, text),
        signals: detectSignals(relativePath, text),
      });
    }
  };

  visit(workspaceDir, 0);
  return files;
}

function renderIntakeReport(manifest: {
  project: string;
  goal: string;
  focus: string;
  workspace_path: string;
  generated_at: string;
  category_counts: Record<string, number>;
  board_resume: BoardResumeSummary;
  phase_plan_path: string;
  phase_plan_markdown_path: string;
  phase_execution_path: string;
  phase_execution_markdown_path: string;
  reviewer_handoff_packet_path: string;
  reviewer_handoff_packet_markdown_path: string;
  files: IntakeFile[];
}, phasePlan: ResearchPhasePlan, phaseExecution: ResearchPhaseExecution, reviewerHandoffPacket: ResearchReviewerHandoffPacket): string {
  const lines = [
    '# Auto Research Intake Report',
    '',
    `Project: ${manifest.project}`,
    `Goal: ${manifest.goal}`,
    `Focus: ${manifest.focus}`,
    `Workspace: ${manifest.workspace_path}`,
    `Generated: ${manifest.generated_at}`,
    '',
    '## Workspace Intake Summary',
    `Discovered ${manifest.files.length} candidate evidence files. This report is an intake artifact; it does not mark research claims as accepted.`,
    '',
    '## Board Resume Summary',
    manifest.board_resume.restored
      ? `Restored existing Research Board updated at ${manifest.board_resume.updated_at || 'unknown'} with ${formatBoardResumeSummary(manifest.board_resume)}.`
      : 'No existing Research Board was found for this project; this run starts a new board state.',
    ...(manifest.board_resume.open_claims.length ? [
      '',
      'Open claims from restored board:',
      ...manifest.board_resume.open_claims.map(item => `- [${item.status}] ${item.claim} (evidence refs: ${item.evidence_count})`),
    ] : []),
    ...(manifest.board_resume.pending_next_actions.length ? [
      '',
      'Pending next actions from restored board:',
      ...manifest.board_resume.pending_next_actions.map(item => `- [${item.status}] ${item.text}`),
    ] : []),
    '',
    '## Phase Plan Summary',
    `Structured phase plan: ${manifest.phase_plan_path}`,
    `Human-readable phase plan: ${manifest.phase_plan_markdown_path}`,
    `Status: ${phasePlan.status}`,
    ...phasePlan.phases.map(phase => `- [${phase.status}] ${phase.phase_id}: ${phase.recommended_skill} -> ${phase.next_action}`),
    '',
    '## Bounded Phase Execution Summary',
    `Structured phase execution: ${manifest.phase_execution_path}`,
    `Human-readable phase execution: ${manifest.phase_execution_markdown_path}`,
    `Status: ${phaseExecution.status}`,
    ...phaseExecution.executions.map(execution => `- [${execution.status}] ${execution.run_id}: ${execution.skill} -> ${execution.next_action}`),
    '',
    'Non-mutating boundary: no manuscript edit, script run, compile/export, delivery, or final acceptance was performed.',
    '',
    '## ReviewerCat Handoff Packet',
    `Structured handoff packet: ${manifest.reviewer_handoff_packet_path}`,
    `Human-readable handoff packet: ${manifest.reviewer_handoff_packet_markdown_path}`,
    `Status: ${reviewerHandoffPacket.status}`,
    `Checklist items: ${reviewerHandoffPacket.review_checklist.length}`,
    `Blockers: ${reviewerHandoffPacket.blockers.length}`,
    `Decision needed: ${reviewerHandoffPacket.requested_reviewer.decision_needed}`,
    '',
    '## Category Counts',
    ...Object.entries(manifest.category_counts).map(([kind, count]) => `- ${kind}: ${count}`),
    '',
    '## Discovered Evidence',
    ...(manifest.files.length ? manifest.files.map(file => `- [${file.kind}] ${file.relative_path} (${file.bytes} bytes; signals: ${file.signals.join(', ') || 'none'})`) : ['- No candidate evidence files discovered.']),
    '',
    '## Required Follow-Up',
    '- Review seed inventory and protocol labels before manuscript sync.',
    '- Map every manuscript claim to evidence before changing claim status.',
    '- Ask ReviewerCat to verify unsupported claims, artifact readiness, and remaining risks.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function resolveWorkspacePath(rootDir: string, input?: string): string {
  const candidate = path.resolve(rootDir, readString(input, '.'));
  const relative = path.relative(rootDir, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`workspace_path must stay inside the current working directory: ${input}`);
  }
  return candidate;
}

function isCandidateTextFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function isCandidateFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ARTIFACT_EXTENSIONS.has(ext);
}

function classifyFile(relativePath: string, text: string): IntakeFileKind {
  const lowerPath = relativePath.toLowerCase();
  const lowerText = text.toLowerCase();
  if (ARTIFACT_EXTENSIONS.has(path.extname(lowerPath))) {
    return 'artifact';
  }
  if (/review|rebuttal|response|comment/.test(lowerPath) || /reviewer|rebuttal|major revision|minor revision/.test(lowerText)) {
    return 'review';
  }
  if (lowerPath.endsWith('.log') || /(^|\/)logs?\//.test(lowerPath) || /traceback|error|epoch|completed|failed/.test(lowerText)) {
    return 'log';
  }
  if (/\.(tex|bib|md|rst)$/.test(lowerPath) || /manuscript|paper|draft|abstract|introduction|method/.test(lowerPath)) {
    return 'manuscript';
  }
  if (/result|metric|score|eval|table|f1|accuracy|auc/.test(lowerPath) || /"f1"|f1|accuracy|auc|precision|recall|seed/.test(lowerText)) {
    return 'metrics';
  }
  if (/\.(py|r|sh)$/.test(lowerPath) || /script|train|evaluate|baseline/.test(lowerPath)) {
    return 'script';
  }
  if (/figure|table|ppt|pdf|artifact|asset/.test(lowerPath)) {
    return 'artifact';
  }
  return 'note';
}

function detectSignals(relativePath: string, text: string): string[] {
  const joined = `${relativePath}\n${text}`.toLowerCase();
  const signals: string[] = [];
  if (/manuscript|paper|abstract|introduction|method|conclusion/.test(joined)) signals.push('manuscript_candidate');
  if (/reviewer|rebuttal|response|major revision|minor revision/.test(joined)) signals.push('review_signal');
  if (/metric|result|f1|accuracy|auc|precision|recall/.test(joined)) signals.push('metric_signal');
  if (/seed|split|year-out|random split|baseline/.test(joined)) signals.push('protocol_signal');
  if (/error|failed|traceback|timeout|exception/.test(joined)) signals.push('runtime_or_run_risk');
  if (/figure|table|pdf|ppt|artifact/.test(joined)) signals.push('artifact_signal');
  if (ARTIFACT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) signals.push('delivery_artifact');
  return uniqueStrings(signals);
}

function artifactTypeForPath(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.ppt' || ext === '.pptx') return 'slides';
  if (['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(ext)) return 'figure';
  return 'artifact';
}

function safeReadSmallText(filePath: string, maxBytes: number): string {
  try {
    const buffer = fs.readFileSync(filePath);
    return buffer.subarray(0, maxBytes).toString('utf-8');
  } catch {
    return '';
  }
}

function countByKind(files: IntakeFile[]): Record<string, number> {
  const counts: Record<string, number> = {
    manuscript: 0,
    review: 0,
    metrics: 0,
    log: 0,
    script: 0,
    artifact: 0,
    note: 0,
  };
  for (const file of files) {
    counts[file.kind] = (counts[file.kind] ?? 0) + 1;
  }
  return counts;
}

function pathsByKind(files: IntakeFile[], kind: IntakeFileKind): string[] {
  return files.filter(file => file.kind === kind).map(file => file.relative_path);
}

function toRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function readString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  return normalized || DEFAULT_PROJECT;
}
