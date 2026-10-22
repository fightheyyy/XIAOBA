import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactManifestItem, Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';

const DEFAULT_DATASET_DIR = '/Users/guowei/minimind/data/ijcai2026_chinatravel/TPC_IJCAI_2026_phase1_EN';
const DEFAULT_METHOD = 'guide_env_baseline';
const DEFAULT_SPLIT = 'tpc_phase1';
const DEFAULT_TEAM = 'XiaoBaGuide';
const DEFAULT_MAX_CHARS = 4200;
const RUNNER_FILE = 'guide-env-baseline-runner.py';

interface EnvBaselineReport {
  version: 1;
  run_id: string;
  status: string;
  method_name: string;
  results_method_dir: string;
  generated_at: string;
  dataset?: {
    ref: string;
    files_total?: number;
    files_processed?: number;
    limited?: boolean;
  };
  generation?: {
    generated: number;
    failed: number;
    failure_examples: Array<{ uid: string; error: string }>;
  };
  artifacts: {
    results_dir?: string;
    report_json_path: string;
    report_md_path: string;
    manifest_path: string;
    runner_path?: string;
    runner_config_path?: string;
    stdout_path?: string;
    stderr_path?: string;
    zip_path?: string;
    verifier_scores_path?: string;
  };
  verifier: {
    status: 'not_requested' | 'completed' | 'failed' | 'blocked_missing_repo' | 'blocked_missing_eval_tpc';
    command?: string;
    split?: string;
    stdout_path?: string;
    stderr_path?: string;
    scores_path?: string;
    exit_code?: number | null;
    latest_scores?: Record<string, number>;
    reason?: string;
  };
  eval_basis: {
    profile_artifact: string;
    eval_analysis_artifact: string;
    smoke_score?: Record<string, number>;
  };
  next_repair_focus: string[];
  reason?: string;
}

export class GuideTpcEnvBaselineTool implements Tool {
  private recentArtifactManifest?: { runId: string; manifest: ArtifactManifestItem[] };

  definition: ToolDefinition = {
    name: 'guide_tpc_env_baseline',
    description: [
      'Guide 专属工具：生成 ChinaTravel / TPC Phase 1 的 environment-bound + verifier-repaired itinerary baseline。',
      '它会调用官方 ChinaTravel environment API 绑定真实往返城际交通、酒店、餐馆和市内交通段，再用官方 commonsense / hard_logic 函数做最小侵入 repair 过滤。',
      '这个工具是 schema baseline 后的第一层 Phase 1 提分工具：先保住 commonsense/environment pass，再修复可确定收益的景点、餐馆和酒店实体约束。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        official_repo_dir: {
          type: 'string',
          description: 'ChinaTravel 官方仓库目录，必须包含 eval_tpc.py，并能 import chinatravel.environment。'
        },
        dataset_dir: {
          type: 'string',
          description: `Phase 1 EN task JSON 目录，默认 ${DEFAULT_DATASET_DIR}。`
        },
        out_dir: {
          type: 'string',
          description: '输出目录，必须位于当前工作目录下。默认 output/guide/tpc-env-baseline/<run_id>。'
        },
        run_id: {
          type: 'string',
          description: '可选 run id；不填自动生成。'
        },
        method_name: {
          type: 'string',
          description: `官方 results 方法名前缀，默认 ${DEFAULT_METHOD}；英文结果目录会是 <method>_en。`
        },
        split: {
          type: 'string',
          description: `官方 eval_tpc.py --splits 参数，默认 ${DEFAULT_SPLIT}。limit smoke 会自动生成临时 split。`
        },
        limit: {
          type: 'number',
          description: '只处理前 N 条任务；用于 smoke。默认处理全部。'
        },
        python_bin: {
          type: 'string',
          description: '调用官方 environment API 的 Python 命令，默认 python。'
        },
        run_verifier: {
          type: 'boolean',
          description: '是否复制结果到 official_repo_dir/results 并调用 eval_tpc.py，默认 false。'
        },
        include_zip: {
          type: 'boolean',
          description: '是否生成 {TeamName}_v{x}.zip，默认 true。'
        },
        team_name: {
          type: 'string',
          description: `提交 zip 队名，默认 ${DEFAULT_TEAM}。`
        },
        version: {
          type: 'string',
          description: '提交 zip 版本号，默认 env0。'
        },
        max_chars: {
          type: 'number',
          description: `最大返回字符数，默认 ${DEFAULT_MAX_CHARS}。完整证据落盘。`
        }
      },
      required: ['official_repo_dir']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const workingDirectory = context.workingDirectory;
    const runId = safeSegment(readString(args?.run_id, createRunId()));
    const outDir = resolveOutputDir(workingDirectory, args?.out_dir, runId);
    const officialRepoDir = args?.official_repo_dir
      ? path.resolve(workingDirectory, String(args.official_repo_dir))
      : '';
    const datasetDir = path.resolve(readString(args?.dataset_dir, DEFAULT_DATASET_DIR));
    const methodName = normalizeMethodName(args?.method_name);
    const resultsMethodDir = `${methodName}_en`;
    const resultsDir = path.join(outDir, 'results', resultsMethodDir);
    const split = safeSegment(readString(args?.split, DEFAULT_SPLIT));
    const limit = readOptionalPositiveInteger(args?.limit);
    const pythonBin = readString(args?.python_bin, 'python');
    const runVerifier = readBoolean(args?.run_verifier, false);
    const includeZip = readBoolean(args?.include_zip, true);
    const teamName = safeSegment(readString(args?.team_name, DEFAULT_TEAM));
    const version = safeSegment(readString(args?.version, 'env0'));
    const maxChars = readPositiveNumber(args?.max_chars, DEFAULT_MAX_CHARS);

    fs.mkdirSync(outDir, { recursive: true });
    const reportJsonPath = path.join(outDir, 'report.json');
    const reportMdPath = path.join(outDir, 'report.md');
    const manifestPath = path.join(outDir, 'manifest.json');
    const runnerPath = path.join(outDir, RUNNER_FILE);
    const configPath = path.join(outDir, 'runner-config.json');
    const stdoutPath = path.join(outDir, 'env-baseline.stdout.log');
    const stderrPath = path.join(outDir, 'env-baseline.stderr.log');

    const blocker = validateInputs({ officialRepoDir, datasetDir });
    if (blocker) {
      const blockedReport = buildBlockedReport({
        status: blocker.status,
        reason: blocker.reason,
        runId,
        methodName,
        resultsMethodDir,
        officialRepoDir,
        datasetDir,
        outDir,
        reportJsonPath,
        reportMdPath,
        manifestPath,
        workingDirectory,
      });
      writeJson(reportJsonPath, blockedReport);
      fs.writeFileSync(reportMdPath, renderReport(blockedReport), 'utf-8');
      writeJson(manifestPath, buildManifest({
        runId,
        status: blocker.status,
        outDir,
        workingDirectory,
        files: existingArtifactPaths({ reportJsonPath, reportMdPath, manifestPath }),
      }));
      this.recentArtifactManifest = {
        runId,
        manifest: buildArtifactManifest({
          reportJsonPath,
          reportMdPath,
          manifestPath,
          workingDirectory,
        }),
      };
      return truncate(formatResult(blockedReport, workingDirectory), maxChars);
    }

    fs.rmSync(resultsDir, { recursive: true, force: true });
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(runnerPath, PYTHON_RUNNER_SOURCE, 'utf-8');
    writeJson(configPath, {
      official_repo_dir: officialRepoDir,
      dataset_dir: datasetDir,
      results_dir: resultsDir,
      limit,
      method_name: methodName,
      split,
    });

    const result = spawnSync(pythonBin, [runnerPath, configPath], {
      cwd: officialRepoDir,
      encoding: 'utf-8',
      maxBuffer: 128 * 1024 * 1024,
    });
    fs.writeFileSync(stdoutPath, result.stdout || '', 'utf-8');
    fs.writeFileSync(stderrPath, result.stderr || result.error?.message || '', 'utf-8');

    const generationReportPath = path.join(outDir, 'generation-report.json');
    const generationReport = fs.existsSync(generationReportPath)
      ? readJson(generationReportPath) as Record<string, any>
      : {};
    const generatedUids = Array.isArray(generationReport.generated_uids)
      ? generationReport.generated_uids.map(String)
      : fs.existsSync(resultsDir)
        ? fs.readdirSync(resultsDir).filter(file => file.endsWith('.json')).map(file => path.basename(file, '.json')).sort()
        : [];

    const zipPath = includeZip && result.status === 0 && !result.error
      ? createSubmissionZip(outDir, teamName, version, 'results')
      : undefined;
    const verifier = runVerifier && result.status === 0 && !result.error
      ? runOfficialVerifier({
        officialRepoDir,
        outDir,
        methodName,
        resultsMethodDir,
        resultsDir,
        split,
        generatedUids,
        limited: Boolean(limit),
        pythonBin,
        workingDirectory,
      })
      : {
        status: 'not_requested' as const,
        reason: runVerifier
          ? 'generator failed before verifier could run'
          : 'run_verifier=false; generated environment-bound prediction artifacts only.',
      };

    const report: EnvBaselineReport = {
      version: 1,
      run_id: runId,
      status: result.status === 0 && !result.error ? 'completed' : 'failed',
      method_name: methodName,
      results_method_dir: resultsMethodDir,
      generated_at: new Date().toISOString(),
      dataset: {
        ref: datasetRef(datasetDir),
        files_total: numberOrUndefined(generationReport.files_total),
        files_processed: numberOrUndefined(generationReport.files_processed),
        limited: Boolean(limit),
      },
      generation: {
        generated: generatedUids.length,
        failed: Array.isArray(generationReport.failures) ? generationReport.failures.length : 0,
        failure_examples: Array.isArray(generationReport.failures)
          ? generationReport.failures.slice(0, 10).map((item: any) => ({
            uid: String(item.uid || ''),
            error: String(item.error || ''),
          }))
          : [],
      },
      artifacts: {
        results_dir: relativeDisplayPath(resultsDir, workingDirectory),
        report_json_path: relativeDisplayPath(reportJsonPath, workingDirectory),
        report_md_path: relativeDisplayPath(reportMdPath, workingDirectory),
        manifest_path: relativeDisplayPath(manifestPath, workingDirectory),
        runner_path: relativeDisplayPath(runnerPath, workingDirectory),
        runner_config_path: relativeDisplayPath(configPath, workingDirectory),
        stdout_path: relativeDisplayPath(stdoutPath, workingDirectory),
        stderr_path: relativeDisplayPath(stderrPath, workingDirectory),
        ...(zipPath ? { zip_path: relativeDisplayPath(zipPath, workingDirectory) } : {}),
        ...(verifier.scores_path ? { verifier_scores_path: verifier.scores_path } : {}),
      },
      verifier,
      eval_basis: {
        profile_artifact: 'output/guide/data-profile/phase1-en-v0/profile.md',
        eval_analysis_artifact: 'output/guide/eval-analysis/phase1-v12-quoteparse-full/eval-analysis.md',
        smoke_score: {
          MicEPR: 99.996,
          MacEPR: 99.9,
          'C-LPR': 98.06614349775785,
          FPR: 93.8,
          overall: 90.32902770567489,
        },
      },
      next_repair_focus: [
        'repair the remaining chronology edge case without reducing route, budget and entity gains',
        'classify other.unclassified hard-logic failures into time-window and duration repairs',
        'extend verifier-filtered budget and residual entity repair for the remaining hard-logic tail',
      ],
      ...(result.error || result.status !== 0 ? { reason: result.error?.message || `runner exited with ${result.status}` } : {}),
    };

    writeJson(reportJsonPath, report);
    fs.writeFileSync(reportMdPath, renderReport(report), 'utf-8');
    writeJson(manifestPath, buildManifest({
      runId,
      status: report.status,
      outDir,
      workingDirectory,
      files: existingArtifactPaths({
        resultsDir,
        reportJsonPath,
        reportMdPath,
        manifestPath,
        runnerPath,
        configPath,
        stdoutPath,
        stderrPath,
        zipPath,
        verifierScoresPath: verifier.scores_path ? path.resolve(workingDirectory, verifier.scores_path) : undefined,
      }),
    }));

    this.recentArtifactManifest = {
      runId,
      manifest: buildArtifactManifest({
        resultsDir,
        reportJsonPath,
        reportMdPath,
        manifestPath,
        runnerPath,
        configPath,
        stdoutPath,
        stderrPath,
        zipPath,
        verifierScoresPath: verifier.scores_path ? path.resolve(workingDirectory, verifier.scores_path) : undefined,
        verifierStdoutPath: verifier.stdout_path ? path.resolve(workingDirectory, verifier.stdout_path) : undefined,
        verifierStderrPath: verifier.stderr_path ? path.resolve(workingDirectory, verifier.stderr_path) : undefined,
        workingDirectory,
      }),
    };

    return truncate(formatResult(report, workingDirectory), maxChars);
  }

  getArtifactManifest(_args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    const fields = parseKeyValueLines(typeof result === 'string' ? result : '');
    if (fields.run_id && this.recentArtifactManifest?.runId === fields.run_id) {
      return this.recentArtifactManifest.manifest;
    }
    return buildArtifactManifest({
      resultsDir: fields.results_dir ? path.resolve(context.workingDirectory, fields.results_dir) : undefined,
      reportJsonPath: fields.report ? path.resolve(context.workingDirectory, fields.report) : undefined,
      reportMdPath: fields.report_md ? path.resolve(context.workingDirectory, fields.report_md) : undefined,
      manifestPath: fields.manifest ? path.resolve(context.workingDirectory, fields.manifest) : undefined,
      workingDirectory: context.workingDirectory,
    });
  }
}

function validateInputs(input: {
  officialRepoDir: string;
  datasetDir: string;
}): { status: EnvBaselineReport['verifier']['status']; reason: string } | undefined {
  if (!input.officialRepoDir || !fs.existsSync(input.officialRepoDir) || !fs.statSync(input.officialRepoDir).isDirectory()) {
    return {
      status: 'blocked_missing_repo',
      reason: `official_repo_dir not found or not a directory: ${datasetRef(input.officialRepoDir)}`,
    };
  }
  if (!fs.existsSync(path.join(input.officialRepoDir, 'eval_tpc.py'))) {
    return {
      status: 'blocked_missing_eval_tpc',
      reason: 'official_repo_dir does not contain eval_tpc.py.',
    };
  }
  if (!fs.existsSync(input.datasetDir) || !fs.statSync(input.datasetDir).isDirectory()) {
    return {
      status: 'failed',
      reason: `dataset_dir not found or not a directory: ${datasetRef(input.datasetDir)}`,
    } as { status: EnvBaselineReport['verifier']['status']; reason: string };
  }
  return undefined;
}

function buildBlockedReport(input: {
  status: string;
  reason: string;
  runId: string;
  methodName: string;
  resultsMethodDir: string;
  officialRepoDir: string;
  datasetDir: string;
  outDir: string;
  reportJsonPath: string;
  reportMdPath: string;
  manifestPath: string;
  workingDirectory: string;
}): EnvBaselineReport {
  return {
    version: 1,
    run_id: input.runId,
    status: input.status,
    method_name: input.methodName,
    results_method_dir: input.resultsMethodDir,
    generated_at: new Date().toISOString(),
    dataset: {
      ref: datasetRef(input.datasetDir),
      limited: false,
    },
    artifacts: {
      report_json_path: relativeDisplayPath(input.reportJsonPath, input.workingDirectory),
      report_md_path: relativeDisplayPath(input.reportMdPath, input.workingDirectory),
      manifest_path: relativeDisplayPath(input.manifestPath, input.workingDirectory),
    },
    verifier: {
      status: input.status === 'blocked_missing_eval_tpc' ? 'blocked_missing_eval_tpc' : 'blocked_missing_repo',
      reason: input.reason,
    },
    eval_basis: {
      profile_artifact: 'output/guide/data-profile/phase1-en-v0/profile.md',
      eval_analysis_artifact: 'output/guide/eval-analysis/phase1-schema-baseline-v1-tool/eval-analysis.md',
    },
    next_repair_focus: [
      'fix official repo / environment setup before environment-bound generation',
      'rerun guide_tpc_env_baseline after official environment imports are available',
    ],
    reason: input.reason,
  };
}

function runOfficialVerifier(input: {
  officialRepoDir: string;
  outDir: string;
  methodName: string;
  resultsMethodDir: string;
  resultsDir: string;
  split: string;
  generatedUids: string[];
  limited: boolean;
  pythonBin: string;
  workingDirectory: string;
}): EnvBaselineReport['verifier'] {
  const evalPath = path.join(input.officialRepoDir, 'eval_tpc.py');
  if (!fs.existsSync(evalPath)) {
    return {
      status: 'blocked_missing_eval_tpc',
      reason: 'official_repo_dir does not contain eval_tpc.py.',
    };
  }

  const officialResultsDir = path.join(input.officialRepoDir, 'results', input.resultsMethodDir);
  fs.rmSync(officialResultsDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(officialResultsDir), { recursive: true });
  fs.cpSync(input.resultsDir, officialResultsDir, { recursive: true });

  let evalSplit = input.split;
  if (input.limited) {
    evalSplit = safeSegment(`${input.split}-${path.basename(input.outDir)}`);
    const splitPath = path.join(input.officialRepoDir, 'chinatravel', 'evaluation', 'default_splits', `${evalSplit}.txt`);
    fs.writeFileSync(splitPath, `${input.generatedUids.join('\n')}\n`, 'utf-8');
  }

  const stdoutPath = path.join(input.outDir, 'verifier.stdout.log');
  const stderrPath = path.join(input.outDir, 'verifier.stderr.log');
  const commandArgs = ['eval_tpc.py', '--splits', evalSplit, '--method', input.methodName, '--lang', 'en'];
  const result = spawnSync(input.pythonBin, commandArgs, {
    cwd: input.officialRepoDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(stdoutPath, result.stdout || '', 'utf-8');
  fs.writeFileSync(stderrPath, result.stderr || result.error?.message || '', 'utf-8');

  const scoreSourcePath = path.join(input.officialRepoDir, 'your_tpc_scores.json');
  const scoreDestPath = path.join(input.outDir, 'verifier-scores.json');
  if (fs.existsSync(scoreSourcePath)) {
    fs.copyFileSync(scoreSourcePath, scoreDestPath);
  }
  return {
    status: result.status === 0 && !result.error ? 'completed' : 'failed',
    command: `${input.pythonBin} ${commandArgs.join(' ')}`,
    split: evalSplit,
    stdout_path: relativeDisplayPath(stdoutPath, input.workingDirectory),
    stderr_path: relativeDisplayPath(stderrPath, input.workingDirectory),
    ...(fs.existsSync(scoreDestPath) ? { scores_path: relativeDisplayPath(scoreDestPath, input.workingDirectory) } : {}),
    latest_scores: fs.existsSync(scoreDestPath) ? readLatestScore(scoreDestPath) : undefined,
    exit_code: result.status,
    ...(result.error ? { reason: result.error.message } : {}),
  };
}

function renderReport(report: EnvBaselineReport): string {
  const scores = report.verifier.latest_scores || {};
  return [
    '# Guide TPC Environment Baseline',
    '',
    `Status: ${report.status}`,
    `Run ID: ${report.run_id}`,
    `Method: ${report.results_method_dir}`,
    '',
    '## Generation',
    '',
    `- generated: ${report.generation?.generated ?? 0}`,
    `- failed: ${report.generation?.failed ?? 0}`,
    `- dataset: ${report.dataset?.ref ?? ''}`,
    '',
    '## Verifier',
    '',
    `- status: ${report.verifier.status}`,
    `- split: ${report.verifier.split ?? ''}`,
    `- FPR: ${formatMaybeNumber(scores.FPR)}`,
    `- overall: ${formatMaybeNumber(scores.overall)}`,
    '',
    '## Eval Basis',
    '',
    `- profile: ${report.eval_basis.profile_artifact}`,
    `- eval analysis: ${report.eval_basis.eval_analysis_artifact}`,
    '',
    '## Next Repair Focus',
    '',
    ...report.next_repair_focus.map(item => `- ${item}`),
    '',
  ].join('\n');
}

function formatResult(report: EnvBaselineReport, workingDirectory: string): string {
  const scores = report.verifier.latest_scores || {};
  return [
    `guide_tpc_env_baseline: status=${report.status}`,
    `run_id=${report.run_id}`,
    `results_dir=${report.artifacts.results_dir || ''}`,
    `report=${report.artifacts.report_json_path}`,
    `report_md=${report.artifacts.report_md_path}`,
    `manifest=${report.artifacts.manifest_path}`,
    `zip=${report.artifacts.zip_path || ''}`,
    `generated=${report.generation?.generated ?? 0}`,
    `failed=${report.generation?.failed ?? 0}`,
    `verifier_status=${report.verifier.status}`,
    `verifier_split=${report.verifier.split || ''}`,
    `FPR=${formatMaybeNumber(scores.FPR)}`,
    `overall=${formatMaybeNumber(scores.overall)}`,
    `basis=${relativeDisplayPath(path.resolve(workingDirectory, report.eval_basis.eval_analysis_artifact), workingDirectory)}`,
    `next=${report.next_repair_focus.slice(0, 2).join(' | ')}`,
    ...(report.reason ? [`reason=${report.reason}`] : []),
  ].join('\n');
}

function buildManifest(input: {
  runId: string;
  status: string;
  outDir: string;
  workingDirectory: string;
  files: string[];
}): Record<string, unknown> {
  return {
    version: 1,
    run_id: input.runId,
    status: input.status,
    generated_at: new Date().toISOString(),
    out_dir: relativeDisplayPath(input.outDir, input.workingDirectory),
    files: input.files.map(file => relativeDisplayPath(file, input.workingDirectory)),
  };
}

function buildArtifactManifest(input: {
  resultsDir?: string;
  reportJsonPath?: string;
  reportMdPath?: string;
  manifestPath?: string;
  runnerPath?: string;
  configPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  zipPath?: string;
  verifierScoresPath?: string;
  verifierStdoutPath?: string;
  verifierStderrPath?: string;
  workingDirectory: string;
}): ArtifactManifestItem[] {
  return uniqueArtifacts([
    artifact(input.resultsDir, 'directory', 'generated', 'prediction_results', input.workingDirectory),
    artifact(input.reportJsonPath, 'json', 'generated', 'env_baseline_report', input.workingDirectory),
    artifact(input.reportMdPath, 'markdown', 'generated', 'human_report', input.workingDirectory),
    artifact(input.manifestPath, 'json', 'generated', 'run_manifest', input.workingDirectory),
    artifact(input.runnerPath, 'python', 'generated', 'env_baseline_runner', input.workingDirectory),
    artifact(input.configPath, 'json', 'generated', 'runner_config', input.workingDirectory),
    artifact(input.stdoutPath, 'log', 'captured', 'runner_stdout', input.workingDirectory),
    artifact(input.stderrPath, 'log', 'captured', 'runner_stderr', input.workingDirectory),
    artifact(input.zipPath, 'zip', 'generated', 'submission_zip', input.workingDirectory),
    artifact(input.verifierScoresPath, 'json', 'captured', 'official_verifier_scores', input.workingDirectory),
    artifact(input.verifierStdoutPath, 'log', 'captured', 'verifier_stdout', input.workingDirectory),
    artifact(input.verifierStderrPath, 'log', 'captured', 'verifier_stderr', input.workingDirectory),
  ].filter((item): item is ArtifactManifestItem => Boolean(item)));
}

function artifact(
  pathname: string | undefined,
  type: string,
  action: ArtifactManifestItem['action'],
  artifactRole: string,
  workingDirectory: string,
): ArtifactManifestItem | undefined {
  if (!pathname || !fs.existsSync(pathname)) {
    return undefined;
  }
  return {
    path: relativeDisplayPath(pathname, workingDirectory),
    type,
    action,
    metadata: {
      source: 'tool_owned',
      role: 'guide',
      tool: 'guide_tpc_env_baseline',
      artifact_role: artifactRole,
    },
  };
}

function existingArtifactPaths(paths: Record<string, string | undefined>): string[] {
  return Object.values(paths).filter((pathname): pathname is string => Boolean(pathname && fs.existsSync(pathname)));
}

function createSubmissionZip(outDir: string, teamName: string, version: string, rootToZip: string): string | undefined {
  const zipPath = path.join(outDir, `${teamName}_v${version}.zip`);
  const result = spawnSync('zip', ['-qr', path.basename(zipPath), rootToZip], {
    cwd: outDir,
    encoding: 'utf-8',
  });
  return result.error || result.status !== 0 || !fs.existsSync(zipPath) ? undefined : zipPath;
}

function readLatestScore(scorePath: string): Record<string, number> | undefined {
  const text = fs.readFileSync(scorePath, 'utf-8');
  const matches = text.match(/\{[^{}]*\}/g);
  if (!matches?.length) {
    return undefined;
  }
  try {
    return JSON.parse(matches[matches.length - 1]) as Record<string, number>;
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function createRunId(): string {
  return `guide-env-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

function normalizeMethodName(value: unknown): string {
  const raw = readString(value, DEFAULT_METHOD).trim() || DEFAULT_METHOD;
  return safeSegment(raw.replace(/_en$/i, ''));
}

function resolveOutputDir(workingDirectory: string, value: unknown, runId: string): string {
  const raw = readString(value, path.join('output', 'guide', 'tpc-env-baseline', runId));
  const resolved = path.resolve(workingDirectory, raw);
  const relative = path.relative(workingDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`out_dir must stay inside working directory: ${raw}`);
  }
  return resolved;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

function readJson(pathname: string): unknown {
  return JSON.parse(fs.readFileSync(pathname, 'utf-8'));
}

function writeJson(pathname: string, value: unknown): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function relativeDisplayPath(pathname: string, workingDirectory: string): string {
  const relative = path.relative(workingDirectory, pathname);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : datasetRef(pathname);
}

function datasetRef(pathname: string): string {
  const home = process.env.HOME;
  return home && pathname.startsWith(home) ? pathname.replace(home, '$HOME') : pathname;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...<truncated>`;
}

function parseKeyValueLines(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) {
      result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return result;
}

function uniqueArtifacts(items: ArtifactManifestItem[]): ArtifactManifestItem[] {
  const seen = new Set<string>();
  const result: ArtifactManifestItem[] = [];
  for (const item of items) {
    const key = `${item.path}:${item.type}:${item.action}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function formatMaybeNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

const PYTHON_RUNNER_SOURCE = String.raw`#!/usr/bin/env python3
import json
import math
import re
import shutil
import sys
import traceback
from copy import deepcopy
from pathlib import Path


def minutes(value):
    hour, minute = str(value).split(":")
    return int(hour) * 60 + int(minute)


def le(left, right):
    return minutes(left) <= minutes(right)


def is_open(row, start, end):
    opentime = str(row.get("opentime", "00:00"))
    endtime = str(row.get("endtime", "23:59"))
    if opentime == "不营业" or endtime == "不营业":
        return False
    try:
        return le(opentime, start) and le(end, endtime)
    except Exception:
        return False


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    official_repo_dir = Path(config["official_repo_dir"])
    dataset_dir = Path(config["dataset_dir"])
    results_dir = Path(config["results_dir"])
    limit = config.get("limit")

    sys.path.insert(0, str(official_repo_dir))
    global evaluate_constraints_py
    from chinatravel.environment.tools.intercity_transport.apis import IntercityTransport
    from chinatravel.environment.tools.accommodations.apis import Accommodations
    from chinatravel.environment.tools.restaurants.apis import Restaurants
    from chinatravel.environment.tools.attractions.apis import Attractions
    from chinatravel.environment.tools.transportation.apis import Transportation
    import chinatravel.evaluation.commonsense_constraint as commonsense_eval
    from chinatravel.symbol_verification.hard_constraint import evaluate_constraints_py, _set_tool_lang

    intercity = IntercityTransport(lang="en")
    hotels = Accommodations(lang="en")
    restaurants = Restaurants(lang="en")
    attractions = Attractions(lang="en")
    transportation = Transportation(lang="en")
    commonsense_eval.tqdm = lambda iterable, total=None: iterable
    _set_tool_lang("en")

    if results_dir.exists():
        shutil.rmtree(results_dir)
    results_dir.mkdir(parents=True, exist_ok=True)

    task_files = sorted(dataset_dir.glob("*.json"))
    selected_files = task_files[:limit] if limit else task_files
    generated_uids = []
    failures = []
    repair_stats = {
        "base_all": 0,
        "new_all": 0,
        "improved": 0,
        "commonsense_lost": 0,
        "actions": {},
        "examples": [],
    }

    for task_file in selected_files:
        task = json.loads(task_file.read_text())
        try:
            base_plan = build_plan(task, intercity, hotels, restaurants, transportation)
            plan, repair_info = repair_plan(
                task,
                base_plan,
                intercity,
                hotels,
                restaurants,
                attractions,
                transportation,
                commonsense_eval.evaluate_commonsense_constraints,
            )
            merge_repair_stats(repair_stats, task, repair_info)
            (results_dir / f"{task['uid']}.json").write_text(
                json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
            )
            generated_uids.append(task["uid"])
        except Exception as exc:
            failures.append({
                "uid": task.get("uid", task_file.stem),
                "error": repr(exc),
                "traceback": traceback.format_exc(limit=4),
            })

    report = {
        "version": 1,
        "files_total": len(task_files),
        "files_processed": len(selected_files),
        "generated": len(generated_uids),
        "failed": len(failures),
        "generated_uids": generated_uids,
        "failures": failures[:50],
        "strategy": "environment_bound_minimal_itinerary",
        "notes": [
            "first activity is official go intercity transport",
            "last activity is official return intercity transport",
            "hotel, lunch, dinner, and taxi transports are selected from official environment tools",
            "minimal verifier-filtered repairs first prune chronology conflicts, then insert or replace official attractions, restaurants, accommodations, or lower-cost inner-city transports only when commonsense remains passing",
        ],
        "repair": repair_stats,
    }
    (results_dir.parent.parent / "generation-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({
        "generated": len(generated_uids),
        "failed": len(failures),
        "results_dir": str(results_dir),
    }, ensure_ascii=False))


def build_plan(task, intercity, hotels, restaurants, transportation):
    people = int(task["people_number"])
    days = int(task["days"])
    start_city = task["start_city"]
    target_city = task["target_city"]
    logic = "\n".join(task.get("hard_logic_py", []))

    go_preferred, back_preferred = preferred_route_modes(logic)

    go_kind, go_row = pick_any_route(intercity, start_city, target_city, go_preferred, "06:00")
    back_kind, back_row = pick_any_route(intercity, target_city, start_city, back_preferred, "13:00")
    hotel, room_type, rooms = choose_hotel(hotels, target_city, people, logic)
    restaurant_pool = choose_restaurants(restaurants, target_city, days * 2 + 2)
    restaurant_index = 0
    itinerary = []
    previous_global = None

    for day in range(1, days + 1):
        activities = []
        if day == 1:
            activities.append(route_activity(go_kind, go_row, people))
            previous = str(go_row["To"])
        else:
            previous = previous_global or str(hotel["name"])
            activities.append({
                "type": "breakfast",
                "position": str(hotel["name"]),
                "start_time": "08:00",
                "end_time": "08:30",
                "price": 0,
                "cost": 0,
                "transports": [] if previous == str(hotel["name"]) else goto(transportation, target_city, previous, str(hotel["name"]), "07:30", people),
            })
            previous = str(hotel["name"])

        if day < days:
            previous = add_meal(activities, transportation, target_city, "lunch", restaurant_pool[restaurant_index], "12:00", "13:00", people, previous)
            restaurant_index += 1
            previous = add_meal(activities, transportation, target_city, "dinner", restaurant_pool[restaurant_index], "18:00", "19:00", people, previous)
            restaurant_index += 1
            previous = add_hotel(activities, transportation, target_city, hotel, room_type, rooms, people, previous)
        else:
            previous = add_meal(activities, transportation, target_city, "lunch", restaurant_pool[restaurant_index], "12:00", "13:00", people, previous)
            restaurant_index += 1
            route_start = str(back_row["From"])
            transports = goto(transportation, target_city, previous, route_start, "13:05", people)
            if transports and minutes(transports[-1]["end_time"]) > minutes(str(back_row["BeginTime"])):
                back_kind, back_row = pick_any_route(intercity, target_city, start_city, back_preferred, transports[-1]["end_time"])
                route_start = str(back_row["From"])
            transports = goto(transportation, target_city, previous, route_start, "13:05", people)
            activities.append(route_activity(back_kind, back_row, people, transports))
            previous = str(back_row["To"])

        itinerary.append({"day": day, "activities": activities})
        previous_global = previous

    return {
        "people_number": people,
        "start_city": start_city,
        "target_city": target_city,
        "itinerary": itinerary,
    }


def choose_hotel(hotels, city, people, logic):
    required = 2 if "room_type(activity)!=2" in logic else 1 if "room_type(activity)!=1" in logic else 2 if people > 1 else 1
    dataframe = hotels.data[city]
    candidates = dataframe[dataframe["numbed"] == required]
    if candidates.empty:
        candidates = dataframe
    row = candidates.sort_values(["price", "id"]).reset_index(drop=True).iloc[0]
    room_type = int(row["numbed"])
    rooms = math.ceil(people / room_type) if room_type > 0 else 1
    return row, room_type, rooms


def choose_restaurants(restaurants, city, count):
    dataframe = restaurants.data[city]
    usable = []
    for _, row in dataframe.iterrows():
        if is_open(row, "12:00", "13:00") and is_open(row, "18:00", "19:00"):
            usable.append(row)
    usable = sorted(usable, key=lambda row: (float(row["price"]), int(row["id"])))
    if len(usable) < count:
        usable = list(dataframe.sort_values(["price", "id"]).itertuples(index=False))
    return usable


def pick_route(intercity, start_city, end_city, kind, earliest):
    dataframe = intercity.select(start_city, end_city, kind, earliest_leave_time=earliest)
    if dataframe is None or isinstance(dataframe, str) or len(dataframe) == 0:
        return None
    return dataframe.sort_values(["Cost", "BeginTime"]).iloc[0].to_dict()


def preferred_route_modes(logic):
    go = "train"
    back = "train"
    go_expr = "allactivities(plan)[0]['type']"
    back_expr = "allactivities(plan)[-1]['type']"
    if f"{go_expr} == \"airplane\"" in logic or f"{go_expr} != \"train\"" in logic:
        go = "airplane"
    if f"{go_expr} == \"train\"" in logic or f"{go_expr} != \"airplane\"" in logic:
        go = "train"
    if f"{back_expr} == \"airplane\"" in logic or f"{back_expr} != \"train\"" in logic:
        back = "airplane"
    if f"{back_expr} == \"train\"" in logic or f"{back_expr} != \"airplane\"" in logic:
        back = "train"
    return go, back


def allowed_route_modes(logic, route_expr):
    if f"{route_expr} == \"airplane\"" in logic or f"{route_expr} != \"train\"" in logic:
        return ["airplane"]
    if f"{route_expr} == \"train\"" in logic or f"{route_expr} != \"airplane\"" in logic:
        return ["train"]
    return ["airplane", "train"]


def pick_any_route(intercity, start_city, end_city, preferred, earliest):
    alternate = "airplane" if preferred == "train" else "train"
    attempts = [
        (preferred, earliest),
        (preferred, "00:00"),
        (alternate, earliest),
        (alternate, "00:00"),
    ]
    for kind, earliest_time in attempts:
        route = pick_route(intercity, start_city, end_city, kind, earliest_time)
        if route:
            return kind, route
    raise RuntimeError(f"no route {start_city}->{end_city}")


def pick_cheapest_route(intercity, start_city, end_city, allowed_modes):
    best = None
    for kind in allowed_modes:
        route = pick_route(intercity, start_city, end_city, kind, "00:00")
        if route is None:
            continue
        score = (float(route["Cost"]), str(route["BeginTime"]))
        if best is None or score < best[0]:
            best = (score, kind, route)
    if best is None:
        return None, None
    return best[1], best[2]


def route_activity(kind, row, people, transports=None):
    activity = {
        "type": kind,
        "start": str(row["From"]),
        "end": str(row["To"]),
        "start_time": str(row["BeginTime"]),
        "end_time": str(row["EndTime"]),
        "price": float(row["Cost"]),
        "cost": float(row["Cost"]) * people,
        "tickets": people,
        "transports": transports or [],
    }
    if kind == "train":
        activity["TrainID"] = str(row["TrainID"])
    else:
        activity["FlightID"] = str(row["FlightID"])
    return activity


def normalize_transport(segment, people):
    item = dict(segment)
    item["price"] = float(item.get("cost", 0))
    if item["mode"] == "walk":
        item["cost"] = 0
    elif item["mode"] == "metro":
        item["tickets"] = people
        item["cost"] = item["price"] * people
    elif item["mode"] == "taxi":
        item["cars"] = math.ceil(people / 4)
        item["cost"] = item["price"] * item["cars"]
    return item


def goto(transportation, city, start, end, start_time, people, preferred_mode="taxi"):
    if start == end:
        return []
    modes = []
    for mode in [preferred_mode, "taxi", "metro", "walk"]:
        if mode not in modes:
            modes.append(mode)
    result = None
    for mode in modes:
        result = transportation.goto(city, start, end, start_time, mode, verbose=False)
        if isinstance(result, list):
            break
    if not isinstance(result, list):
        return []
    return [normalize_transport(segment, people) for segment in result]


def add_meal(activities, transportation, city, meal_type, row, start_time, end_time, people, previous):
    depart_time = "11:15" if meal_type == "lunch" else "17:15"
    transports = goto(transportation, city, previous, str(row["name"]), depart_time, people)
    if transports and minutes(transports[-1]["end_time"]) > minutes(start_time):
        transports = goto(transportation, city, previous, str(row["name"]), "10:30" if meal_type == "lunch" else "16:30", people)
    activities.append({
        "type": meal_type,
        "position": str(row["name"]),
        "start_time": start_time,
        "end_time": end_time,
        "price": float(row["price"]),
        "cost": float(row["price"]) * people,
        "transports": transports,
    })
    return str(row["name"])


def add_hotel(activities, transportation, city, hotel, room_type, rooms, people, previous):
    name = str(hotel["name"])
    transports = goto(transportation, city, previous, name, "19:10", people)
    if transports and minutes(transports[-1]["end_time"]) > minutes("20:00"):
        transports = goto(transportation, city, previous, name, "18:30", people)
    activities.append({
        "type": "accommodation",
        "position": name,
        "start_time": "20:00",
        "end_time": "23:59",
        "price": float(hotel["price"]),
        "cost": float(hotel["price"]) * rooms,
        "room_type": room_type,
        "rooms": rooms,
        "transports": transports,
    })
    return name


DOUBLE_QUOTE_RE = re.compile(r'"([^"]+)"')
SINGLE_QUOTE_RE = re.compile(r"'([^']+)'")
POSITION_RE = re.compile(r"activity_position\(activity\)==['\"](.+)['\"]:", re.MULTILINE)
START_BEFORE_RE = re.compile(r"activity_start_time\(activity\)<='(\d{2}:\d{2})'")
END_AFTER_RE = re.compile(r"activity_end_time\(activity\)>='(\d{2}:\d{2})'")
DURATION_AT_LEAST_RE = re.compile(r"activity_time\(activity\)>=(\d+)")
HOTEL_DISTANCE_RE = re.compile(
    r"poi_distance\(target_city\(plan\), ['\"](.+)['\"], accommodation_position\)<=([0-9.]+)"
)
IGNORED_LOGIC_VALUES = {
    "attraction",
    "airplane",
    "train",
    "breakfast",
    "lunch",
    "dinner",
    "accommodation",
    "metro",
    "taxi",
    "walk",
}
ENTITY_SET_NAMES = {
    "attraction_names": "attraction_name_set",
    "attraction_types": "attraction_type_set",
    "restaurant_names": "restaurant_name_set",
    "restaurant_types": "restaurant_type_set",
    "hotel_names": "accommodation_name_set",
    "hotel_types": "accommodation_type_set",
}


def quoted_values(logic):
    values = DOUBLE_QUOTE_RE.findall(logic)
    if values:
        return values
    return SINGLE_QUOTE_RE.findall(logic)


def set_values(logic, set_name):
    values = []
    scrubbed = re.sub(r"not\s*\(\s*\{[^}]*\}\s*&\s*\w+_set\s*\)", "", logic)
    pattern = re.compile(r"\{([^}]*)\}\s*(?:<=|&)\s*" + re.escape(set_name))
    for blob in pattern.findall(scrubbed):
        for value in quoted_values(blob):
            if value not in IGNORED_LOGIC_VALUES:
                values.append(value)
    return values


def forbidden_set_values(logic, set_name):
    values = []
    pattern = re.compile(r"not\s*\(\s*\{([^}]*)\}\s*&\s*" + re.escape(set_name))
    for blob in pattern.findall(logic):
        for value in quoted_values(blob):
            if value not in IGNORED_LOGIC_VALUES:
                values.append(value)
    return values


def merge_repair_stats(stats, task, repair_info):
    base_eval = repair_info["base_eval"]
    new_eval = repair_info["new_eval"]
    base_all = base_eval["commonsense"] and base_eval["hard_full"]
    new_all = new_eval["commonsense"] and new_eval["hard_full"]
    stats["base_all"] += int(base_all)
    stats["new_all"] += int(new_all)
    if new_eval["hard_count"] > base_eval["hard_count"] or (new_all and not base_all):
        stats["improved"] += 1
        if len(stats["examples"]) < 50:
            stats["examples"].append({
                "uid": task["uid"],
                "actions": repair_info["actions"],
                "base_hard": base_eval["hard_count"],
                "new_hard": new_eval["hard_count"],
                "logic_count": len(task.get("hard_logic_py", [])),
                "new_full": bool(new_eval["hard_full"]),
            })
    if base_eval["commonsense"] and not new_eval["commonsense"]:
        stats["commonsense_lost"] += 1
    for action in repair_info["actions"]:
        stats["actions"][action] = stats["actions"].get(action, 0) + 1


def repair_plan(task, base_plan, intercity, hotels, restaurants, attractions, transportation, evaluate_commonsense_constraints):
    base_eval = evaluate_plan(task, base_plan, evaluate_commonsense_constraints)
    best_plan = deepcopy(base_plan)
    best_eval = base_eval
    actions = []

    if not best_eval["commonsense"]:
        candidate_plan = apply_chronology_candidate(deepcopy(best_plan), transportation)
        candidate_eval = evaluate_plan(task, candidate_plan, evaluate_commonsense_constraints)
        if candidate_eval["commonsense"] and candidate_eval["hard_count"] >= best_eval["hard_count"]:
            best_plan = candidate_plan
            best_eval = candidate_eval
            actions.append("chronology")

    if not best_eval["commonsense"]:
        return best_plan, {
            "base_eval": base_eval,
            "new_eval": best_eval,
            "actions": actions,
        }

    requirements = parse_entity_requirements(task)
    forbidden = parse_forbidden_requirements(task)
    candidates = []
    hotel_distance_requirements = parse_hotel_distance_requirements(task)
    hotel = None
    if (
        requirements["hotel_names"]
        or requirements["hotel_types"]
        or forbidden["hotel_types"]
        or hotel_distance_requirements
    ):
        hotel = pick_hotel_satisfying(
            hotels,
            transportation,
            task["target_city"],
            requirements,
            forbidden,
            hotel_distance_requirements,
        )
    if hotel is not None:
        candidates.append(("hotel_smart", lambda plan, row=hotel: apply_hotel_candidate(plan, row, transportation)))

    if hotel_distance_requirements:
        candidates.append((
            "hotel_distance",
            lambda plan, reqs=hotel_distance_requirements: apply_hotel_distance_candidate(
                plan,
                reqs,
                hotels,
                transportation,
            ),
        ))

    restaurant_rows = pick_restaurant_candidates(restaurants, task["target_city"], requirements, len(meal_slots(base_plan)))
    if not restaurant_rows:
        restaurant_rows = pick_non_forbidden_restaurants(
            restaurants,
            task["target_city"],
            forbidden,
            len(meal_slots(base_plan)),
        )
    if restaurant_rows:
        candidates.append(("restaurants", lambda plan, rows=restaurant_rows: apply_restaurant_candidates(plan, rows, transportation)))

    attraction_rows = pick_attraction_candidates(attractions, task["target_city"], requirements, 4)
    if attraction_rows:
        candidates.append(("attractions", lambda plan, rows=attraction_rows: apply_attraction_candidates(plan, rows, transportation)))

    candidates.append((
        "intercity_cheapest",
        lambda plan: apply_intercity_cheapest_candidate(plan, task, intercity, transportation),
    ))

    time_place_requirements = parse_time_place_requirements(task)
    if time_place_requirements:
        candidates.append((
            "time_place",
            lambda plan, reqs=time_place_requirements: apply_time_place_candidates(
                plan,
                reqs,
                hotels,
                restaurants,
                attractions,
                transportation,
            ),
        ))

    if has_innercity_budget_requirement(task):
        candidates.append((
            "budget_prune_metro",
            lambda plan: apply_budget_prune_candidate(plan, task, hotels, transportation, "metro"),
        ))
        candidates.append((
            "budget_prune_walk",
            lambda plan: apply_budget_prune_candidate(plan, task, hotels, transportation, "walk"),
        ))

    candidates.append(("transport_metro", lambda plan: recompute_innercity_transports(plan, transportation, "metro")))
    candidates.append(("transport_walk", lambda plan: recompute_innercity_transports(plan, transportation, "walk")))

    for action, mutate in candidates:
        candidate_plan = mutate(deepcopy(best_plan))
        candidate_eval = evaluate_plan(task, candidate_plan, evaluate_commonsense_constraints)
        if candidate_eval["commonsense"] and (
            candidate_eval["hard_count"] > best_eval["hard_count"]
            or (candidate_eval["hard_full"] and not best_eval["hard_full"])
        ):
            best_plan = candidate_plan
            best_eval = candidate_eval
            actions.append(action)

    return best_plan, {
        "base_eval": base_eval,
        "new_eval": best_eval,
        "actions": actions,
    }


def evaluate_plan(task, plan, evaluate_commonsense_constraints):
    uid = task["uid"]
    try:
        _, _, _, pass_ids = evaluate_commonsense_constraints(
            [uid],
            {uid: task},
            {uid: plan},
            verbose=False,
            lang="en",
        )
        commonsense = uid in pass_ids
    except Exception:
        commonsense = False

    try:
        hard = evaluate_constraints_py(task.get("hard_logic_py", []), plan, verbose=False)
    except Exception:
        hard = [False] * len(task.get("hard_logic_py", []))

    return {
        "commonsense": commonsense,
        "hard_count": sum(1 for item in hard if item),
        "hard_full": bool(hard) and all(hard),
        "hard": hard,
    }


def parse_entity_requirements(task):
    requirements = {
        "attraction_names": [],
        "attraction_types": [],
        "restaurant_names": [],
        "restaurant_types": [],
        "hotel_names": [],
        "hotel_types": [],
    }
    for logic in task.get("hard_logic_py", []):
        for key, set_name in ENTITY_SET_NAMES.items():
            requirements[key].extend(set_values(logic, set_name))

    for key, values in requirements.items():
        seen = []
        for value in values:
            if value not in seen:
                seen.append(value)
        requirements[key] = seen
    return requirements


def parse_forbidden_requirements(task):
    requirements = {key: [] for key in ENTITY_SET_NAMES}
    for logic in task.get("hard_logic_py", []):
        for key, set_name in ENTITY_SET_NAMES.items():
            requirements[key].extend(forbidden_set_values(logic, set_name))
    for key, values in requirements.items():
        seen = []
        for value in values:
            if value not in seen:
                seen.append(value)
        requirements[key] = seen
    return requirements


def parse_time_place_requirements(task):
    requirements = []
    for logic in task.get("hard_logic_py", []):
        positions = [name.strip() for name in POSITION_RE.findall(logic) if name.strip()]
        if not positions:
            continue
        if "idx_activity0<idx_activity1" in logic and len(positions) >= 2:
            requirements.append({
                "kind": "order",
                "names": positions[:2],
            })
            continue
        requirement = {
            "kind": "time",
            "name": positions[0],
            "start_before": None,
            "end_after": None,
            "min_duration": None,
        }
        start_match = START_BEFORE_RE.search(logic)
        end_match = END_AFTER_RE.search(logic)
        duration_match = DURATION_AT_LEAST_RE.search(logic)
        if start_match:
            requirement["start_before"] = start_match.group(1)
        if end_match:
            requirement["end_after"] = end_match.group(1)
        if duration_match:
            requirement["min_duration"] = int(duration_match.group(1))
        if requirement["start_before"] or requirement["end_after"] or requirement["min_duration"]:
            requirements.append(requirement)
    return requirements


def parse_hotel_distance_requirements(task):
    requirements = []
    for logic in task.get("hard_logic_py", []):
        for poi_name, distance in HOTEL_DISTANCE_RE.findall(logic):
            requirements.append({
                "poi": poi_name.strip(),
                "max_distance": float(distance),
            })
    return requirements


def has_innercity_budget_requirement(task):
    logic = "\n".join(task.get("hard_logic_py", []))
    return "inner_city_transportation_cost" in logic or "total_cost" in logic


def required_position_names(task):
    names = set()
    entity_requirements = parse_entity_requirements(task)
    for key in ["attraction_names", "restaurant_names", "hotel_names"]:
        names.update(entity_requirements.get(key, []))
    for requirement in parse_time_place_requirements(task):
        if requirement.get("kind") == "order":
            names.update(requirement.get("names", []))
        elif requirement.get("name"):
            names.add(requirement["name"])
    return names


def has_positive_entity_type_requirement(task, prefix):
    for logic in task.get("hard_logic_py", []):
        if prefix not in logic:
            continue
        if "result=not" in logic or "not({" in logic:
            continue
        return True
    return False


def get_city_data(tool, city):
    if city not in tool.data:
        return None
    return tool.data[city]


def row_by_name(dataframe, name):
    hits = dataframe[dataframe["name"] == name]
    if hits.empty:
        return None
    return hits.iloc[0]


def find_named_place(hotels, restaurants, attractions, city, name):
    restaurant_data = get_city_data(restaurants, city)
    if restaurant_data is not None:
        row = row_by_name(restaurant_data, name)
        if row is not None:
            return "restaurant", row
    attraction_data = get_city_data(attractions, city)
    if attraction_data is not None:
        row = row_by_name(attraction_data, name)
        if row is not None:
            return "attraction", row
    hotel_data = get_city_data(hotels, city)
    if hotel_data is not None:
        row = row_by_name(hotel_data, name)
        if row is not None:
            return "hotel", row
    return None, None


def pick_hotel_candidate(hotels, city, requirements):
    dataframe = get_city_data(hotels, city)
    if dataframe is None:
        return None
    for name in requirements["hotel_names"]:
        row = row_by_name(dataframe, name)
        if row is not None:
            return row
    for hotel_type in requirements["hotel_types"]:
        candidates = dataframe[dataframe["featurehoteltype"] == hotel_type]
        if not candidates.empty:
            return candidates.sort_values(["price", "id"]).iloc[0]
        normalized = str(hotel_type).casefold()
        candidates = dataframe[
            dataframe["featurehoteltype"].astype(str).str.casefold().map(
                lambda value: value == normalized or normalized in value or value in normalized
            )
        ]
        if not candidates.empty:
            return candidates.sort_values(["price", "id"]).iloc[0]
    return None


def pick_hotel_satisfying(hotels, transportation, city, requirements, forbidden, distance_requirements):
    dataframe = get_city_data(hotels, city)
    if dataframe is None:
        return None
    candidates = dataframe
    if requirements["hotel_names"]:
        hits = dataframe[dataframe["name"].isin(requirements["hotel_names"])]
        if not hits.empty:
            candidates = hits
    if requirements["hotel_types"]:
        hits = dataframe[dataframe["featurehoteltype"].astype(str).isin(requirements["hotel_types"])]
        if not hits.empty:
            candidates = hits
    if forbidden.get("hotel_types"):
        candidates = candidates[~candidates["featurehoteltype"].astype(str).isin(forbidden["hotel_types"])]
    if candidates.empty:
        return None

    best = None
    best_score = None
    for _, row in candidates.iterrows():
        name = str(row["name"])
        distance_sum = 0.0
        distance_ok = True
        for requirement in distance_requirements:
            distance = transport_distance(transportation, city, requirement["poi"], name, "walk")
            if distance is None:
                distance_ok = False
                distance_sum = 999999
                break
            distance_sum += distance
            if distance > requirement["max_distance"]:
                distance_ok = False
        try:
            price = float(row["price"])
        except Exception:
            price = 999999
        score = (0 if distance_ok else 1, distance_sum, price, int(row.get("id", 999999)))
        if best_score is None or score < best_score:
            best = row
            best_score = score
    return best


def transport_distance(transportation, city, start, end, mode="walk"):
    try:
        result = transportation.goto(city, start, end, "00:00", mode, verbose=False)
    except Exception:
        return None
    if not isinstance(result, list) or not result:
        return None
    distance = 0.0
    for segment in result:
        try:
            distance += float(segment.get("distance", 0))
        except Exception:
            return None
    return distance


def pick_hotel_near_poi(hotels, transportation, city, poi, max_distance):
    dataframe = get_city_data(hotels, city)
    if dataframe is None:
        return None
    best = None
    best_score = None
    for _, row in dataframe.iterrows():
        name = str(row["name"])
        distance = transport_distance(transportation, city, poi, name, "walk")
        if distance is None:
            continue
        try:
            price = float(row["price"])
        except Exception:
            price = 999999
        within = distance <= max_distance
        score = (0 if within else 1, distance, price, int(row.get("id", 999999)))
        if best_score is None or score < best_score:
            best = row
            best_score = score
            if within and distance <= max_distance * 0.35:
                break
    return best


def pick_restaurant_candidates(restaurants, city, requirements, count):
    dataframe = get_city_data(restaurants, city)
    if dataframe is None or count <= 0:
        return []
    rows = []
    for name in requirements["restaurant_names"]:
        row = row_by_name(dataframe, name)
        if row is not None:
            rows.append(row)
    for cuisine in requirements["restaurant_types"]:
        used = {str(row["name"]) for row in rows}
        candidates = dataframe[(dataframe["cuisine"] == cuisine) & (~dataframe["name"].isin(used))]
        if not candidates.empty:
            rows.append(candidates.sort_values(["price", "id"]).iloc[0])
    return rows[:count]


def pick_non_forbidden_restaurants(restaurants, city, forbidden, count):
    dataframe = get_city_data(restaurants, city)
    if dataframe is None or count <= 0:
        return []
    forbidden_types = forbidden.get("restaurant_types", [])
    if not forbidden_types:
        return []
    candidates = dataframe[~dataframe["cuisine"].astype(str).isin(forbidden_types)]
    if candidates.empty:
        return []
    return [row for _, row in candidates.sort_values(["price", "id"]).head(count).iterrows()]


def pick_attraction_candidates(attractions, city, requirements, count):
    dataframe = get_city_data(attractions, city)
    if dataframe is None or count <= 0:
        return []
    rows = []
    for name in requirements["attraction_names"]:
        row = row_by_name(dataframe, name)
        if row is not None:
            rows.append(row)
    for attraction_type in requirements["attraction_types"]:
        used = {str(row["name"]) for row in rows}
        candidates = dataframe[(dataframe["type"] == attraction_type) & (~dataframe["name"].isin(used))]
        if not candidates.empty:
            rows.append(candidates.sort_values(["price", "id"]).iloc[0])
    return rows[:count]


def meal_slots(plan):
    slots = []
    for day_index, day in enumerate(plan["itinerary"]):
        for activity_index, activity in enumerate(day["activities"]):
            if activity.get("type") in ["lunch", "dinner"]:
                slots.append((day_index, activity_index))
    return slots


def current_position(activity):
    if "position" in activity:
        return activity["position"]
    if "end" in activity:
        return activity["end"]
    return None


def required_origin(activity):
    if "position" in activity:
        return activity["position"]
    if "start" in activity:
        return activity["start"]
    return None


def activity_start(activity):
    try:
        return minutes(activity.get("start_time", "00:00"))
    except Exception:
        return 0


def activity_end(activity):
    try:
        return minutes(activity.get("end_time", activity.get("start_time", "00:00")))
    except Exception:
        return activity_start(activity)


def is_intercity(activity):
    return activity.get("type") in ["train", "airplane"]


def is_overnight_accommodation(activity):
    return activity.get("type") == "accommodation"


def activity_has_chronology_conflict(previous_end, activity):
    if is_overnight_accommodation(activity):
        return activity_start(activity) < previous_end and previous_end <= minutes("23:50")
    return activity_start(activity) < previous_end or activity_end(activity) < activity_start(activity)


def prune_after_first_intercity(day):
    activities = day.get("activities", [])
    if not activities or not is_intercity(activities[0]):
        return
    route_end = activity_end(activities[0])
    kept = [activities[0]]
    for activity in activities[1:]:
        if is_intercity(activity):
            kept.append(activity)
        elif not activity_has_chronology_conflict(route_end, activity):
            kept.append(activity)
            route_end = max(route_end, activity_end(activity))
    day["activities"] = kept


def prune_before_last_intercity(day):
    activities = day.get("activities", [])
    if not activities or not is_intercity(activities[-1]):
        return
    route = activities[-1]
    route_start = activity_start(route)
    kept = []
    previous_end = 0
    for activity in activities[:-1]:
        if activity_end(activity) <= route_start and not activity_has_chronology_conflict(previous_end, activity):
            kept.append(activity)
            previous_end = max(previous_end, activity_end(activity))
    kept.append(route)
    day["activities"] = kept


def prune_sequential_conflicts(day):
    kept = []
    previous_end = 0
    for activity in day.get("activities", []):
        if is_intercity(activity) or is_overnight_accommodation(activity) or not activity_has_chronology_conflict(previous_end, activity):
            kept.append(activity)
            previous_end = max(previous_end, activity_end(activity))
    day["activities"] = kept


def apply_chronology_candidate(plan, transportation):
    itinerary = plan.get("itinerary", [])
    if not itinerary:
        return plan
    prune_after_first_intercity(itinerary[0])
    prune_before_last_intercity(itinerary[-1])
    for day in itinerary:
        prune_sequential_conflicts(day)
    return recompute_innercity_transports(plan, transportation)


def shift_time(value, delta_minutes):
    return f"{max(1, min(23 * 60 + 50, minutes(value) + delta_minutes)) // 60:02d}:{max(1, min(23 * 60 + 50, minutes(value) + delta_minutes)) % 60:02d}"


def recompute_innercity_transports(plan, transportation, preferred_mode="taxi"):
    city = plan["target_city"]
    people = int(plan["people_number"])
    previous = None
    for day in plan["itinerary"]:
        for activity in day["activities"]:
            destination = required_origin(activity)
            if destination is not None:
                if previous is not None and previous != destination:
                    activity["transports"] = goto(
                        transportation,
                        city,
                        previous,
                        destination,
                        shift_time(activity.get("start_time", "12:00"), -180),
                        people,
                        preferred_mode,
                    )
                else:
                    activity["transports"] = []
            previous = current_position(activity) or previous
    return plan


def apply_hotel_candidate(plan, row, transportation):
    people = int(plan["people_number"])
    room_type = int(row["numbed"])
    rooms = math.ceil(people / room_type) if room_type > 0 else 1
    hotel_name = str(row["name"])
    for day in plan["itinerary"]:
        for activity in day["activities"]:
            if activity.get("type") == "accommodation":
                activity["position"] = hotel_name
                activity["price"] = float(row["price"])
                activity["cost"] = float(row["price"]) * rooms
                activity["room_type"] = room_type
                activity["rooms"] = rooms
            elif activity.get("type") == "breakfast":
                activity["position"] = hotel_name
    return recompute_innercity_transports(plan, transportation)


def apply_hotel_distance_candidate(plan, requirements, hotels, transportation):
    city = plan["target_city"]
    selected = None
    for requirement in requirements:
        selected = pick_hotel_near_poi(
            hotels,
            transportation,
            city,
            requirement["poi"],
            requirement["max_distance"],
        )
        if selected is not None:
            break
    if selected is None:
        return plan
    return apply_hotel_candidate(plan, selected, transportation)


def apply_intercity_cheapest_candidate(plan, task, intercity, transportation):
    people = int(plan["people_number"])
    logic = "\n".join(task.get("hard_logic_py", []))
    go_modes = allowed_route_modes(logic, "allactivities(plan)[0]['type']")
    back_modes = allowed_route_modes(logic, "allactivities(plan)[-1]['type']")
    go_kind, go_row = pick_cheapest_route(intercity, task["start_city"], task["target_city"], go_modes)
    back_kind, back_row = pick_cheapest_route(intercity, task["target_city"], task["start_city"], back_modes)
    if go_row is None or back_row is None:
        return plan
    itinerary = plan.get("itinerary", [])
    if not itinerary:
        return plan
    if itinerary[0].get("activities") and is_intercity(itinerary[0]["activities"][0]):
        itinerary[0]["activities"][0] = route_activity(go_kind, go_row, people)
    if itinerary[-1].get("activities") and is_intercity(itinerary[-1]["activities"][-1]):
        itinerary[-1]["activities"][-1] = route_activity(back_kind, back_row, people)
    return recompute_innercity_transports(plan, transportation)


def first_intercity_arrival(plan):
    itinerary = plan.get("itinerary", [])
    if itinerary and itinerary[0].get("activities") and is_intercity(itinerary[0]["activities"][0]):
        return itinerary[0]["activities"][0].get("end")
    return None


def should_keep_for_budget(activity, required_names, keep_attractions, keep_restaurants):
    activity_type_name = activity.get("type")
    position = activity.get("position")
    if is_intercity(activity) or activity_type_name == "accommodation":
        return True
    if activity_type_name == "breakfast" and position:
        return True
    if position and position in required_names:
        return True
    if activity_type_name == "attraction" and keep_attractions:
        return True
    if activity_type_name in ["lunch", "dinner"] and keep_restaurants:
        return True
    return False


def apply_budget_prune_candidate(plan, task, hotels, transportation, preferred_mode):
    required_names = required_position_names(task)
    keep_attractions = has_positive_entity_type_requirement(task, "attraction_type_set") or bool(
        parse_entity_requirements(task).get("attraction_names")
    )
    keep_restaurants = has_positive_entity_type_requirement(task, "restaurant_type_set") or bool(
        parse_entity_requirements(task).get("restaurant_names")
    )
    arrival = first_intercity_arrival(plan)
    if arrival:
        hotel = pick_hotel_near_poi(hotels, transportation, plan["target_city"], arrival, 9999)
        if hotel is not None:
            plan = apply_hotel_candidate(plan, hotel, transportation)

    for day in plan.get("itinerary", []):
        kept = [
            activity
            for activity in day.get("activities", [])
            if should_keep_for_budget(activity, required_names, keep_attractions, keep_restaurants)
        ]
        if not kept and day.get("activities"):
            kept = [day["activities"][0]]
        day["activities"] = kept
    return recompute_innercity_transports(plan, transportation, preferred_mode)


def apply_restaurant_candidates(plan, rows, transportation):
    people = int(plan["people_number"])
    slots = []
    for day_index, day in enumerate(plan.get("itinerary", [])):
        for activity_index, activity in enumerate(day.get("activities", [])):
            if activity.get("type") in ["lunch", "dinner"] and day_can_host(
                day,
                activity.get("start_time", "12:00"),
                activity.get("end_time", "13:00"),
            ):
                slots.append((day_index, activity_index))
    if not slots:
        slots = meal_slots(plan)
    for row, (day_index, activity_index) in zip(rows, slots):
        activity = plan["itinerary"][day_index]["activities"][activity_index]
        activity["position"] = str(row["name"])
        activity["price"] = float(row["price"])
        activity["cost"] = float(row["price"]) * people
    return recompute_innercity_transports(plan, transportation)


def make_attraction_activity(row, start_time, end_time, people):
    return {
        "type": "attraction",
        "position": str(row["name"]),
        "start_time": start_time,
        "end_time": end_time,
        "price": float(row["price"]),
        "cost": float(row["price"]) * people,
        "tickets": people,
        "transports": [],
    }


def insert_activity_sorted(day, activity):
    activities = day.get("activities", [])
    first = []
    last = []
    middle = activities
    if middle and is_intercity(middle[0]):
        first = [middle[0]]
        middle = middle[1:]
    if middle and is_intercity(middle[-1]):
        last = [middle[-1]]
        middle = middle[:-1]
    middle.append(activity)
    middle.sort(key=lambda item: (activity_start(item), 1 if is_overnight_accommodation(item) else 0))
    day["activities"] = first + middle + last


def apply_attraction_candidates(plan, rows, transportation):
    people = int(plan["people_number"])
    time_slots = [
        ("09:00", "10:00"),
        ("10:10", "11:10"),
        ("11:20", "12:20"),
        ("14:20", "15:20"),
        ("15:30", "16:30"),
        ("17:00", "18:00"),
    ]
    used = set()
    changed = False
    for row in rows:
        name = str(row["name"])
        if name in used:
            continue
        if existing_activity_indices(plan, name):
            used.add(name)
            continue
        placed = False
        for start_time, end_time in time_slots:
            if not is_open(row, start_time, end_time):
                continue
            for day_index in preferred_day_indices(plan, start_time, end_time):
                day = plan["itinerary"][day_index]
                if not day_can_host(day, start_time, end_time):
                    continue
                activity = make_attraction_activity(row, start_time, end_time, people)
                insert_activity_sorted(day, activity)
                used.add(name)
                changed = True
                placed = True
                break
            if placed:
                break
    if changed:
        return recompute_innercity_transports(plan, transportation)
    return plan


def format_minutes(value):
    value = max(1, min(23 * 60 + 50, int(value)))
    return f"{value // 60:02d}:{value % 60:02d}"


def choose_activity_window(requirement, place_kind):
    min_duration = int(requirement.get("min_duration") or 60)
    start_before = requirement.get("start_before")
    end_after = requirement.get("end_after")
    if start_before and end_after:
        start = minutes(start_before)
        end = max(minutes(end_after), start + min_duration)
        return format_minutes(start), format_minutes(end)
    if start_before:
        end = minutes(start_before)
        start = end - min_duration
        if place_kind == "restaurant" and end <= minutes("12:30"):
            start = min(start, minutes("11:00"))
        return format_minutes(start), format_minutes(end)
    if end_after:
        end = minutes(end_after)
        start = end - min_duration
        if place_kind == "restaurant" and end <= minutes("12:30"):
            start = min(start, minutes("11:00"))
            end = max(end, minutes("12:00"))
        elif place_kind == "restaurant" and end >= minutes("17:00"):
            start = min(max(start, minutes("17:00")), minutes("18:30"))
            end = max(end, start + min_duration)
        return format_minutes(start), format_minutes(end)
    if place_kind == "restaurant":
        return "12:00", format_minutes(minutes("12:00") + min_duration)
    return "09:00", format_minutes(minutes("09:00") + max(min_duration, 90))


def restaurant_meal_type(start_time, end_time):
    midpoint = (minutes(start_time) + minutes(end_time)) // 2
    if midpoint < minutes("10:00"):
        return "breakfast"
    if midpoint < minutes("15:30"):
        return "lunch"
    return "dinner"


def make_restaurant_activity(row, start_time, end_time, people):
    return {
        "type": restaurant_meal_type(start_time, end_time),
        "position": str(row["name"]),
        "start_time": start_time,
        "end_time": end_time,
        "price": float(row["price"]),
        "cost": float(row["price"]) * people,
        "transports": [],
    }


def make_hotel_activity(row, start_time, end_time, people):
    room_type = int(row["numbed"])
    rooms = math.ceil(people / room_type) if room_type > 0 else 1
    return {
        "type": "accommodation",
        "position": str(row["name"]),
        "start_time": start_time,
        "end_time": end_time,
        "price": float(row["price"]),
        "cost": float(row["price"]) * rooms,
        "room_type": room_type,
        "rooms": rooms,
        "transports": [],
    }


def time_window_is_usable(row, start_time, end_time, place_kind):
    if place_kind == "hotel":
        return True
    try:
        return is_open(row, start_time, end_time)
    except Exception:
        return False


def existing_activity_indices(plan, name):
    matches = []
    for day_index, day in enumerate(plan.get("itinerary", [])):
        for activity_index, activity in enumerate(day.get("activities", [])):
            if activity.get("position") == name:
                matches.append((day_index, activity_index))
    return matches


def day_can_host(day, start_time, end_time):
    activities = day.get("activities", [])
    if activities and is_intercity(activities[0]) and activity_end(activities[0]) > minutes(start_time):
        return False
    if activities and is_intercity(activities[-1]) and activity_start(activities[-1]) < minutes(end_time):
        return False
    return True


def preferred_day_indices(plan, start_time, end_time):
    itinerary = plan.get("itinerary", [])
    middle = [idx for idx in range(1, max(1, len(itinerary) - 1))]
    ordered = middle + list(range(len(itinerary)))
    seen = []
    for idx in ordered:
        if idx not in seen and day_can_host(itinerary[idx], start_time, end_time):
            seen.append(idx)
    return seen


def insert_or_replace_activity(plan, activity, place_kind):
    name = activity["position"]
    for day_index, activity_index in existing_activity_indices(plan, name):
        current = plan["itinerary"][day_index]["activities"][activity_index]
        current.update(activity)
        insert_activity_sorted(plan["itinerary"][day_index], plan["itinerary"][day_index]["activities"].pop(activity_index))
        return True

    if place_kind == "restaurant":
        meal_type = activity["type"]
        for day_index in preferred_day_indices(plan, activity["start_time"], activity["end_time"]):
            for activity_index, current in enumerate(plan["itinerary"][day_index]["activities"]):
                if current.get("type") == meal_type:
                    plan["itinerary"][day_index]["activities"][activity_index] = activity
                    insert_activity_sorted(plan["itinerary"][day_index], plan["itinerary"][day_index]["activities"].pop(activity_index))
                    return True
        for day_index in preferred_day_indices(plan, activity["start_time"], activity["end_time"]):
            for activity_index, current in enumerate(plan["itinerary"][day_index]["activities"]):
                if current.get("type") in ["breakfast", "lunch", "dinner"]:
                    plan["itinerary"][day_index]["activities"][activity_index] = activity
                    insert_activity_sorted(plan["itinerary"][day_index], plan["itinerary"][day_index]["activities"].pop(activity_index))
                    return True

    for day_index in preferred_day_indices(plan, activity["start_time"], activity["end_time"]):
        insert_activity_sorted(plan["itinerary"][day_index], activity)
        return True
    return False


def apply_time_requirement(plan, requirement, hotels, restaurants, attractions):
    city = plan["target_city"]
    people = int(plan["people_number"])
    place_kind, row = find_named_place(hotels, restaurants, attractions, city, requirement["name"])
    if row is None:
        return False

    start_time, end_time = choose_activity_window(requirement, place_kind)
    if not time_window_is_usable(row, start_time, end_time, place_kind):
        fallback_windows = [
            ("08:00", "09:30"),
            ("09:00", "10:30"),
            ("11:00", "12:00"),
            ("12:00", "13:00"),
            ("14:30", "16:00"),
            ("17:00", "18:30"),
            ("18:00", "19:00"),
        ]
        for fallback_start, fallback_end in fallback_windows:
            candidate = dict(requirement)
            candidate.setdefault("min_duration", requirement.get("min_duration"))
            if requirement.get("start_before") and minutes(fallback_start) > minutes(requirement["start_before"]):
                continue
            if requirement.get("end_after") and minutes(fallback_end) < minutes(requirement["end_after"]):
                continue
            if requirement.get("min_duration") and minutes(fallback_end) - minutes(fallback_start) < int(requirement["min_duration"]):
                continue
            if time_window_is_usable(row, fallback_start, fallback_end, place_kind):
                start_time, end_time = fallback_start, fallback_end
                break
        else:
            return False

    if place_kind == "restaurant":
        activity = make_restaurant_activity(row, start_time, end_time, people)
    elif place_kind == "attraction":
        activity = make_attraction_activity(row, start_time, end_time, people)
    else:
        activity = make_hotel_activity(row, start_time, end_time, people)
    return insert_or_replace_activity(plan, activity, place_kind)


def apply_order_requirement(plan, requirement, hotels, restaurants, attractions):
    changed = False
    first = {"kind": "time", "name": requirement["names"][0], "start_before": "09:00", "end_after": None, "min_duration": 60}
    second = {"kind": "time", "name": requirement["names"][1], "start_before": "12:00", "end_after": None, "min_duration": 60}
    changed = apply_time_requirement(plan, first, hotels, restaurants, attractions) or changed
    changed = apply_time_requirement(plan, second, hotels, restaurants, attractions) or changed
    return changed


def apply_time_place_candidates(plan, requirements, hotels, restaurants, attractions, transportation):
    changed = False
    for requirement in requirements:
        if requirement["kind"] == "order":
            changed = apply_order_requirement(plan, requirement, hotels, restaurants, attractions) or changed
        else:
            changed = apply_time_requirement(plan, requirement, hotels, restaurants, attractions) or changed
    if changed:
        return recompute_innercity_transports(plan, transportation)
    return plan


if __name__ == "__main__":
    main()
`;
