import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, ExecFileOptionsWithStringEncoding } from 'child_process';

export const PEEKABOO_VERSION_REQUIREMENT = '3.8.x';
const SUPPORTED_VERSION = /^3\.8\.\d+$/;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export interface PeekabooPermissions {
  screenRecording: boolean;
  accessibility: boolean;
  eventSynthesizing: boolean;
}

export interface PeekabooDriverStatus {
  platform: NodeJS.Platform;
  macosVersion?: string;
  supportedPlatform: boolean;
  binaryPath?: string;
  version?: string;
  versionCompatible: boolean;
  permissions: PeekabooPermissions;
  bridge?: unknown;
  ready: boolean;
  reason?: string;
}

export interface PeekabooRunOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  maxBuffer?: number;
}

export interface PeekabooStatusOptions {
  refresh?: boolean;
  abortSignal?: AbortSignal;
  includeBridge?: boolean;
}

export interface PeekabooCommandResult {
  data: unknown;
  stdout: string;
  stderr: string;
}

export interface PeekabooRunner {
  status(options?: PeekabooStatusOptions): Promise<PeekabooDriverStatus>;
  run(argv: string[], options?: PeekabooRunOptions): Promise<PeekabooCommandResult>;
}

export type PeekabooRunnerErrorKind =
  | 'not_found'
  | 'unsupported_platform'
  | 'unsupported_version'
  | 'permission'
  | 'timeout'
  | 'aborted'
  | 'command';

export class PeekabooRunnerError extends Error {
  constructor(
    readonly kind: PeekabooRunnerErrorKind,
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PeekabooRunnerError';
  }
}

export interface DefaultPeekabooRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  osRelease?: string;
  projectRoot?: string;
  resourcesPath?: string;
  binaryCandidates?: string[];
  now?: () => number;
  statusCacheMs?: number;
}

interface PeekabooEnvelope {
  success?: boolean;
  data?: unknown;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

/**
 * Narrow Peekaboo CLI adapter. It never invokes a shell and never exposes an
 * arbitrary command surface to a role.
 */
export class DefaultPeekabooRunner implements PeekabooRunner {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly osRelease: string;
  private readonly now: () => number;
  private readonly statusCacheMs: number;
  private binaryPath?: string;
  private cachedStatus?: { at: number; value: PeekabooDriverStatus };

  constructor(private readonly options: DefaultPeekabooRunnerOptions = {}) {
    this.environment = options.environment || process.env;
    this.platform = options.platform || process.platform;
    this.osRelease = options.osRelease || os.release();
    this.now = options.now || Date.now;
    this.statusCacheMs = options.statusCacheMs ?? 5_000;
  }

  async status(options: PeekabooStatusOptions = {}): Promise<PeekabooDriverStatus> {
    if (!options.refresh && this.cachedStatus && this.now() - this.cachedStatus.at < this.statusCacheMs) {
      return this.cachedStatus.value;
    }

    const macosVersion = this.platform === 'darwin' ? darwinReleaseToMacOS(this.osRelease) : undefined;
    const supportedPlatform = this.platform === 'darwin' && darwinMajor(this.osRelease) >= 24;
    if (!supportedPlatform) {
      return this.cacheStatus({
        platform: this.platform,
        ...(macosVersion && { macosVersion }),
        supportedPlatform: false,
        versionCompatible: false,
        permissions: emptyPermissions(),
        ready: false,
        reason: 'GuiCat requires macOS 15 or newer.',
      });
    }

    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      return this.cacheStatus({
        platform: this.platform,
        macosVersion,
        supportedPlatform: true,
        versionCompatible: false,
        permissions: emptyPermissions(),
        ready: false,
        reason: `Peekaboo CLI was not found. Set XIAOBA_PEEKABOO_BIN or install Peekaboo ${PEEKABOO_VERSION_REQUIREMENT}.`,
      });
    }

    let version: string | undefined;
    try {
      const result = await this.execute(binaryPath, ['--version'], {
        timeoutMs: 3_000,
        abortSignal: options.abortSignal,
        maxBuffer: 256 * 1024,
      }, false);
      version = parsePeekabooVersion(result.stdout);
    } catch (error) {
      return this.cacheStatus({
        platform: this.platform,
        macosVersion,
        supportedPlatform: true,
        binaryPath,
        versionCompatible: false,
        permissions: emptyPermissions(),
        ready: false,
        reason: normalizeErrorMessage(error),
      });
    }

    const versionCompatible = Boolean(version && SUPPORTED_VERSION.test(version));
    if (!versionCompatible) {
      return this.cacheStatus({
        platform: this.platform,
        macosVersion,
        supportedPlatform: true,
        binaryPath,
        ...(version && { version }),
        versionCompatible: false,
        permissions: emptyPermissions(),
        ready: false,
        reason: `Unsupported Peekaboo version ${version || 'unknown'}; GuiCat requires ${PEEKABOO_VERSION_REQUIREMENT}.`,
      });
    }

    let permissions = emptyPermissions();
    let bridge: unknown;
    let permissionReason: string | undefined;
    try {
      const permissionResult = await this.execute(binaryPath, [
        'permissions', 'status', '--all-sources', '--json',
      ], { timeoutMs: 8_000, abortSignal: options.abortSignal }, true);
      permissions = normalizePermissions(permissionResult.data);
    } catch (error) {
      permissionReason = normalizeErrorMessage(error);
    }

    if (options.includeBridge !== false) {
      try {
        const bridgeResult = await this.execute(binaryPath, [
          'bridge', 'status', '--json',
        ], { timeoutMs: 5_000, abortSignal: options.abortSignal }, true);
        bridge = bridgeResult.data;
      } catch {
        // Bridge diagnostics are useful but are not required for local execution.
      }
    }

    const ready = permissions.screenRecording && permissions.accessibility;
    const reason = permissionReason || (!ready
      ? 'Peekaboo requires Screen Recording and Accessibility permissions.'
      : undefined);

    return this.cacheStatus({
      platform: this.platform,
      macosVersion,
      supportedPlatform: true,
      binaryPath,
      version,
      versionCompatible: true,
      permissions,
      ...(bridge !== undefined && { bridge }),
      ready,
      ...(reason && { reason }),
    });
  }

  async run(argv: string[], options: PeekabooRunOptions = {}): Promise<PeekabooCommandResult> {
    assertAllowedArgv(argv);
    const status = await this.status({ abortSignal: options.abortSignal });
    if (!status.supportedPlatform) {
      throw new PeekabooRunnerError(
        'unsupported_platform',
        status.reason || 'GuiCat requires macOS 15 or newer.',
        'GUI_PLATFORM_UNSUPPORTED',
      );
    }
    if (!status.binaryPath) {
      throw new PeekabooRunnerError(
        'not_found',
        status.reason || 'Peekaboo CLI was not found.',
        'GUI_DRIVER_NOT_FOUND',
      );
    }
    if (!status.versionCompatible) {
      throw new PeekabooRunnerError(
        'unsupported_version',
        status.reason || 'Peekaboo version is not supported.',
        'GUI_DRIVER_VERSION_UNSUPPORTED',
      );
    }
    return this.execute(status.binaryPath, argv, options, true);
  }

  private cacheStatus(value: PeekabooDriverStatus): PeekabooDriverStatus {
    this.cachedStatus = { at: this.now(), value };
    return value;
  }

  private resolveBinary(): string | undefined {
    if (this.binaryPath && isExecutableFile(this.binaryPath)) {
      return this.binaryPath;
    }

    const explicit = stringValue(this.environment.XIAOBA_PEEKABOO_BIN);
    const legacyExplicit = stringValue(this.environment.XIAOBA_PEEKABOO_PATH);
    const resourcesPath = stringValue(this.options.resourcesPath)
      || stringValue((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath);
    const appRoot = stringValue(this.environment.XIAOBA_APP_ROOT);
    const projectRoot = path.resolve(this.options.projectRoot || process.cwd());
    const pathCandidates = stringValue(this.environment.PATH)
      ?.split(path.delimiter)
      .filter(Boolean)
      .map(entry => path.join(entry, 'peekaboo')) || [];
    const candidates = unique([
      ...(explicit ? [explicit] : []),
      ...(legacyExplicit ? [legacyExplicit] : []),
      ...(resourcesPath ? [path.join(resourcesPath, 'drivers', 'peekaboo', 'peekaboo')] : []),
      ...(appRoot ? [path.join(appRoot, 'drivers', 'peekaboo', 'peekaboo')] : []),
      path.join(projectRoot, 'node_modules', '@steipete', 'peekaboo', 'peekaboo'),
      ...(this.options.binaryCandidates || []),
      '/opt/homebrew/bin/peekaboo',
      '/usr/local/bin/peekaboo',
      ...pathCandidates,
    ]);

    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate) || !isExecutableFile(candidate)) {
        continue;
      }
      try {
        this.binaryPath = fs.realpathSync(candidate);
        return this.binaryPath;
      } catch {
        // Try the next candidate.
      }
    }
    return undefined;
  }

  private async execute(
    binaryPath: string,
    argv: string[],
    options: PeekabooRunOptions,
    parseJson: boolean,
  ): Promise<PeekabooCommandResult> {
    const execOptions: ExecFileOptionsWithStringEncoding = {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      signal: options.abortSignal,
      env: buildChildEnvironment(this.environment),
    };

    try {
      const result = await execFilePromise(binaryPath, argv, execOptions);
      if (!parseJson) {
        return { data: result.stdout.trim(), stdout: result.stdout, stderr: result.stderr };
      }
      return parseCommandResult(result.stdout, result.stderr);
    } catch (error: any) {
      throw normalizeExecError(error);
    }
  }
}

function execFilePromise(
  file: string,
  argv: string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, argv, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout: String(stdout || ''), stderr: String(stderr || '') });
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function normalizeExecError(error: any): PeekabooRunnerError {
  const stdout = String(error?.stdout || '');
  const stderr = String(error?.stderr || '');
  const envelope = tryParseEnvelope(stdout);
  const upstreamCode = stringValue(envelope?.error?.code);
  const upstreamMessage = stringValue(envelope?.error?.message);
  const message = upstreamMessage || [stderr.trim(), stdout.trim(), String(error?.message || '').trim()]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1600) || 'Peekaboo command failed.';

  if (error?.code === 'ENOENT') {
    return new PeekabooRunnerError('not_found', message, 'GUI_DRIVER_NOT_FOUND');
  }
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new PeekabooRunnerError('aborted', message, 'GUI_DRIVER_ABORTED');
  }
  if (error?.killed || error?.signal === 'SIGTERM' || /timed out|timeout|ETIMEDOUT/i.test(message)) {
    return new PeekabooRunnerError('timeout', message, 'GUI_DRIVER_TIMEOUT');
  }
  if (upstreamCode?.startsWith('PERMISSION_')) {
    return new PeekabooRunnerError('permission', message, upstreamCode, envelope?.error?.details);
  }
  return new PeekabooRunnerError('command', message, upstreamCode || 'GUI_DRIVER_COMMAND_FAILED', envelope?.error?.details);
}

function parseCommandResult(stdout: string, stderr: string): PeekabooCommandResult {
  const envelope = tryParseEnvelope(stdout);
  if (!envelope) {
    throw new PeekabooRunnerError(
      'command',
      'Peekaboo returned non-JSON output.',
      'GUI_DRIVER_INVALID_OUTPUT',
      stdout.slice(0, 500),
    );
  }
  if (envelope.success === false || envelope.error) {
    const code = stringValue(envelope.error?.code) || 'GUI_DRIVER_COMMAND_FAILED';
    const message = stringValue(envelope.error?.message) || 'Peekaboo command failed.';
    const kind: PeekabooRunnerErrorKind = code.startsWith('PERMISSION_') ? 'permission' : 'command';
    throw new PeekabooRunnerError(kind, message, code, envelope.error?.details);
  }
  return {
    data: envelope.data ?? (envelope.result !== undefined ? { result: envelope.result } : {}),
    stdout,
    stderr,
  };
}

function tryParseEnvelope(stdout: string): PeekabooEnvelope | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as PeekabooEnvelope;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as PeekabooEnvelope;
    } catch {
      return undefined;
    }
  }
}

function normalizePermissions(data: unknown): PeekabooPermissions {
  const selected = selectPermissionSource(data);
  const rows: Array<{ name: string; granted: boolean }> = [];
  collectPermissionRows(selected, rows, 0);
  const read = (pattern: RegExp): boolean => rows.some(row => pattern.test(row.name) && row.granted);
  return {
    screenRecording: read(/screen\s*(recording|and system audio)/i),
    accessibility: read(/accessibility/i),
    eventSynthesizing: read(/event\s*synthesizing/i),
  };
}

function selectPermissionSource(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const value = data as Record<string, unknown>;
  if (Array.isArray(value.permissions)) return value.permissions;
  if (value.selectedSource && typeof value.selectedSource === 'object') return value.selectedSource;
  const selectedName = stringValue(value.selectedSource);
  const sources = value.sources;
  if (selectedName && Array.isArray(sources)) {
    const match = sources.find(source => {
      if (!source || typeof source !== 'object') return false;
      const record = source as Record<string, unknown>;
      return [record.name, record.source, record.id].some(entry => stringValue(entry) === selectedName);
    });
    if (match) return match;
  }
  return data;
}

function collectPermissionRows(
  value: unknown,
  rows: Array<{ name: string; granted: boolean }>,
  depth: number,
): void {
  if (depth > 7 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPermissionRows(item, rows, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const name = stringValue(record.name);
  const grantedValue = record.isGranted ?? record.granted;
  if (name && typeof grantedValue === 'boolean') {
    rows.push({ name, granted: grantedValue });
  }
  for (const child of Object.values(record)) {
    collectPermissionRows(child, rows, depth + 1);
  }
}

function assertAllowedArgv(argv: string[]): void {
  const command = argv[0] || '';
  const allowed = new Set([
    'permissions', 'bridge', 'see', 'list', 'dialog', 'image', 'click', 'set-value', 'type',
    'app', 'window', 'scroll', 'press', 'menu',
  ]);
  if (!allowed.has(command)) {
    throw new PeekabooRunnerError(
      'command',
      `Peekaboo command is outside the GuiCat adapter boundary: ${command || '<empty>'}`,
      'GUI_DRIVER_COMMAND_FORBIDDEN',
    );
  }
  if (argv.some(arg => arg === 'agent' || arg === 'mcp' || arg === 'shell' || arg === 'run' || arg === 'config')) {
    throw new PeekabooRunnerError(
      'command',
      'Peekaboo Agent/MCP/shell/run/config surfaces are forbidden.',
      'GUI_DRIVER_COMMAND_FORBIDDEN',
    );
  }
}

function buildChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: source.HOME || os.homedir(),
    PATH: source.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: source.TMPDIR || os.tmpdir(),
    LANG: source.LANG || 'en_US.UTF-8',
    LC_ALL: source.LC_ALL,
    PEEKABOO_AI_PROVIDERS: '',
    PEEKABOO_DISABLE_TOOLS: 'shell,mcp_agent,agent,analyze,config,run',
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

function parsePeekabooVersion(raw: string): string | undefined {
  return raw.match(/Peekaboo\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)/i)?.[1]
    || raw.match(/\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/)?.[1];
}

function darwinMajor(release: string): number {
  return Number.parseInt(release.split('.')[0] || '0', 10) || 0;
}

function darwinReleaseToMacOS(release: string): string | undefined {
  const major = darwinMajor(release);
  return major >= 20 ? String(major - 9) : undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = fs.statSync(candidate);
    fs.accessSync(candidate, fs.constants.X_OK);
    return stats.isFile();
  } catch {
    return false;
  }
}

function emptyPermissions(): PeekabooPermissions {
  return { screenRecording: false, accessibility: false, eventSynthesizing: false };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeErrorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message || error || 'Unknown Peekaboo error.');
}
