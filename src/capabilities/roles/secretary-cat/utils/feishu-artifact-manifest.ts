import path from 'path';
import { ArtifactManifestItem, ToolExecutionContext } from '../../../../runtime/contracts/tool';

interface SecretaryArtifactManifestOptions {
  toolName: string;
  artifactRole: string;
  action: ArtifactManifestItem['action'];
  result: unknown;
  context: ToolExecutionContext;
  explicitPaths?: unknown[];
  includeResultPaths?: boolean;
}

const ARTIFACT_PATH_KEY = /(^|_)(artifact|artifacts|file|files|path|local_path|saved_to|saved_path|download_path|output|output_path|transcript|summary|notes|media)(_|$)/i;

export function secretaryToolOwnedArtifactManifest(options: SecretaryArtifactManifestOptions): ArtifactManifestItem[] {
  const parsed = parseToolJson(options.result);
  if (parsed && parsed.ok === false) {
    return [];
  }

  const candidates = [
    ...(options.explicitPaths ?? []),
    ...(options.includeResultPaths === false ? [] : collectArtifactPathCandidates(parsed?.result ?? parsed)),
  ];

  return uniqueArtifacts(candidates.flatMap((candidate) => {
    const artifactPath = workspaceRelativeArtifactPath(candidate, options.context.workingDirectory);
    if (!artifactPath) {
      return [];
    }
    return [{
      path: artifactPath,
      type: artifactType(artifactPath),
      action: options.action,
      metadata: {
        source: 'tool_owned',
        tool: options.toolName,
        artifact_role: options.artifactRole,
      },
    }];
  }));
}

export function collectArtifactPathCandidates(value: unknown, keyHint = '', depth = 0): string[] {
  if (depth > 8) {
    return [];
  }
  if (typeof value === 'string') {
    return isArtifactPathKey(keyHint) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectArtifactPathCandidates(item, keyHint, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const nextHint = isArtifactPathKey(key) ? key : keyHint;
    return collectArtifactPathCandidates(child, nextHint, depth + 1);
  });
}

export function workspaceRelativeArtifactPath(value: unknown, workingDirectory: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  let candidate = value.trim();
  candidate = candidate.replace(/^["']|["']$/g, '');
  candidate = candidate.replace(/[)\],;]+$/g, '');
  if (!candidate || /[\r\n]/.test(candidate)) {
    return undefined;
  }
  if (/^(https?|data|mailto):/i.test(candidate)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)
    || /^[A-Za-z]:[\\/]/.test(candidate)) {
    return undefined;
  }
  if (candidate.startsWith('~')) {
    return undefined;
  }

  const root = path.resolve(workingDirectory);
  const normalized = path.normalize(candidate);
  const relativePath = path.isAbsolute(normalized)
    ? path.relative(root, normalized)
    : normalized;

  if (!relativePath || relativePath === '.' || path.isAbsolute(relativePath) || relativePath.startsWith('..')) {
    return undefined;
  }

  const slashPath = relativePath.replace(/\\/g, '/');
  const basename = path.basename(slashPath);
  if (!basename || basename === '.' || basename === '..') {
    return undefined;
  }
  if (!slashPath.includes('/') && !/\.[A-Za-z0-9]{1,12}$/.test(basename)) {
    return undefined;
  }
  return slashPath;
}

function parseToolJson(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isArtifactPathKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (/(^|_)(token|id|url|link)(_|$)/.test(normalized)) {
    return false;
  }
  return ARTIFACT_PATH_KEY.test(normalized);
}

function artifactType(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return ext || 'file';
}

function uniqueArtifacts(items: ArtifactManifestItem[]): ArtifactManifestItem[] {
  const seen = new Set<string>();
  const unique: ArtifactManifestItem[] = [];
  for (const item of items) {
    const key = `${item.path}::${item.action}::${item.metadata?.artifact_role ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}
