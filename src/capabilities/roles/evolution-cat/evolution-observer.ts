import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const TRACE_FILE_NAME = 'traces.jsonl';
const SELF_RUN_MARKER = '[evolution_sleep]';
const MAX_TEXT_PREVIEW = 800;
const MAX_TOOL_SEQUENCE = 30;

export interface EvolutionObservation {
  observation_id: string;
  trace_id: string;
  trace_ref: string;
  timestamp: string;
  session_id: string;
  session_type: string;
  terminal_status: string;
  role_name?: string;
  skill_name?: string;
  subagent_id?: string;
  parent_session_id?: string;
  user_intent: string;
  assistant_outcome: string;
  tool_sequence: string[];
  tool_results: Array<{
    name: string;
    status: string;
    error_code?: string;
    artifact_refs: string[];
  }>;
}

export interface EvolutionPattern {
  pattern_id: string;
  occurrence_count: number;
  intent_signature: string;
  role_name?: string;
  skill_name?: string;
  tool_sequence: string[];
  terminal_status_counts: Record<string, number>;
  error_codes: string[];
  artifact_refs: string[];
  sample_trace_refs: string[];
  sample_user_intents: string[];
}

export interface EvolutionDigest {
  schema_version: 1;
  run_id: string;
  source: 'xiaoba_session_log_v3';
  generated_at: string;
  window: {
    target_date: string;
    timezone: string;
    start_inclusive: string;
    end_exclusive: string;
  };
  source_root: string;
  proposal_dir: string;
  totals: {
    trace_files: number;
    parsed_rows: number;
    malformed_rows: number;
    duplicate_rows: number;
    non_terminal_rows: number;
    self_run_rows: number;
    synthetic_or_replay_rows: number;
    observations: number;
    sessions: number;
    recurring_patterns: number;
  };
  patterns: EvolutionPattern[];
  observations: EvolutionObservation[];
}

export interface BuildEvolutionDigestOptions {
  workingDirectory: string;
  targetDate?: string;
  minOccurrences?: number;
  now?: Date;
}

export interface BuildEvolutionDigestResult {
  digest: EvolutionDigest;
  digestPath: string;
  proposalDirectory: string;
  artifactAction: 'created' | 'updated';
}

export function previousLocalDate(now = new Date()): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return formatLocalDate(date);
}

export function normalizeEvolutionDate(value: string | undefined, now = new Date()): string {
  const target = (value || previousLocalDate(now)).trim();
  const match = target.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error('date 必须使用 YYYY-MM-DD。');
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (formatLocalDate(date) !== target) {
    throw new Error(`无效日期：${target}`);
  }
  return target;
}

export function buildEvolutionDigest(options: BuildEvolutionDigestOptions): BuildEvolutionDigestResult {
  const now = options.now || new Date();
  const targetDate = normalizeEvolutionDate(options.targetDate, now);
  const minOccurrences = normalizeMinOccurrences(options.minOccurrences);
  const root = path.resolve(options.workingDirectory);
  const traceRoot = path.join(root, 'logs', 'sessions');
  const { start, end } = localDateWindow(targetDate, now);
  const traceFiles = listTraceFiles(traceRoot);
  const observations: EvolutionObservation[] = [];
  const seenTraceIds = new Set<string>();
  const totals = {
    trace_files: traceFiles.length,
    parsed_rows: 0,
    malformed_rows: 0,
    duplicate_rows: 0,
    non_terminal_rows: 0,
    self_run_rows: 0,
    synthetic_or_replay_rows: 0,
    observations: 0,
    sessions: 0,
    recurring_patterns: 0,
  };

  for (const traceFile of traceFiles) {
    const lines = readLines(traceFile);
    for (const line of lines) {
      let entry: Record<string, any>;
      try {
        entry = JSON.parse(line) as Record<string, any>;
      } catch {
        totals.malformed_rows += 1;
        continue;
      }
      if (entry.entry_type !== 'trace' && entry.entry_type !== 'turn') continue;
      totals.parsed_rows += 1;

      const timestampMs = Date.parse(String(entry.timestamp || ''));
      if (!Number.isFinite(timestampMs) || timestampMs < start.getTime() || timestampMs >= end.getTime()) {
        continue;
      }
      const traceId = String(entry.trace_id || entry.episode_id || entry.turn_id || '').trim();
      if (!traceId || seenTraceIds.has(traceId)) {
        totals.duplicate_rows += 1;
        continue;
      }
      seenTraceIds.add(traceId);

      if (isEvolutionSleepTrace(entry)) {
        totals.self_run_rows += 1;
        continue;
      }
      if (isSyntheticOrReplayTrace(entry)) {
        totals.synthetic_or_replay_rows += 1;
        continue;
      }
      const terminalStatus = terminalTraceStatus(entry);
      if (!terminalStatus) {
        totals.non_terminal_rows += 1;
        continue;
      }

      observations.push(toObservation(entry, traceFile, root, traceId, terminalStatus));
    }
  }

  observations.sort((left, right) => {
    const byTime = left.timestamp.localeCompare(right.timestamp);
    return byTime || left.trace_id.localeCompare(right.trace_id);
  });
  const patterns = buildPatterns(observations, minOccurrences);
  const runId = `sleep-${targetDate}`;
  const outputDirectory = path.join(root, 'output', 'evolution', 'sleep', targetDate);
  const proposalDirectory = path.join(outputDirectory, 'proposals');
  const digestPath = path.join(outputDirectory, 'digest.json');
  const sourceRoot = displayPath(traceRoot, root);
  const digest: EvolutionDigest = {
    schema_version: 1,
    run_id: runId,
    source: 'xiaoba_session_log_v3',
    generated_at: now.toISOString(),
    window: {
      target_date: targetDate,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      start_inclusive: start.toISOString(),
      end_exclusive: end.toISOString(),
    },
    source_root: sourceRoot,
    proposal_dir: displayPath(proposalDirectory, root),
    totals: {
      ...totals,
      observations: observations.length,
      sessions: new Set(observations.map(item => `${item.session_type}\0${item.session_id}`)).size,
      recurring_patterns: patterns.length,
    },
    patterns,
    observations,
  };

  fs.mkdirSync(proposalDirectory, { recursive: true });
  const artifactAction = fs.existsSync(digestPath) ? 'updated' : 'created';
  atomicWriteJson(digestPath, digest);
  return { digest, digestPath, proposalDirectory, artifactAction };
}

function localDateWindow(targetDate: string, now: Date): { start: Date; end: Date } {
  const [year, month, day] = targetDate.split('-').map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const nextDay = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  const end = now.getTime() < nextDay.getTime() && now.getTime() > start.getTime()
    ? new Date(now.getTime())
    : nextDay;
  return { start, end };
}

function listTraceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name === TRACE_FILE_NAME) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files;
}

function readLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function terminalTraceStatus(entry: Record<string, any>): string | undefined {
  const events = Array.isArray(entry.events) ? entry.events : [];
  const completed = [...events].reverse().find(event => event?.event_type === 'session_completed');
  if (completed) return String(completed.status || 'success');
  const providerError = [...events].reverse().find(event => event?.event_type === 'provider_error');
  if (providerError) return String(providerError.status || 'failure');
  return undefined;
}

function isEvolutionSleepTrace(entry: Record<string, any>): boolean {
  const userText = String(entry.user?.text || '');
  if (userText.includes(SELF_RUN_MARKER)) return true;
  const sessionId = String(entry.session_id || '');
  if (sessionId.startsWith('evolution:sleep:')) return true;
  const events = Array.isArray(entry.events) ? entry.events : [];
  return events.some(event => event?.source === 'evolution_sleep');
}

function isSyntheticOrReplayTrace(entry: Record<string, any>): boolean {
  const sessionType = String(entry.session_type || '').toLowerCase();
  const sessionId = String(entry.session_id || '').toLowerCase();
  if (['eval', 'replay', 'test'].includes(sessionType)) return true;
  if (/^(eval|replay|contract|benchmark):/.test(sessionId)) return true;
  if (sessionId.includes(':evolution-replay-')) return true;
  if (sessionId.includes(':trace-replay-')) return true;
  if (/(?:^|[_:-])(tester|fixture|smoke)(?:$|[_:-])/.test(sessionId)) return true;
  const events = Array.isArray(entry.events) ? entry.events : [];
  if (events.some(event => (
    String(event?.environment || '').toLowerCase() === 'test'
    || ['replay', 'test', 'contract_smoke', 'evolution-reviewer-trace-replay'].includes(String(event?.source || '').toLowerCase())
  ))) {
    return true;
  }
  const completed = [...events].reverse().find(event => event?.event_type === 'session_completed');
  return completed?.model_call_count === 0;
}

function toObservation(
  entry: Record<string, any>,
  traceFile: string,
  root: string,
  traceId: string,
  terminalStatus: string,
): EvolutionObservation {
  const events = Array.isArray(entry.events) ? entry.events : [];
  const lifecycle = [...events].reverse().find(event => event?.source === 'subagent') || {};
  const visibility = Array.isArray(entry.tool_visibility) ? entry.tool_visibility : [];
  const latestVisibility = visibility[visibility.length - 1] || {};
  const toolCalls = Array.isArray(entry.assistant?.tool_calls) ? entry.assistant.tool_calls : [];
  const toolResults: EvolutionObservation['tool_results'] = toolCalls
    .slice(0, MAX_TOOL_SEQUENCE)
    .map((tool: Record<string, any>) => ({
    name: String(tool.name || 'unknown_tool'),
    status: String(tool.status || 'success'),
    ...(tool.error_code ? { error_code: String(tool.error_code) } : {}),
    artifact_refs: extractArtifactRefs(tool),
    }));
  const traceRef = `${displayPath(traceFile, root)}#${traceId}`;
  return {
    observation_id: stableHash(`observation\0${traceRef}`),
    trace_id: traceId,
    trace_ref: traceRef,
    timestamp: String(entry.timestamp || ''),
    session_id: String(entry.session_id || 'unknown'),
    session_type: String(entry.session_type || 'unknown'),
    terminal_status: terminalStatus,
    ...(lifecycle.role_name || latestVisibility.roleName
      ? { role_name: String(lifecycle.role_name || latestVisibility.roleName) }
      : {}),
    ...(lifecycle.skill_name || latestVisibility.activeSkillName
      ? { skill_name: String(lifecycle.skill_name || latestVisibility.activeSkillName) }
      : {}),
    ...(lifecycle.subagent_id ? { subagent_id: String(lifecycle.subagent_id) } : {}),
    ...(lifecycle.parent_session_id ? { parent_session_id: String(lifecycle.parent_session_id) } : {}),
    user_intent: truncate(String(entry.user?.text || '')),
    assistant_outcome: truncate(String(entry.assistant?.text || '')),
    tool_sequence: toolResults.map(tool => tool.name),
    tool_results: toolResults,
  };
}

function buildPatterns(observations: EvolutionObservation[], minOccurrences: number): EvolutionPattern[] {
  const groups = new Map<string, { signature: PatternSignature; items: EvolutionObservation[] }>();
  for (const observation of observations) {
    const signature: PatternSignature = {
      intent_signature: normalizeIntent(observation.user_intent),
      role_name: observation.role_name || '',
      skill_name: observation.skill_name || '',
      tool_sequence: observation.tool_sequence,
    };
    const key = stableHash(JSON.stringify(signature));
    const group = groups.get(key) || { signature, items: [] };
    group.items.push(observation);
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .filter(([, group]) => distinctSessionCount(group.items) >= minOccurrences)
    .map(([patternId, group]) => ({
      pattern_id: patternId,
      occurrence_count: distinctSessionCount(group.items),
      intent_signature: group.signature.intent_signature,
      ...(group.signature.role_name ? { role_name: group.signature.role_name } : {}),
      ...(group.signature.skill_name ? { skill_name: group.signature.skill_name } : {}),
      tool_sequence: group.signature.tool_sequence,
      terminal_status_counts: countValues(group.items.map(item => item.terminal_status)),
      error_codes: unique(group.items.flatMap(item => item.tool_results.map(tool => tool.error_code).filter(Boolean) as string[])),
      artifact_refs: unique(group.items.flatMap(item => item.tool_results.flatMap(tool => tool.artifact_refs))).slice(0, 20),
      sample_trace_refs: sampleTraceRefsBySession(group.items, 5),
      sample_user_intents: unique(group.items.map(item => item.user_intent)).slice(0, 3),
    }))
    .sort((left, right) => right.occurrence_count - left.occurrence_count || left.pattern_id.localeCompare(right.pattern_id));
}

function distinctSessionCount(items: EvolutionObservation[]): number {
  return new Set(items.map(item => evolutionTaskIdentity(item))).size;
}

function sampleTraceRefsBySession(items: EvolutionObservation[], limit: number): string[] {
  const refs: string[] = [];
  const seenSessions = new Set<string>();
  for (const item of items) {
    const session = evolutionTaskIdentity(item);
    if (seenSessions.has(session)) continue;
    seenSessions.add(session);
    refs.push(item.trace_ref);
    if (refs.length >= limit) break;
  }
  return refs;
}

function evolutionTaskIdentity(item: EvolutionObservation): string {
  return item.parent_session_id || item.session_id;
}

interface PatternSignature {
  intent_signature: string;
  role_name: string;
  skill_name: string;
  tool_sequence: string[];
}

function normalizeIntent(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function extractArtifactRefs(tool: Record<string, any>): string[] {
  const manifest = Array.isArray(tool.artifact_manifest) ? tool.artifact_manifest : [];
  return unique(manifest
    .map(item => typeof item?.path === 'string' ? item.path : '')
    .filter(Boolean));
}

function normalizeMinOccurrences(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 2 || value > 20) {
    throw new Error('min_occurrences 必须是 2 到 20 的整数。');
  }
  return value;
}

function countValues(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return result;
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_TEXT_PREVIEW
    ? normalized
    : `${normalized.slice(0, MAX_TEXT_PREVIEW)}…`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function displayPath(filePath: string, root: string): string {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
