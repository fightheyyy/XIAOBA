import * as path from 'path';

export interface DashboardObservabilityReviewOptions {
  rootDir?: string;
  outputRoot?: string;
}

export interface DashboardObservabilityReviewState {
  generated_at: string;
  root_dir: string;
  output_root: string;
  artifacts: Record<string, never>;
  summary: {
    candidate_count: 0;
    trace_continuity_ready: false;
    auto_accepted_benchmark: false;
  };
  actions: {
    can_generate: false;
    can_sign_review: false;
    can_patch: false;
    can_apply_patch: false;
  };
}

export function getDashboardObservabilityReviewState(
  options: DashboardObservabilityReviewOptions = {},
): DashboardObservabilityReviewState {
  const rootDir = getRootDir(options);
  const outputRoot = getOutputRoot(rootDir, options);
  return {
    generated_at: new Date().toISOString(),
    root_dir: displayPath(rootDir, rootDir, outputRoot),
    output_root: displayPath(outputRoot, rootDir, outputRoot),
    artifacts: {},
    summary: {
      candidate_count: 0,
      trace_continuity_ready: false,
      auto_accepted_benchmark: false,
    },
    actions: {
      can_generate: false,
      can_sign_review: false,
      can_patch: false,
      can_apply_patch: false,
    },
  };
}

function getRootDir(options: DashboardObservabilityReviewOptions): string {
  return path.resolve(options.rootDir ?? process.cwd());
}

function getOutputRoot(rootDir: string, options: DashboardObservabilityReviewOptions): string {
  return path.resolve(options.outputRoot ?? path.join(rootDir, 'output'));
}

function displayPath(value: string, rootDir: string, outputRoot: string): string {
  const normalized = path.resolve(value);
  const rootRelative = path.relative(rootDir, normalized);
  if (!rootRelative.startsWith('..') && !path.isAbsolute(rootRelative)) {
    return (rootRelative || '.').replace(/\\/g, '/');
  }
  const outputRelative = path.relative(outputRoot, normalized);
  if (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative)) {
    return path.join('output', outputRelative || '.').replace(/\\/g, '/');
  }
  return normalized.replace(/\\/g, '/');
}
