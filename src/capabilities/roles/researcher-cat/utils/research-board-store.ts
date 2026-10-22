import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export type ResearchEvidenceStatus =
  | 'unknown'
  | 'unsupported'
  | 'weakly_supported'
  | 'supported'
  | 'contradicted'
  | 'blocked';

export type ResearchQueueStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'unknown';

export interface ResearchBoardClaim {
  id: string;
  claim: string;
  status: ResearchEvidenceStatus;
  evidence: string[];
  updated_at: string;
}

export interface ResearchBoardEntry {
  id: string;
  text: string;
  status?: ResearchEvidenceStatus | ResearchQueueStatus;
  evidence: string[];
  updated_at: string;
}

export interface ResearchBoardArtifact {
  id: string;
  path: string;
  type?: string;
  status: ResearchQueueStatus;
  evidence: string[];
  note?: string;
  original_path_hash?: string;
  updated_at: string;
}

export interface ResearchBoardHandoff {
  id: string;
  target_role: string;
  reason: string;
  status: ResearchQueueStatus;
  evidence: string[];
  updated_at: string;
}

export interface ResearchBoardRun {
  id: string;
  method?: string;
  split?: string;
  seed?: string;
  config?: string;
  command?: string;
  status: ResearchQueueStatus;
  log_path?: string;
  output_path?: string;
  manuscript_target?: string;
  evidence: string[];
  updated_at: string;
}

export interface ResearchBoard {
  schema_version: 1;
  project: string;
  project_slug: string;
  created_at: string;
  updated_at: string;
  project_goal: string;
  current_storyline: string;
  active_task_type: string;
  claim_board: ResearchBoardClaim[];
  evidence_board: ResearchBoardEntry[];
  experiment_queue: ResearchBoardEntry[];
  artifact_board: ResearchBoardArtifact[];
  risk_board: ResearchBoardEntry[];
  handoffs: ResearchBoardHandoff[];
  next_actions: ResearchBoardEntry[];
  run_registry: ResearchBoardRun[];
}

export interface ResearchBoardUpdateInput {
  project: string;
  task_type?: string;
  goal?: string;
  current_storyline?: string;
  claim_board?: unknown;
  evidence_board?: unknown;
  experiment_queue?: unknown;
  artifact_board?: unknown;
  risk_board?: unknown;
  handoff?: unknown;
  handoffs?: unknown;
  next_actions?: unknown;
  run_registry?: unknown;
  mode?: 'merge' | 'replace_sections';
}

export interface ResearchBoardPaths {
  dataDir: string;
  outputDir: string;
  boardJsonPath: string;
  boardMarkdownPath: string;
  eventsJsonlPath: string;
}

export interface ResearchBoardUpdateResult {
  ok: true;
  project: string;
  project_slug: string;
  board_json_path: string;
  board_markdown_path: string;
  events_jsonl_path: string;
  updated_sections: string[];
  counts: Record<string, number>;
}

export interface ResearchBoardReadResult {
  ok: true;
  board: ResearchBoard;
  board_json_path: string;
  board_markdown_path: string;
  events_jsonl_path: string;
  markdown: string;
  recent_events?: unknown[];
}

export interface ResearchBoardListResult {
  ok: true;
  boards: Array<{
    project: string;
    project_slug: string;
    updated_at: string;
    board_json_path: string;
    board_markdown_path: string;
  }>;
}

const DEFAULT_PROJECT = 'default-research-project';
const UNKNOWN_STATUS: ResearchEvidenceStatus = 'unknown';
const DEFAULT_ENTRY_STATUS: ResearchEvidenceStatus = 'unknown';
const DEFAULT_ARTIFACT_STATUS: ResearchQueueStatus = 'planned';
const DEFAULT_HANDOFF_STATUS: ResearchQueueStatus = 'planned';
const DEFAULT_RUN_STATUS: ResearchQueueStatus = 'unknown';

export class ResearchBoardStore {
  constructor(private readonly rootDir: string) {}

  getPaths(project: string): ResearchBoardPaths {
    const slug = safeSegment(project || DEFAULT_PROJECT);
    const dataDir = path.join(this.rootDir, 'data', 'researcher-cat', 'boards', slug);
    const outputDir = path.join(this.rootDir, 'output', 'researcher-cat', 'boards', slug);
    return {
      dataDir,
      outputDir,
      boardJsonPath: path.join(dataDir, 'board.json'),
      boardMarkdownPath: path.join(outputDir, 'research-board.md'),
      eventsJsonlPath: path.join(dataDir, 'events.jsonl'),
    };
  }

  update(input: ResearchBoardUpdateInput): ResearchBoardUpdateResult {
    const project = readString(input.project, DEFAULT_PROJECT);
    const slug = safeSegment(project);
    const now = new Date().toISOString();
    const paths = this.getPaths(project);
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.mkdirSync(paths.outputDir, { recursive: true });

    const existing = this.readBoardIfExists(paths.boardJsonPath);
    const board: ResearchBoard = existing ?? createEmptyBoard(project, slug, now);
    board.updated_at = now;
    board.project = project;
    board.project_slug = slug;

    const updatedSections: string[] = [];
    if (typeof input.goal === 'string' && input.goal.trim()) {
      board.project_goal = input.goal.trim();
      updatedSections.push('project_goal');
    }
    if (typeof input.current_storyline === 'string' && input.current_storyline.trim()) {
      board.current_storyline = input.current_storyline.trim();
      updatedSections.push('current_storyline');
    }
    if (typeof input.task_type === 'string' && input.task_type.trim()) {
      board.active_task_type = input.task_type.trim();
      updatedSections.push('active_task_type');
    }

    const replace = input.mode === 'replace_sections';
    if (input.claim_board !== undefined) {
      board.claim_board = mergeById(
        replace ? [] : board.claim_board,
        normalizeClaims(input.claim_board, now),
      );
      updatedSections.push('claim_board');
    }
    if (input.evidence_board !== undefined) {
      board.evidence_board = mergeById(
        replace ? [] : board.evidence_board,
        normalizeEntries(input.evidence_board, now),
      );
      updatedSections.push('evidence_board');
    }
    if (input.experiment_queue !== undefined) {
      board.experiment_queue = mergeById(
        replace ? [] : board.experiment_queue,
        normalizeEntries(input.experiment_queue, now),
      );
      updatedSections.push('experiment_queue');
    }
    if (input.artifact_board !== undefined) {
      board.artifact_board = mergeById(
        replace ? [] : board.artifact_board,
        normalizeArtifacts(input.artifact_board, now),
      );
      updatedSections.push('artifact_board');
    }
    if (input.risk_board !== undefined) {
      board.risk_board = mergeById(
        replace ? [] : board.risk_board,
        normalizeEntries(input.risk_board, now),
      );
      updatedSections.push('risk_board');
    }
    const handoffInput = input.handoffs !== undefined ? input.handoffs : input.handoff;
    if (handoffInput !== undefined) {
      board.handoffs = mergeById(
        replace ? [] : board.handoffs,
        normalizeHandoffs(handoffInput, now),
      );
      updatedSections.push('handoffs');
    }
    if (input.next_actions !== undefined) {
      board.next_actions = mergeById(
        replace ? [] : board.next_actions,
        normalizeEntries(input.next_actions, now, 'planned'),
      );
      updatedSections.push('next_actions');
    }
    if (input.run_registry !== undefined) {
      board.run_registry = mergeById(
        replace ? [] : board.run_registry,
        normalizeRuns(input.run_registry, now),
      );
      updatedSections.push('run_registry');
    }

    writeJson(paths.boardJsonPath, board);
    const markdown = renderBoardMarkdown(board);
    fs.writeFileSync(paths.boardMarkdownPath, markdown, 'utf-8');
    appendJsonl(paths.eventsJsonlPath, {
      schema_version: 1,
      event_type: 'research_board_update',
      at: now,
      project,
      project_slug: slug,
      updated_sections: updatedSections,
      counts: buildCounts(board),
    });

    return {
      ok: true,
      project,
      project_slug: slug,
      board_json_path: paths.boardJsonPath,
      board_markdown_path: paths.boardMarkdownPath,
      events_jsonl_path: paths.eventsJsonlPath,
      updated_sections: Array.from(new Set(updatedSections)),
      counts: buildCounts(board),
    };
  }

  read(project: string, options: { includeEvents?: boolean; maxEvents?: number } = {}): ResearchBoardReadResult {
    const paths = this.getPaths(project);
    const board = this.readBoardIfExists(paths.boardJsonPath);
    if (!board) {
      throw new Error(`Research Board not found for project "${project}"`);
    }
    const markdown = fs.existsSync(paths.boardMarkdownPath)
      ? fs.readFileSync(paths.boardMarkdownPath, 'utf-8')
      : renderBoardMarkdown(board);
    const result: ResearchBoardReadResult = {
      ok: true,
      board,
      board_json_path: paths.boardJsonPath,
      board_markdown_path: paths.boardMarkdownPath,
      events_jsonl_path: paths.eventsJsonlPath,
      markdown,
    };
    if (options.includeEvents) {
      result.recent_events = readRecentJsonl(paths.eventsJsonlPath, options.maxEvents ?? 20);
    }
    return result;
  }

  list(): ResearchBoardListResult {
    const root = path.join(this.rootDir, 'data', 'researcher-cat', 'boards');
    if (!fs.existsSync(root)) {
      return { ok: true, boards: [] };
    }
    const boards = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const boardJsonPath = path.join(root, entry.name, 'board.json');
        const board = this.readBoardIfExists(boardJsonPath);
        if (!board) {
          return undefined;
        }
        const paths = this.getPaths(board.project);
        return {
          project: board.project,
          project_slug: board.project_slug,
          updated_at: board.updated_at,
          board_json_path: paths.boardJsonPath,
          board_markdown_path: paths.boardMarkdownPath,
        };
      })
      .filter((value): value is NonNullable<typeof value> => !!value)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { ok: true, boards };
  }

  private readBoardIfExists(boardJsonPath: string): ResearchBoard | undefined {
    if (!fs.existsSync(boardJsonPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(boardJsonPath, 'utf-8'));
    return normalizeExistingBoard(parsed);
  }
}

function createEmptyBoard(project: string, slug: string, now: string): ResearchBoard {
  return {
    schema_version: 1,
    project,
    project_slug: slug,
    created_at: now,
    updated_at: now,
    project_goal: '',
    current_storyline: '',
    active_task_type: '',
    claim_board: [],
    evidence_board: [],
    experiment_queue: [],
    artifact_board: [],
    risk_board: [],
    handoffs: [],
    next_actions: [],
    run_registry: [],
  };
}

function normalizeExistingBoard(value: any): ResearchBoard {
  const now = new Date().toISOString();
  const project = readString(value?.project, DEFAULT_PROJECT);
  const slug = safeSegment(readString(value?.project_slug, project));
  return {
    schema_version: 1,
    project,
    project_slug: slug,
    created_at: readString(value?.created_at, now),
    updated_at: readString(value?.updated_at, now),
    project_goal: readString(value?.project_goal, ''),
    current_storyline: readString(value?.current_storyline, ''),
    active_task_type: readString(value?.active_task_type, ''),
    claim_board: normalizeClaims(value?.claim_board ?? [], now),
    evidence_board: normalizeEntries(value?.evidence_board ?? [], now),
    experiment_queue: normalizeEntries(value?.experiment_queue ?? [], now),
    artifact_board: normalizeArtifacts(value?.artifact_board ?? [], now),
    risk_board: normalizeEntries(value?.risk_board ?? [], now),
    handoffs: normalizeHandoffs(value?.handoffs ?? [], now),
    next_actions: normalizeEntries(value?.next_actions ?? [], now),
    run_registry: normalizeRuns(value?.run_registry ?? [], now),
  };
}

function normalizeClaims(input: unknown, now: string): ResearchBoardClaim[] {
  return toArray(input).map(item => {
    if (typeof item === 'string') {
      const claim = item.trim();
      return {
        id: stableId('claim', claim),
        claim,
        status: UNKNOWN_STATUS,
        evidence: [],
        updated_at: now,
      };
    }
    const object = item as Record<string, unknown>;
    const claim = readString(object.claim ?? object.text ?? object.summary, '');
    return {
      id: safeId(object.id, stableId('claim', claim)),
      claim,
      status: normalizeEvidenceStatus(object.status),
      evidence: normalizeStringArray(object.evidence),
      updated_at: readString(object.updated_at, now),
    };
  }).filter(item => item.claim);
}

function normalizeEntries(input: unknown, now: string, defaultStatus: string = DEFAULT_ENTRY_STATUS): ResearchBoardEntry[] {
  return toArray(input).map(item => {
    if (typeof item === 'string') {
      const text = item.trim();
      return {
        id: stableId('entry', text),
        text,
        status: defaultStatus as ResearchEvidenceStatus | ResearchQueueStatus,
        evidence: [],
        updated_at: now,
      };
    }
    const object = item as Record<string, unknown>;
    const text = readString(object.text ?? object.summary ?? object.task ?? object.action ?? object.risk, '');
    return {
      id: safeId(object.id, stableId('entry', text)),
      text,
      status: readString(object.status, defaultStatus) as ResearchEvidenceStatus | ResearchQueueStatus,
      evidence: normalizeStringArray(object.evidence),
      updated_at: readString(object.updated_at, now),
    };
  }).filter(item => item.text);
}

function normalizeArtifacts(input: unknown, now: string): ResearchBoardArtifact[] {
  return toArray(input).map(item => {
    if (typeof item === 'string') {
      return artifactFromPath(item, now);
    }
    const object = item as Record<string, unknown>;
    const normalized = artifactFromPath(readString(object.path ?? object.file ?? object.text, ''), now);
    return {
      ...normalized,
      id: safeId(object.id, normalized.id),
      type: readOptionalString(object.type) ?? normalized.type,
      status: normalizeQueueStatus(object.status, DEFAULT_ARTIFACT_STATUS),
      evidence: normalizeStringArray(object.evidence),
      note: readOptionalString(object.note),
      updated_at: readString(object.updated_at, now),
    };
  }).filter(item => item.path);
}

function artifactFromPath(rawPath: string, now: string): ResearchBoardArtifact {
  const normalized = sanitizeArtifactPath(rawPath);
  return {
    id: stableId('artifact', normalized.path),
    path: normalized.path,
    status: normalized.blocked ? 'blocked' : DEFAULT_ARTIFACT_STATUS,
    evidence: [],
    note: normalized.blocked ? 'External or parent-relative path recorded as blocked boundary.' : undefined,
    original_path_hash: normalized.originalPathHash,
    updated_at: now,
  };
}

function normalizeHandoffs(input: unknown, now: string): ResearchBoardHandoff[] {
  return toArray(input).map(item => {
    if (typeof item === 'string') {
      const reason = item.trim();
      return {
        id: stableId('handoff', reason),
        target_role: inferTargetRole(reason),
        reason,
        status: DEFAULT_HANDOFF_STATUS,
        evidence: [],
        updated_at: now,
      };
    }
    const object = item as Record<string, unknown>;
    const reason = readString(object.reason ?? object.text ?? object.summary, '');
    const targetRole = readString(object.target_role ?? object.role, inferTargetRole(reason));
    return {
      id: safeId(object.id, stableId('handoff', `${targetRole}:${reason}`)),
      target_role: targetRole,
      reason,
      status: normalizeQueueStatus(object.status, DEFAULT_HANDOFF_STATUS),
      evidence: normalizeStringArray(object.evidence),
      updated_at: readString(object.updated_at, now),
    };
  }).filter(item => item.reason);
}

function normalizeRuns(input: unknown, now: string): ResearchBoardRun[] {
  return toArray(input).map(item => {
    const object = item as Record<string, unknown>;
    const command = readOptionalString(object.command);
    const outputPath = readOptionalString(object.output_path);
    const logPath = readOptionalString(object.log_path);
    const fallbackId = stableId('run', [
      object.method,
      object.split,
      object.seed,
      object.config,
      command,
      outputPath,
      logPath,
    ].filter(Boolean).join(':'));
    return {
      id: safeId(object.id ?? object.run_id, fallbackId),
      method: readOptionalString(object.method),
      split: readOptionalString(object.split),
      seed: readOptionalString(object.seed),
      config: readOptionalString(object.config),
      command,
      status: normalizeQueueStatus(object.status, DEFAULT_RUN_STATUS),
      log_path: sanitizeOptionalArtifactPath(logPath),
      output_path: sanitizeOptionalArtifactPath(outputPath),
      manuscript_target: sanitizeOptionalArtifactPath(readOptionalString(object.manuscript_target)),
      evidence: normalizeStringArray(object.evidence),
      updated_at: readString(object.updated_at, now),
    };
  });
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of current) {
    merged.set(item.id, item);
  }
  for (const item of incoming) {
    merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

function renderBoardMarkdown(board: ResearchBoard): string {
  const lines = [
    '# Research Board',
    '',
    `Project: ${board.project}`,
    `Updated: ${board.updated_at}`,
    `Active task: ${board.active_task_type || 'unknown'}`,
    '',
    '## Project Goal',
    board.project_goal || '_Not set_',
    '',
    '## Current Storyline',
    board.current_storyline || '_Not set_',
    '',
    '## Claim Board',
    ...renderClaims(board.claim_board),
    '',
    '## Evidence Board',
    ...renderEntries(board.evidence_board),
    '',
    '## Experiment Queue',
    ...renderEntries(board.experiment_queue),
    '',
    '## Artifact Board',
    ...renderArtifacts(board.artifact_board),
    '',
    '## Risk Board',
    ...renderEntries(board.risk_board),
    '',
    '## Handoffs',
    ...renderHandoffs(board.handoffs),
    '',
    '## Next Actions',
    ...renderEntries(board.next_actions),
    '',
    '## Run Registry',
    ...renderRuns(board.run_registry),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function renderClaims(items: ResearchBoardClaim[]): string[] {
  if (!items.length) {
    return ['_No claims recorded_'];
  }
  return items.map(item => `- [${item.status}] ${item.claim}${renderEvidenceSuffix(item.evidence)}`);
}

function renderEntries(items: ResearchBoardEntry[]): string[] {
  if (!items.length) {
    return ['_No entries recorded_'];
  }
  return items.map(item => `- [${item.status || 'unknown'}] ${item.text}${renderEvidenceSuffix(item.evidence)}`);
}

function renderArtifacts(items: ResearchBoardArtifact[]): string[] {
  if (!items.length) {
    return ['_No artifacts recorded_'];
  }
  return items.map(item => {
    const type = item.type ? ` type=${item.type}` : '';
    const note = item.note ? ` note=${item.note}` : '';
    return `- [${item.status}] ${item.path}${type}${note}${renderEvidenceSuffix(item.evidence)}`;
  });
}

function renderHandoffs(items: ResearchBoardHandoff[]): string[] {
  if (!items.length) {
    return ['_No handoffs recorded_'];
  }
  return items.map(item => `- [${item.status}] ${item.target_role}: ${item.reason}${renderEvidenceSuffix(item.evidence)}`);
}

function renderRuns(items: ResearchBoardRun[]): string[] {
  if (!items.length) {
    return ['_No runs recorded_'];
  }
  return items.map(item => {
    const fields = [
      item.method ? `method=${item.method}` : undefined,
      item.split ? `split=${item.split}` : undefined,
      item.seed ? `seed=${item.seed}` : undefined,
      item.config ? `config=${item.config}` : undefined,
      item.log_path ? `log=${item.log_path}` : undefined,
      item.output_path ? `output=${item.output_path}` : undefined,
    ].filter(Boolean).join(' ');
    return `- [${item.status}] ${item.id}${fields ? ` ${fields}` : ''}${renderEvidenceSuffix(item.evidence)}`;
  });
}

function renderEvidenceSuffix(evidence: string[]): string {
  return evidence.length ? ` evidence=${evidence.join('; ')}` : '';
}

function buildCounts(board: ResearchBoard): Record<string, number> {
  return {
    claims: board.claim_board.length,
    evidence: board.evidence_board.length,
    experiments: board.experiment_queue.length,
    artifacts: board.artifact_board.length,
    risks: board.risk_board.length,
    handoffs: board.handoffs.length,
    next_actions: board.next_actions.length,
    runs: board.run_registry.length,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function readRecentJsonl(filePath: string, maxEvents: number): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(100, maxEvents))).map(line => JSON.parse(line));
}

function toArray(input: unknown): unknown[] {
  if (input === undefined || input === null) {
    return [];
  }
  return Array.isArray(input) ? input : [input];
}

function normalizeStringArray(input: unknown): string[] {
  return toArray(input).map(item => readString(item, '')).filter(Boolean);
}

function normalizeEvidenceStatus(input: unknown): ResearchEvidenceStatus {
  const value = readString(input, UNKNOWN_STATUS);
  if (['unsupported', 'weakly_supported', 'supported', 'contradicted', 'blocked', 'unknown'].includes(value)) {
    return value as ResearchEvidenceStatus;
  }
  return UNKNOWN_STATUS;
}

function normalizeQueueStatus(input: unknown, fallback: string): ResearchQueueStatus {
  const value = readString(input, fallback);
  if (['planned', 'running', 'completed', 'failed', 'blocked', 'unknown'].includes(value)) {
    return value as ResearchQueueStatus;
  }
  return fallback as ResearchQueueStatus;
}

function sanitizeArtifactPath(rawPath: string): { path: string; blocked: boolean; originalPathHash?: string } {
  const value = rawPath.trim();
  if (!value) {
    return { path: '', blocked: false };
  }
  const normalized = value.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    return {
      path: `[blocked-external-path:${stableHash(normalized)}]`,
      blocked: true,
      originalPathHash: stableHash(normalized),
    };
  }
  return { path: normalized.replace(/^\/+/, ''), blocked: false };
}

function sanitizeOptionalArtifactPath(rawPath?: string): string | undefined {
  if (!rawPath) {
    return undefined;
  }
  return sanitizeArtifactPath(rawPath).path;
}

function inferTargetRole(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('inspect') || lower.includes('runtime') || lower.includes('tooling')) {
    return 'inspector-cat';
  }
  if (lower.includes('engineer') || lower.includes('patch') || lower.includes('implementation')) {
    return 'engineer-cat';
  }
  return 'reviewer-cat';
}

function readString(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function readOptionalString(value: unknown): string | undefined {
  const normalized = readString(value, '');
  return normalized || undefined;
}

function safeId(value: unknown, fallback: string): string {
  return safeSegment(readString(value, fallback));
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

function stableId(prefix: string, value: string): string {
  return `${prefix}-${stableHash(value || prefix).slice(0, 12)}`;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function renderResearchBoardMarkdown(board: ResearchBoard): string {
  return renderBoardMarkdown(board);
}
