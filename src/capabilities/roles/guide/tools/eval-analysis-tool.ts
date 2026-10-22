import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactManifestItem, Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';

const DEFAULT_METHOD = 'guide_schema_baseline';
const DEFAULT_SPLIT = 'tpc_phase1';
const DEFAULT_MAX_CHARS = 4200;
const RUNNER_FILE = 'guide-eval-analysis-runner.py';

interface EvalAnalysisReport {
  status?: string;
  counts?: Record<string, number>;
  scores?: Record<string, number>;
  top_commonsense_failures?: Array<{ column: string; failures: number; failure_rate: number; examples: string[] }>;
  top_hard_logic_failures_by_category?: Array<{
    category: string;
    total: number;
    passed: number;
    failed: number;
    pass_rate: number | null;
    examples: string[];
  }>;
  repair_priority?: string[];
  source?: {
    official_repo?: string;
    predictions?: string;
    method?: string;
    split?: string;
    language?: string;
  };
}

export class GuideTpcEvalAnalysisTool implements Tool {
  private recentArtifactManifest?: { runId: string; manifest: ArtifactManifestItem[] };

  definition: ToolDefinition = {
    name: 'guide_tpc_eval_analysis',
    description: [
      'Guide 专属工具：拆解 ChinaTravel / TPC 官方 verifier stage 结果。',
      '它会调用官方 schema、commonsense、hard-logic evaluation functions，输出 eval-analysis.json/md 和 per-uid/per-category CSV。',
      '用于在新增 repair 工具前确认当前 blocker 是 schema、environment、hard logic、FPR overlap 还是 preference。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        official_repo_dir: {
          type: 'string',
          description: 'ChinaTravel 官方仓库目录，必须包含 eval_tpc.py 和 chinatravel/evaluation。'
        },
        predictions_dir: {
          type: 'string',
          description: 'Prediction JSON 目录；默认 official_repo_dir/results/<method>_en。'
        },
        out_dir: {
          type: 'string',
          description: '输出目录，必须位于当前工作目录下。默认 output/guide/eval-analysis/<run_id>。'
        },
        run_id: {
          type: 'string',
          description: '可选 run id；不填自动生成。'
        },
        method_name: {
          type: 'string',
          description: `官方 results 方法名前缀，默认 ${DEFAULT_METHOD}；英文方法会归一成 <method>_en。`
        },
        split: {
          type: 'string',
          description: `官方 eval_tpc.py --splits 参数，默认 ${DEFAULT_SPLIT}。`
        },
        python_bin: {
          type: 'string',
          description: '调用官方 evaluation functions 的 Python 命令，默认 python。'
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
    const methodName = normalizeMethodName(args?.method_name);
    const methodNameEn = methodName.endsWith('_en') ? methodName : `${methodName}_en`;
    const split = safeSegment(readString(args?.split, DEFAULT_SPLIT));
    const pythonBin = readString(args?.python_bin, 'python');
    const maxChars = readPositiveNumber(args?.max_chars, DEFAULT_MAX_CHARS);

    fs.mkdirSync(outDir, { recursive: true });

    const analysisJsonPath = path.join(outDir, 'eval-analysis.json');
    const analysisMdPath = path.join(outDir, 'eval-analysis.md');
    const manifestPath = path.join(outDir, 'manifest.json');
    const runnerPath = path.join(outDir, RUNNER_FILE);
    const configPath = path.join(outDir, 'runner-config.json');
    const stdoutPath = path.join(outDir, 'eval-analysis.stdout.log');
    const stderrPath = path.join(outDir, 'eval-analysis.stderr.log');

    const officialRepoDir = args?.official_repo_dir
      ? path.resolve(workingDirectory, String(args.official_repo_dir))
      : '';
    const predictionsDir = args?.predictions_dir
      ? path.resolve(workingDirectory, String(args.predictions_dir))
      : path.join(officialRepoDir, 'results', methodNameEn);

    const blocker = validateInputs({
      officialRepoDir,
      predictionsDir,
      split,
    });
    if (blocker) {
      const blockedReport = buildBlockedReport({
        status: blocker.status,
        reason: blocker.reason,
        runId,
        officialRepoDir,
        predictionsDir,
        methodNameEn,
        split,
      });
      writeJson(analysisJsonPath, blockedReport);
      fs.writeFileSync(analysisMdPath, renderBlockedMarkdown(blockedReport), 'utf-8');
      writeManifest(manifestPath, buildManifest({
        runId,
        outDir,
        files: existingArtifactPaths({
          analysisJsonPath,
          analysisMdPath,
          manifestPath,
        }),
        workingDirectory,
        status: blocker.status,
      }));
      this.recentArtifactManifest = {
        runId,
        manifest: buildArtifactManifest({
          outDir,
          analysisJsonPath,
          analysisMdPath,
          manifestPath,
          workingDirectory,
        }),
      };
      return truncate(formatBlockedResult(blockedReport, {
        outDir,
        analysisJsonPath,
        analysisMdPath,
        manifestPath,
        workingDirectory,
      }), maxChars);
    }

    fs.writeFileSync(runnerPath, PYTHON_RUNNER_SOURCE, 'utf-8');
    writeJson(configPath, {
      official_repo_dir: officialRepoDir,
      predictions_dir: predictionsDir,
      out_dir: outDir,
      method: methodNameEn,
      split,
      lang: 'en',
    });

    const result = spawnSync(pythonBin, [runnerPath, configPath], {
      cwd: officialRepoDir,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    fs.writeFileSync(stdoutPath, result.stdout || '', 'utf-8');
    fs.writeFileSync(stderrPath, result.stderr || result.error?.message || '', 'utf-8');

    if (result.status !== 0 || result.error) {
      const failedReport = buildBlockedReport({
        status: 'failed',
        reason: result.error?.message || `eval analysis runner exited with ${result.status}`,
        runId,
        officialRepoDir,
        predictionsDir,
        methodNameEn,
        split,
        exitCode: result.status,
      });
      if (!fs.existsSync(analysisJsonPath)) {
        writeJson(analysisJsonPath, failedReport);
      }
      if (!fs.existsSync(analysisMdPath)) {
        fs.writeFileSync(analysisMdPath, renderBlockedMarkdown(failedReport), 'utf-8');
      }
    }

    const report = fs.existsSync(analysisJsonPath)
      ? readJson(analysisJsonPath) as EvalAnalysisReport
      : {};
    const status = result.status === 0 && !result.error ? 'completed' : 'failed';
    writeManifest(manifestPath, buildManifest({
      runId,
      outDir,
      files: existingArtifactPaths({
        analysisJsonPath,
        analysisMdPath,
        commonsenseErrorsPath: path.join(outDir, 'commonsense-errors.csv'),
        hardLogicFailuresPath: path.join(outDir, 'hard-logic-failures.csv'),
        hardLogicByUidPath: path.join(outDir, 'hard-logic-by-uid.csv'),
        uidStageSummaryPath: path.join(outDir, 'uid-stage-summary.csv'),
        runnerPath,
        configPath,
        stdoutPath,
        stderrPath,
        manifestPath,
      }),
      workingDirectory,
      status,
    }));

    this.recentArtifactManifest = {
      runId,
      manifest: buildArtifactManifest({
        outDir,
        analysisJsonPath,
        analysisMdPath,
        commonsenseErrorsPath: path.join(outDir, 'commonsense-errors.csv'),
        hardLogicFailuresPath: path.join(outDir, 'hard-logic-failures.csv'),
        hardLogicByUidPath: path.join(outDir, 'hard-logic-by-uid.csv'),
        uidStageSummaryPath: path.join(outDir, 'uid-stage-summary.csv'),
        runnerPath,
        configPath,
        stdoutPath,
        stderrPath,
        manifestPath,
        workingDirectory,
      }),
    };

    return truncate(formatResult({
      status,
      runId,
      outDir,
      analysisJsonPath,
      analysisMdPath,
      manifestPath,
      report,
      workingDirectory,
      exitCode: result.status,
    }), maxChars);
  }

  getArtifactManifest(_args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    const fields = parseKeyValueLines(typeof result === 'string' ? result : '');
    if (fields.run_id && this.recentArtifactManifest?.runId === fields.run_id) {
      return this.recentArtifactManifest.manifest;
    }

    return buildArtifactManifest({
      outDir: fields.out_dir ? path.resolve(context.workingDirectory, fields.out_dir) : undefined,
      analysisJsonPath: fields.analysis ? path.resolve(context.workingDirectory, fields.analysis) : undefined,
      analysisMdPath: fields.analysis_md ? path.resolve(context.workingDirectory, fields.analysis_md) : undefined,
      manifestPath: fields.manifest ? path.resolve(context.workingDirectory, fields.manifest) : undefined,
      workingDirectory: context.workingDirectory,
    });
  }
}

function validateInputs(input: {
  officialRepoDir: string;
  predictionsDir: string;
  split: string;
}): { status: string; reason: string } | undefined {
  if (!input.officialRepoDir) {
    return { status: 'blocked_missing_repo', reason: 'official_repo_dir is required.' };
  }
  if (!fs.existsSync(input.officialRepoDir) || !fs.statSync(input.officialRepoDir).isDirectory()) {
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
  const splitPath = path.join(input.officialRepoDir, 'chinatravel', 'evaluation', 'default_splits', `${input.split}.txt`);
  if (!fs.existsSync(splitPath)) {
    return {
      status: 'blocked_missing_split',
      reason: `official split file not found: ${datasetRef(splitPath)}`,
    };
  }
  if (!fs.existsSync(input.predictionsDir) || !fs.statSync(input.predictionsDir).isDirectory()) {
    return {
      status: 'blocked_missing_predictions',
      reason: `predictions_dir not found or not a directory: ${datasetRef(input.predictionsDir)}`,
    };
  }
  return undefined;
}

function buildBlockedReport(input: {
  status: string;
  reason: string;
  runId: string;
  officialRepoDir: string;
  predictionsDir: string;
  methodNameEn: string;
  split: string;
  exitCode?: number | null;
}): EvalAnalysisReport & Record<string, unknown> {
  return {
    status: input.status,
    generated_at: new Date().toISOString(),
    run_id: input.runId,
    reason: input.reason,
    ...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
    source: {
      official_repo: datasetRef(input.officialRepoDir),
      predictions: datasetRef(input.predictionsDir),
      method: input.methodNameEn,
      split: input.split,
      language: 'en',
    },
    counts: {},
    scores: {},
    repair_priority: [
      'fix eval-analysis setup blocker before planner repair work',
      'rerun guide_tpc_eval_analysis after official repo, split, and predictions are available',
    ],
  };
}

function renderBlockedMarkdown(report: EvalAnalysisReport & Record<string, unknown>): string {
  return [
    '# Guide Eval Analysis',
    '',
    `Status: ${String(report.status || 'blocked')}`,
    '',
    `Reason: ${String(report.reason || 'unknown')}`,
    '',
    '## Source',
    '',
    `- official repo: ${report.source?.official_repo || ''}`,
    `- predictions: ${report.source?.predictions || ''}`,
    `- method: ${report.source?.method || ''}`,
    `- split: ${report.source?.split || ''}`,
    '',
  ].join('\n');
}

function formatBlockedResult(report: EvalAnalysisReport & Record<string, unknown>, paths: {
  outDir: string;
  analysisJsonPath: string;
  analysisMdPath: string;
  manifestPath: string;
  workingDirectory: string;
}): string {
  return [
    `guide_tpc_eval_analysis: status=${report.status || 'blocked'}`,
    `run_id=${String(report.run_id || '')}`,
    `out_dir=${relativeDisplayPath(paths.outDir, paths.workingDirectory)}`,
    `analysis=${relativeDisplayPath(paths.analysisJsonPath, paths.workingDirectory)}`,
    `analysis_md=${relativeDisplayPath(paths.analysisMdPath, paths.workingDirectory)}`,
    `manifest=${relativeDisplayPath(paths.manifestPath, paths.workingDirectory)}`,
    `reason=${String(report.reason || '')}`,
  ].join('\n');
}

function formatResult(input: {
  status: string;
  runId: string;
  outDir: string;
  analysisJsonPath: string;
  analysisMdPath: string;
  manifestPath: string;
  report: EvalAnalysisReport;
  workingDirectory: string;
  exitCode: number | null;
}): string {
  const counts = input.report.counts || {};
  const scores = input.report.scores || {};
  const topCommonsense = input.report.top_commonsense_failures?.[0];
  const topHard = input.report.top_hard_logic_failures_by_category?.[0];
  return [
    `guide_tpc_eval_analysis: status=${input.status}`,
    `run_id=${input.runId}`,
    `out_dir=${relativeDisplayPath(input.outDir, input.workingDirectory)}`,
    `analysis=${relativeDisplayPath(input.analysisJsonPath, input.workingDirectory)}`,
    `analysis_md=${relativeDisplayPath(input.analysisMdPath, input.workingDirectory)}`,
    `manifest=${relativeDisplayPath(input.manifestPath, input.workingDirectory)}`,
    `exit_code=${input.exitCode}`,
    `tasks=${counts.tasks ?? ''}`,
    `schema_pass=${counts.schema_pass ?? ''}`,
    `commonsense_pass=${counts.commonsense_pass ?? ''}`,
    `raw_hard_logic_pass=${counts.hard_logic_pass_raw ?? ''}`,
    `all_pass=${counts.all_pass ?? ''}`,
    `MicEPR=${formatMaybeNumber(scores.MicEPR)}`,
    `MacEPR=${formatMaybeNumber(scores.MacEPR)}`,
    `C-LPR=${formatMaybeNumber(scores['C-LPR'])}`,
    `FPR=${formatMaybeNumber(scores.FPR)}`,
    `top_commonsense=${topCommonsense ? `${topCommonsense.column} (${topCommonsense.failures})` : ''}`,
    `top_hard_logic=${topHard ? `${topHard.category} (${topHard.failed}/${topHard.total})` : ''}`,
    `next=${(input.report.repair_priority || []).slice(0, 2).join(' | ')}`,
  ].join('\n');
}

function buildManifest(input: {
  runId: string;
  outDir: string;
  files: string[];
  workingDirectory: string;
  status: string;
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

function writeManifest(pathname: string, value: Record<string, unknown>): void {
  writeJson(pathname, value);
}

function buildArtifactManifest(input: {
  outDir?: string;
  analysisJsonPath?: string;
  analysisMdPath?: string;
  commonsenseErrorsPath?: string;
  hardLogicFailuresPath?: string;
  hardLogicByUidPath?: string;
  uidStageSummaryPath?: string;
  runnerPath?: string;
  configPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  manifestPath?: string;
  workingDirectory: string;
}): ArtifactManifestItem[] {
  const items: ArtifactManifestItem[] = [
    artifact(input.analysisJsonPath, 'json', 'generated', 'eval_analysis_json', input.workingDirectory),
    artifact(input.analysisMdPath, 'markdown', 'generated', 'eval_analysis_report', input.workingDirectory),
    artifact(input.commonsenseErrorsPath, 'csv', 'generated', 'commonsense_error_matrix', input.workingDirectory),
    artifact(input.hardLogicFailuresPath, 'csv', 'generated', 'hard_logic_category_matrix', input.workingDirectory),
    artifact(input.hardLogicByUidPath, 'csv', 'generated', 'hard_logic_uid_matrix', input.workingDirectory),
    artifact(input.uidStageSummaryPath, 'csv', 'generated', 'uid_stage_summary', input.workingDirectory),
    artifact(input.runnerPath, 'python', 'generated', 'analysis_runner', input.workingDirectory),
    artifact(input.configPath, 'json', 'generated', 'analysis_runner_config', input.workingDirectory),
    artifact(input.stdoutPath, 'log', 'captured', 'analysis_stdout', input.workingDirectory),
    artifact(input.stderrPath, 'log', 'captured', 'analysis_stderr', input.workingDirectory),
    artifact(input.manifestPath, 'json', 'generated', 'run_manifest', input.workingDirectory),
  ].filter((item): item is ArtifactManifestItem => Boolean(item));
  return uniqueArtifacts(items);
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
      tool: 'guide_tpc_eval_analysis',
      artifact_role: artifactRole,
    },
  };
}

function existingArtifactPaths(paths: Record<string, string | undefined>): string[] {
  return Object.values(paths).filter((pathname): pathname is string => Boolean(pathname && fs.existsSync(pathname)));
}

function createRunId(): string {
  return `guide-eval-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

function normalizeMethodName(value: unknown): string {
  const raw = readString(value, DEFAULT_METHOD).trim() || DEFAULT_METHOD;
  return safeSegment(raw.replace(/_en$/i, ''));
}

function resolveOutputDir(workingDirectory: string, value: unknown, runId: string): string {
  const raw = readString(value, path.join('output', 'guide', 'eval-analysis', runId));
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

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  if (home && pathname.startsWith(home)) {
    return pathname.replace(home, '$HOME');
  }
  return pathname;
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
import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd


def classify_logic(logic):
    s = (logic or '').lower()
    if 'day_count' in s:
        return 'core.day_count'
    if 'people_count' in s:
        return 'core.people_count'
    if 'tickets' in s:
        return 'core.ticket_count'
    if 'taxi' in s and ('car' in s or 'cars' in s):
        return 'transport.taxi_cars'
    if 'airplane' in s and ('intercity' in s or 'activity_type' in s):
        return 'intercity.mode.airplane'
    if 'train' in s and ('intercity' in s or 'activity_type' in s):
        return 'intercity.mode.train'
    if 'innercity' in s or 'activity_transports' in s or 'transport_mode' in s:
        if 'cost' in s or 'price' in s:
            return 'budget.innercity_cost'
        if 'distance' in s:
            return 'innercity.transport_distance'
        return 'innercity.transport_type'
    if 'total_cost' in s or 'all_cost' in s or 'cost(plan)' in s:
        return 'budget.total_cost'
    if 'intercity' in s and ('cost' in s or 'price' in s):
        return 'budget.intercity_cost'
    if 'attraction' in s:
        if 'cost' in s or 'price' in s:
            return 'budget.attraction_cost'
        if 'name' in s or 'position' in s:
            if '&' in s or 'intersection' in s:
                return 'attraction.name.require_or_choice'
            if 'not' in s or 'isdisjoint' in s:
                return 'attraction.name.forbid'
            return 'attraction.name.require'
        if 'type' in s or 'spot' in s or 'tag' in s:
            if 'not' in s or 'isdisjoint' in s:
                return 'attraction.type.forbid'
            if '&' in s:
                return 'attraction.type.choice'
            return 'attraction.type.require'
        return 'attraction.other'
    if 'restaurant' in s or 'restr' in s or 'breakfast' in s or 'lunch' in s or 'dinner' in s or 'food' in s:
        if 'cost' in s or 'price' in s:
            return 'budget.restaurant_cost'
        if 'name' in s or 'position' in s:
            if 'not' in s or 'isdisjoint' in s:
                return 'restaurant.name.forbid'
            if '&' in s:
                return 'restaurant.name.choice'
            return 'restaurant.name.require'
        if 'type' in s or 'cuisine' in s or 'food' in s:
            if 'not' in s or 'isdisjoint' in s:
                return 'restaurant.type.forbid'
            if '&' in s:
                return 'restaurant.type.choice'
            return 'restaurant.type.require'
        return 'restaurant.other'
    if 'accommodation' in s or 'hotel' in s or 'room' in s:
        if 'cost' in s or 'price' in s:
            return 'budget.accommodation_cost'
        if 'room' in s or 'bed' in s:
            return 'accommodation.room_type'
        if 'same' in s:
            return 'accommodation.same_hotel_or_position'
        if 'name' in s or 'position' in s:
            if 'not' in s or 'isdisjoint' in s:
                return 'accommodation.name.forbid'
            if '&' in s:
                return 'accommodation.name.choice'
            return 'accommodation.name.require'
        if 'feature' in s or 'type' in s:
            if 'not' in s or 'isdisjoint' in s:
                return 'accommodation.type.forbid'
            if '&' in s:
                return 'accommodation.type.choice'
            return 'accommodation.type.require'
        return 'accommodation.other'
    if 'cost' in s or 'price' in s or 'budget' in s:
        return 'budget.other'
    return 'other.unclassified'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def build_repair_priority(common_sums, hard_category_summary, all_pass_count, task_count):
    priorities = []
    top_common = [item for item in common_sums if item.get('failures', 0) > 0]
    top_hard = [item for item in hard_category_summary if item.get('failed', 0) > 0]

    if top_common:
        first_common = top_common[0]
        if first_common['column'] == 'Does not follow Chronological Order':
            priorities.append(
                f"P0: chronology repair for {first_common['failures']} commonsense failures without reducing environment pass rate"
            )
        else:
            priorities.append(
                f"P0: commonsense/environment repair for {first_common['column']} ({first_common['failures']} failures)"
            )

    for item in top_hard[:4]:
        category = item['category']
        failed = item['failed']
        total = item['total']
        if category.startswith('budget.'):
            priorities.append(f"P0: budget solver for {category} ({failed}/{total} failing)")
        elif category.startswith('intercity.mode'):
            priorities.append(f"P1: verifier-filtered intercity route repair for {category} ({failed}/{total} failing)")
        elif category.startswith('accommodation.') or category.startswith('restaurant.') or category.startswith('attraction.'):
            priorities.append(f"P1: residual entity parser/binder repair for {category} ({failed}/{total} failing)")
        else:
            priorities.append(f"P1: classify and target {category} ({failed}/{total} failing)")

    if all_pass_count == 0:
        priorities.append('P2: preference optimizer remains blocked until at least one all-pass plan exists')
    elif task_count and all_pass_count / task_count < 0.85:
        priorities.append('P2: defer preference tuning until FPR approaches the next hard-constraint plateau')
    else:
        priorities.append('P2: tune DAV/ATT/DDR after hard-constraint regressions are guarded')

    seen = []
    for item in priorities:
        if item not in seen:
            seen.append(item)
    return seen


def load_predictions(query_index, predictions_dir):
    result_data = {}
    missing = []
    for uid in query_index:
        path = predictions_dir / (str(uid) + '.json')
        if path.exists():
            result_data[str(uid)] = json.loads(path.read_text(encoding='utf-8'))
        else:
            missing.append(str(uid))
            result_data[str(uid)] = {}
    return result_data, missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8'))

    repo = Path(config['official_repo_dir']).resolve()
    predictions_dir = Path(config['predictions_dir']).resolve()
    out_dir = Path(config['out_dir']).resolve()
    method = config.get('method', 'guide_schema_baseline_en')
    split = config.get('split', 'tpc_phase1')
    lang = config.get('lang', 'en')

    os.chdir(repo)
    if str(repo) not in sys.path:
        sys.path.insert(0, str(repo))

    from chinatravel.data.load_datasets import load_query
    from chinatravel.evaluation.utils import load_json_file
    from chinatravel.evaluation.schema_constraint import evaluate_schema_constraints
    from chinatravel.evaluation.commonsense_constraint import evaluate_commonsense_constraints
    from chinatravel.evaluation.hard_constraint import evaluate_hard_constraints_v2
    from eval_tpc import cal_default_pr_score

    eval_args = argparse.Namespace(splits=split, method=method, lang=lang)
    query_index, query_data = load_query(eval_args)
    query_index = [str(uid) for uid in query_index]
    result_data, missing = load_predictions(query_index, predictions_dir)

    schema = load_json_file('chinatravel/evaluation/output_schema.json')
    schema_rate, schema_df, schema_pass = evaluate_schema_constraints(query_index, result_data, schema=schema)
    macro_comm, micro_comm, common_df, commonsense_pass = evaluate_commonsense_constraints(
        query_index, query_data, result_data, verbose=False, lang=lang
    )
    macro_logi, micro_logi, conditional_macro_logi, conditional_micro_logi, logi_df, logi_pass = evaluate_hard_constraints_v2(
        query_index, query_data, result_data, env_pass_id=commonsense_pass, verbose=False, lang=lang
    )
    all_pass = sorted(set(map(str, schema_pass)) & set(map(str, commonsense_pass)) & set(map(str, logi_pass)))

    common_values = common_df.fillna(0)
    common_cols = [c for c in common_values.columns if c != 'data_id']
    common_sums = []
    for col in common_cols:
        series = pd.to_numeric(common_values[col], errors='coerce').fillna(0)
        total = int(series.sum())
        examples = common_values.loc[series > 0, 'data_id'].astype(str).head(8).tolist()
        common_sums.append({
            'column': str(col),
            'failures': total,
            'failure_rate': total / len(query_index) if query_index else 0,
            'examples': examples,
        })
    common_sums.sort(key=lambda item: (-item['failures'], item['column']))

    uid_common_errors = {}
    for _, row in common_values.iterrows():
        uid = str(row['data_id'])
        errors = []
        for col in common_cols:
            try:
                bad = int(row[col]) != 0
            except Exception:
                bad = False
            if bad:
                errors.append(str(col))
        uid_common_errors[uid] = errors

    category_total = Counter()
    category_pass = Counter()
    category_fail = Counter()
    category_examples = defaultdict(list)
    logic_rows = []
    logi_by_uid = {str(row['data_id']): row for _, row in logi_df.iterrows()}
    for uid in query_index:
        q = query_data[uid]
        logics = q.get('hard_logic_py', []) or []
        row = logi_by_uid.get(uid)
        for i, logic in enumerate(logics):
            col = 'logic_py_' + str(i)
            value = 0
            if row is not None and col in row:
                try:
                    if not pd.isna(row[col]):
                        value = int(row[col])
                except Exception:
                    value = 0
            category = classify_logic(logic)
            category_total[category] += 1
            if value:
                category_pass[category] += 1
            else:
                category_fail[category] += 1
                if len(category_examples[category]) < 8:
                    category_examples[category].append(uid)
            logic_rows.append({
                'uid': uid,
                'logic_index': i,
                'category': category,
                'passed': value,
                'logic': str(logic).replace('\n', '\\n'),
            })

    hard_category_summary = []
    for category, total in category_total.most_common():
        passed = category_pass[category]
        failed = category_fail[category]
        hard_category_summary.append({
            'category': category,
            'total': int(total),
            'passed': int(passed),
            'failed': int(failed),
            'pass_rate': passed / total if total else None,
            'examples': category_examples.get(category, []),
        })
    hard_category_summary.sort(key=lambda item: (-item['failed'], -item['total'], item['category']))

    stage_sets = {
        'schema': set(map(str, schema_pass)),
        'commonsense': set(map(str, commonsense_pass)),
        'hard_logic': set(map(str, logi_pass)),
        'all': set(map(str, all_pass)),
    }

    route_counts = Counter()
    route_common_pass = Counter()
    route_hard_pass = Counter()
    route_all_pass = Counter()
    for uid in query_index:
        q = query_data[uid]
        route = str(q.get('start_city')) + '->' + str(q.get('target_city'))
        route_counts[route] += 1
        if uid in stage_sets['commonsense']:
            route_common_pass[route] += 1
        if uid in stage_sets['hard_logic']:
            route_hard_pass[route] += 1
        if uid in stage_sets['all']:
            route_all_pass[route] += 1
    route_summary = []
    for route, total in route_counts.most_common(20):
        route_summary.append({
            'route': route,
            'total': int(total),
            'commonsense_pass': int(route_common_pass[route]),
            'hard_logic_pass': int(route_hard_pass[route]),
            'all_pass': int(route_all_pass[route]),
        })

    pre_res = cal_default_pr_score(query_index, query_data, result_data, all_pass)
    dav = float(pre_res[0] * 100)
    att = float(pre_res[1] * 100)
    ddr = float(pre_res[2] * 100)
    fpr = float(len(all_pass) / len(query_index) * 100 if query_index else 0)
    preference_note = (
        'all_pass_id is empty, so official default DAV/ATT/DDR are forced to 0 for this run'
        if not all_pass
        else 'DAV/ATT/DDR computed through eval_tpc.cal_default_pr_score using all_pass_id'
    )

    scores = {
        'schema_rate': float(schema_rate),
        'MicEPR': float(micro_comm),
        'MacEPR': float(macro_comm),
        'raw_hard_logic_micro': float(micro_logi),
        'raw_hard_logic_macro': float(macro_logi),
        'C-LPR': float(conditional_micro_logi),
        'conditional_hard_logic_macro': float(conditional_macro_logi),
        'FPR': fpr,
        'DAV': dav,
        'ATT': att,
        'DDR': ddr,
        'overall_eval_tpc_py': float(0.1 * micro_comm + 0.1 * micro_comm + 0.25 * conditional_micro_logi + 0.05 * dav + 0.05 * att + 0.05 * ddr + 0.4 * fpr),
        'overall_published_formula': float(0.1 * micro_comm + 0.1 * macro_comm + 0.25 * conditional_micro_logi + 0.05 * dav + 0.05 * att + 0.05 * ddr + 0.4 * fpr),
    }

    analysis = {
        'status': 'completed',
        'generated_at': 'runtime',
        'source': {
            'official_repo': str(repo),
            'method': method,
            'split': split,
            'language': lang,
            'predictions': str(predictions_dir),
        },
        'counts': {
            'tasks': len(query_index),
            'missing_predictions': len(missing),
            'schema_pass': len(schema_pass),
            'schema_fail': len(query_index) - len(schema_pass),
            'commonsense_pass': len(commonsense_pass),
            'commonsense_fail': len(query_index) - len(commonsense_pass),
            'hard_logic_pass_raw': len(logi_pass),
            'hard_logic_fail_raw': len(query_index) - len(logi_pass),
            'all_pass': len(all_pass),
        },
        'scores': scores,
        'score_formula': {
            'official_guide': 'Overall = 10% EPR-micro + 10% EPR-macro + 25% C-LPR + 40% FPR + 5% DAV + 5% ATT + 5% DDR',
            'eval_tpc_py_effective': 'final_score = 0.1*micro_comm + 0.1*micro_comm + 0.25*conditional_micro_logi + 0.05*DAV + 0.05*ATT + 0.05*DDR + 0.4*FPR',
            'note': 'local eval_tpc.py duplicates micro_comm in the formula where the published guide names EPR-macro; this run uses official code as executed locally.',
        },
        'preference_note': preference_note,
        'top_commonsense_failures': common_sums,
        'top_hard_logic_failures_by_category': hard_category_summary,
        'stage_overlap': {
            'hard_logic_pass_but_commonsense_fail_examples': sorted(stage_sets['hard_logic'] - stage_sets['commonsense'])[:20],
            'commonsense_pass_but_hard_logic_fail_examples': sorted(stage_sets['commonsense'] - stage_sets['hard_logic'])[:20],
        },
        'top_routes': route_summary,
        'repair_priority': build_repair_priority(
            common_sums,
            hard_category_summary,
            len(all_pass),
            len(query_index),
        ),
    }

    write_json(out_dir / 'eval-analysis.json', analysis)

    with (out_dir / 'commonsense-errors.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['column', 'failures', 'failure_rate', 'examples'])
        writer.writeheader()
        for row in common_sums:
            writer.writerow({**row, 'examples': ';'.join(row['examples'])})

    with (out_dir / 'hard-logic-failures.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['category', 'total', 'passed', 'failed', 'pass_rate', 'examples'])
        writer.writeheader()
        for row in hard_category_summary:
            writer.writerow({**row, 'examples': ';'.join(row['examples'])})

    with (out_dir / 'hard-logic-by-uid.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['uid', 'logic_index', 'category', 'passed', 'logic'])
        writer.writeheader()
        writer.writerows(logic_rows)

    with (out_dir / 'uid-stage-summary.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['uid', 'schema_pass', 'commonsense_pass', 'hard_logic_pass_raw', 'all_pass', 'commonsense_errors'])
        writer.writeheader()
        for uid in query_index:
            writer.writerow({
                'uid': uid,
                'schema_pass': int(uid in stage_sets['schema']),
                'commonsense_pass': int(uid in stage_sets['commonsense']),
                'hard_logic_pass_raw': int(uid in stage_sets['hard_logic']),
                'all_pass': int(uid in stage_sets['all']),
                'commonsense_errors': ';'.join(uid_common_errors.get(uid, [])),
            })

    md_lines = []
    md_lines.append('# Guide Eval Analysis')
    md_lines.append('')
    md_lines.append('## Stage Summary')
    md_lines.append('')
    md_lines.append('- Tasks: ' + str(len(query_index)))
    md_lines.append('- Schema: ' + str(len(schema_pass)) + '/' + str(len(query_index)) + ' pass (' + format(schema_rate, '.3f') + '%)')
    md_lines.append('- Commonsense / environment: ' + str(len(commonsense_pass)) + '/' + str(len(query_index)) + ' pass; MicEPR ' + format(micro_comm, '.3f') + ', MacEPR ' + format(macro_comm, '.3f'))
    md_lines.append('- Raw hard logic: ' + str(len(logi_pass)) + '/' + str(len(query_index)) + ' full-pass; raw micro ' + format(micro_logi, '.3f') + ', raw macro ' + format(macro_logi, '.3f'))
    md_lines.append('- Conditional hard logic C-LPR: ' + format(conditional_micro_logi, '.3f') + '; conditional macro ' + format(conditional_macro_logi, '.3f'))
    md_lines.append('- Final all-pass / FPR: ' + str(len(all_pass)) + '/' + str(len(query_index)) + ' (' + format(scores['FPR'], '.3f') + '%)')
    md_lines.append('- Preference: ' + preference_note)
    md_lines.append('')
    md_lines.append('## Score Formula Note')
    md_lines.append('')
    md_lines.append('- Published eval guide formula: 10% EPR-micro + 10% EPR-macro + 25% C-LPR + 40% FPR + 5% DAV + 5% ATT + 5% DDR.')
    md_lines.append('- Local official eval_tpc.py currently computes 0.1*micro_comm + 0.1*micro_comm + 0.25*C-LPR + 0.4*FPR + preference, duplicating MicEPR where the guide text names MacEPR.')
    md_lines.append('')
    md_lines.append('## Top Commonsense Failures')
    md_lines.append('')
    md_lines.append('| Failure column | Count | Rate | Example uids |')
    md_lines.append('| --- | ---: | ---: | --- |')
    for row in common_sums[:15]:
        md_lines.append('| ' + row['column'] + ' | ' + str(row['failures']) + ' | ' + format(row['failure_rate'], '.1%') + ' | ' + ', '.join(row['examples'][:5]) + ' |')
    md_lines.append('')
    md_lines.append('## Top Raw Hard-Logic Failures')
    md_lines.append('')
    md_lines.append('| Category | Failed / Total | Pass rate | Example uids |')
    md_lines.append('| --- | ---: | ---: | --- |')
    for row in hard_category_summary[:20]:
        pass_rate = row['pass_rate'] if row['pass_rate'] is not None else 0
        md_lines.append('| ' + row['category'] + ' | ' + str(row['failed']) + ' / ' + str(row['total']) + ' | ' + format(pass_rate, '.1%') + ' | ' + ', '.join(row['examples'][:5]) + ' |')
    md_lines.append('')
    md_lines.append('## Repair Priority')
    md_lines.append('')
    for item in analysis['repair_priority']:
        md_lines.append('- ' + item)
    md_lines.append('')
    (out_dir / 'eval-analysis.md').write_text('\n'.join(md_lines), encoding='utf-8')

    print(json.dumps({
        'out_dir': str(out_dir),
        'counts': analysis['counts'],
        'scores': analysis['scores'],
        'top_commonsense': common_sums[:5],
        'top_hard': hard_category_summary[:5],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
`;
