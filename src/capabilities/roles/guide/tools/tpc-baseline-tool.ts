import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ArtifactManifestItem, Tool, ToolDefinition, ToolExecutionContext } from '../../../../runtime/contracts/tool';

const DEFAULT_DATASET_DIR = '/Users/guowei/minimind/data/ijcai2026_chinatravel/TPC_IJCAI_2026_phase1_EN';
const DEFAULT_METHOD = 'guide_schema_baseline';
const DEFAULT_TEAM = 'XiaoBaGuide';
const DEFAULT_SPLIT = 'tpc_phase1';
const DEFAULT_MAX_CHARS = 4200;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const ACTIVITY_TYPES = new Set(['airplane', 'attraction', 'lunch', 'dinner', 'breakfast', 'accommodation', 'train']);
const TRANSPORT_TYPES = new Set(['walk', 'metro', 'taxi']);

interface TpcTask {
  uid: string;
  nature_language?: string;
  days: number;
  people_number: number;
  start_city: string;
  target_city: string;
  hard_logic_py?: string[];
}

interface TpcTransport {
  start: string;
  end: string;
  mode: 'walk' | 'metro' | 'taxi';
  start_time: string;
  end_time: string;
  cost: number;
  price: number;
  distance: number;
  tickets?: number;
}

interface TpcActivity {
  type: 'airplane' | 'attraction' | 'lunch' | 'dinner' | 'breakfast' | 'accommodation' | 'train';
  start_time: string;
  end_time: string;
  cost: number;
  price: number;
  tickets?: number;
  position?: string;
  transports: TpcTransport[];
  room_type?: number;
  rooms?: number;
  start?: string;
  end?: string;
  FlightID?: string;
  TrainID?: string;
}

interface TpcPrediction {
  people_number: number;
  start_city: string;
  target_city: string;
  itinerary: Array<{
    day: number;
    activities: TpcActivity[];
  }>;
}

interface BaselineReport {
  version: 1;
  run_id: string;
  status: 'completed' | 'completed_with_blockers';
  method_name: string;
  results_method_dir: string;
  lang: 'en';
  split: string;
  generated_at: string;
  dataset: {
    ref: string;
    files_total: number;
    files_processed: number;
    limited: boolean;
  };
  schema_check: {
    status: 'pass' | 'fail';
    passed: number;
    failed: number;
    failure_examples: Array<{ uid: string; errors: string[] }>;
  };
  artifacts: {
    results_dir: string;
    manifest_path: string;
    report_json_path: string;
    report_md_path: string;
    failure_queue_path: string;
    zip_path?: string;
  };
  verifier: {
    status: 'not_requested' | 'blocked_missing_eval_tpc' | 'blocked_missing_repo' | 'completed' | 'failed';
    command?: string;
    official_repo_ref?: string;
    stdout_path?: string;
    stderr_path?: string;
    scores_path?: string;
    exit_code?: number | null;
    reason?: string;
  };
  next_repair_focus: string[];
}

export class GuideTpcBaselineTool implements Tool {
  private recentArtifactManifest?: { runId: string; manifest: ArtifactManifestItem[] };

  definition: ToolDefinition = {
    name: 'guide_tpc_baseline',
    description: [
      'Guide 专属工具：为 ChinaTravel / TPC Phase 1 生成 schema-valid itinerary JSON baseline。',
      '它会读取本地 EN task JSON，写出 results/<method>_en/<uid>.json、manifest、report、failure queue 和可选提交 zip。',
      '如果提供 official_repo_dir 且 run_verifier=true，会尝试调用官方 eval_tpc.py；否则明确记录 verifier blocker。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        dataset_dir: {
          type: 'string',
          description: `Phase 1 EN task JSON 目录，默认 ${DEFAULT_DATASET_DIR}。`
        },
        out_dir: {
          type: 'string',
          description: '输出目录，必须位于当前工作目录下。默认 output/guide/tpc-baseline/<run_id>。'
        },
        run_id: {
          type: 'string',
          description: '可选 run id；不填自动生成。'
        },
        method_name: {
          type: 'string',
          description: `官方 results 方法名前缀，默认 ${DEFAULT_METHOD}；英文结果目录会是 <method>_en。`
        },
        team_name: {
          type: 'string',
          description: `提交 zip 队名，默认 ${DEFAULT_TEAM}。`
        },
        version: {
          type: 'string',
          description: '提交 zip 版本号，默认 0。'
        },
        limit: {
          type: 'number',
          description: '只处理前 N 条任务；用于 smoke。默认处理全部。'
        },
        include_zip: {
          type: 'boolean',
          description: '是否生成 {TeamName}_v{x}.zip，默认 true。'
        },
        official_repo_dir: {
          type: 'string',
          description: '可选 ChinaTravel 官方仓库目录，需包含 eval_tpc.py。'
        },
        run_verifier: {
          type: 'boolean',
          description: '是否尝试调用官方 eval_tpc.py，默认 false。'
        },
        copy_results_to_official_repo: {
          type: 'boolean',
          description: 'run_verifier=true 时是否把 results 复制到 official_repo_dir/results，默认 true。'
        },
        split: {
          type: 'string',
          description: `官方 eval_tpc.py --splits 参数，默认 ${DEFAULT_SPLIT}。`
        },
        python_bin: {
          type: 'string',
          description: '调用 eval_tpc.py 的 Python 命令，默认 python。'
        },
        max_chars: {
          type: 'number',
          description: `最大返回字符数，默认 ${DEFAULT_MAX_CHARS}。完整证据落盘。`
        }
      }
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string> {
    const workingDirectory = context.workingDirectory;
    const runId = safeSegment(readString(args?.run_id, createRunId()));
    const outDir = resolveOutputDir(workingDirectory, args?.out_dir, runId);
    const datasetDir = path.resolve(readString(args?.dataset_dir, DEFAULT_DATASET_DIR));
    const methodName = normalizeMethodName(args?.method_name);
    const resultsMethodDir = `${methodName}_en`;
    const teamName = safeSegment(readString(args?.team_name, DEFAULT_TEAM));
    const version = safeSegment(readString(args?.version, '0'));
    const maxChars = readPositiveNumber(args?.max_chars, DEFAULT_MAX_CHARS);
    const includeZip = readBoolean(args?.include_zip, true);
    const runVerifier = readBoolean(args?.run_verifier, false);
    const split = safeSegment(readString(args?.split, DEFAULT_SPLIT));

    const tasks = loadTasks(datasetDir, readOptionalPositiveNumber(args?.limit));
    const resultsDir = path.join(outDir, 'results', resultsMethodDir);
    const failureQueuePath = path.join(outDir, 'failure-queue.jsonl');
    const manifestPath = path.join(outDir, 'manifest.json');
    const reportJsonPath = path.join(outDir, 'report.json');
    const reportMdPath = path.join(outDir, 'report.md');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(failureQueuePath, '', 'utf-8');

    const failureExamples: Array<{ uid: string; errors: string[] }> = [];
    let schemaPassed = 0;
    let schemaFailed = 0;

    for (const task of tasks.items) {
      const prediction = buildBaselinePrediction(task);
      const errors = validatePrediction(prediction, task);
      const filePath = path.join(resultsDir, `${task.uid}.json`);
      writeJson(filePath, prediction);
      if (errors.length === 0) {
        schemaPassed += 1;
      } else {
        schemaFailed += 1;
        if (failureExamples.length < 10) {
          failureExamples.push({ uid: task.uid, errors });
        }
        appendJsonl(failureQueuePath, {
          uid: task.uid,
          stage: 'local_schema_check',
          errors,
          recommended_repair: 'fix prediction shape before official verifier',
        });
      }
    }

    const zipPath = includeZip
      ? createSubmissionZip(outDir, teamName, version, 'results')
      : undefined;
    const verifier = runVerifier
      ? runOfficialVerifier({
        args,
        workingDirectory,
        outDir,
        methodName,
        resultsMethodDir,
        split,
      })
      : {
        status: 'not_requested' as const,
        reason: 'run_verifier=false; generated schema-valid baseline artifacts only.',
      };

    const report: BaselineReport = {
      version: 1,
      run_id: runId,
      status: verifier.status === 'completed' && schemaFailed === 0 ? 'completed' : 'completed_with_blockers',
      method_name: methodName,
      results_method_dir: resultsMethodDir,
      lang: 'en',
      split,
      generated_at: new Date().toISOString(),
      dataset: {
        ref: datasetRef(datasetDir),
        files_total: tasks.total,
        files_processed: tasks.items.length,
        limited: tasks.items.length !== tasks.total,
      },
      schema_check: {
        status: schemaFailed === 0 ? 'pass' : 'fail',
        passed: schemaPassed,
        failed: schemaFailed,
        failure_examples: failureExamples,
      },
      artifacts: {
        results_dir: relativeDisplayPath(resultsDir, workingDirectory),
        manifest_path: relativeDisplayPath(manifestPath, workingDirectory),
        report_json_path: relativeDisplayPath(reportJsonPath, workingDirectory),
        report_md_path: relativeDisplayPath(reportMdPath, workingDirectory),
        failure_queue_path: relativeDisplayPath(failureQueuePath, workingDirectory),
        ...(zipPath ? { zip_path: relativeDisplayPath(zipPath, workingDirectory) } : {}),
      },
      verifier,
      next_repair_focus: buildNextRepairFocus(verifier),
    };

    writeJson(reportJsonPath, report);
    fs.writeFileSync(reportMdPath, renderReport(report), 'utf-8');
    writeJson(manifestPath, buildManifest({
      runId,
      methodName,
      resultsMethodDir,
      outDir,
      resultsDir,
      reportJsonPath,
      reportMdPath,
      failureQueuePath,
      zipPath,
      taskCount: tasks.items.length,
      verifier,
      workingDirectory,
    }));

    this.recentArtifactManifest = {
      runId,
      manifest: buildArtifactManifest({
        outDir,
        resultsDir,
        reportJsonPath,
        reportMdPath,
        failureQueuePath,
        manifestPath,
        zipPath,
        workingDirectory,
      }),
    };

    return truncate(formatResult(report), maxChars);
  }

  getArtifactManifest(_args: any, result: string, context: ToolExecutionContext): ArtifactManifestItem[] {
    const fields = parseKeyValueLines(result);
    if (fields.run_id && this.recentArtifactManifest?.runId === fields.run_id) {
      return this.recentArtifactManifest.manifest;
    }

    return buildArtifactManifest({
      outDir: fields.out_dir ? path.resolve(context.workingDirectory, fields.out_dir) : undefined,
      resultsDir: fields.results_dir ? path.resolve(context.workingDirectory, fields.results_dir) : undefined,
      reportJsonPath: fields.report ? path.resolve(context.workingDirectory, fields.report) : undefined,
      reportMdPath: fields.report_md ? path.resolve(context.workingDirectory, fields.report_md) : undefined,
      failureQueuePath: fields.failure_queue ? path.resolve(context.workingDirectory, fields.failure_queue) : undefined,
      manifestPath: fields.manifest ? path.resolve(context.workingDirectory, fields.manifest) : undefined,
      zipPath: fields.zip ? path.resolve(context.workingDirectory, fields.zip) : undefined,
      workingDirectory: context.workingDirectory,
    });
  }
}

function loadTasks(datasetDir: string, limit?: number): { total: number; items: TpcTask[] } {
  if (!fs.existsSync(datasetDir) || !fs.statSync(datasetDir).isDirectory()) {
    throw new Error(`TPC dataset_dir not found or not a directory: ${datasetRef(datasetDir)}`);
  }
  const files = fs.readdirSync(datasetDir)
    .filter(file => file.endsWith('.json'))
    .sort();
  const selectedFiles = limit ? files.slice(0, Math.min(limit, files.length)) : files;
  const items = selectedFiles.map(file => normalizeTask(readJson(path.join(datasetDir, file)), file));
  return { total: files.length, items };
}

function normalizeTask(value: unknown, file: string): TpcTask {
  if (!isPlainObject(value)) {
    throw new Error(`invalid TPC task JSON: ${file}`);
  }
  const uid = readString(value.uid, path.basename(file, '.json'));
  const days = readPositiveInteger(value.days, 1);
  const peopleNumber = readPositiveInteger(value.people_number, 1);
  return {
    uid,
    nature_language: typeof value.nature_language === 'string' ? value.nature_language : undefined,
    days,
    people_number: peopleNumber,
    start_city: readString(value.start_city, 'Unknown Start City'),
    target_city: readString(value.target_city, 'Unknown Target City'),
    hard_logic_py: Array.isArray(value.hard_logic_py)
      ? value.hard_logic_py.map(item => String(item || '')).filter(Boolean)
      : [],
  };
}

function buildBaselinePrediction(task: TpcTask): TpcPrediction {
  const requiredAttractions = extractRequiredAttractions(task);
  const rooms = Math.max(1, Math.ceil(task.people_number / 2));
  const itinerary = Array.from({ length: task.days }, (_, index) => {
    const day = index + 1;
    const activities: TpcActivity[] = [];
    if (day === 1 && task.start_city !== task.target_city) {
      activities.push({
        type: 'train',
        start: task.start_city,
        end: task.target_city,
        start_time: '07:30',
        end_time: '11:30',
        TrainID: `${safeSegment(task.start_city)}-${safeSegment(task.target_city)}-${day}`,
        position: `${task.start_city} to ${task.target_city}`,
        tickets: task.people_number,
        price: 280,
        cost: 280 * task.people_number,
        transports: [],
      });
    }
    activities.push(meal('breakfast', '08:00', '08:40', task));
    activities.push(attractionActivity(task, requiredAttractions[index] || requiredAttractions[0], day));
    activities.push(meal('lunch', '12:10', '13:10', task));
    activities.push(meal('dinner', '18:00', '19:00', task));
    activities.push({
      type: 'accommodation',
      start_time: '20:00',
      end_time: '23:59',
      position: `${task.target_city} Guide Baseline Hotel`,
      price: 360,
      cost: 360 * rooms,
      room_type: 2,
      rooms,
      transports: [],
    });
    return { day, activities };
  });
  return {
    people_number: task.people_number,
    start_city: task.start_city,
    target_city: task.target_city,
    itinerary,
  };
}

function meal(type: 'breakfast' | 'lunch' | 'dinner', startTime: string, endTime: string, task: TpcTask): TpcActivity {
  const price = type === 'breakfast' ? 30 : 70;
  return {
    type,
    start_time: startTime,
    end_time: endTime,
    position: `${task.target_city} Guide Baseline ${type}`,
    price,
    cost: price * task.people_number,
    transports: [],
  };
}

function attractionActivity(task: TpcTask, requiredName: string | undefined, day: number): TpcActivity {
  const position = requiredName || `${task.target_city} Guide Baseline Attraction ${day}`;
  return {
    type: 'attraction',
    start_time: '09:20',
    end_time: '11:40',
    position,
    tickets: task.people_number,
    price: 60,
    cost: 60 * task.people_number,
    transports: [],
  };
}

function extractRequiredAttractions(task: TpcTask): string[] {
  const values = new Set<string>();
  const constraints = task.hard_logic_py || [];
  for (const constraint of constraints) {
    if (!constraint.includes('attraction_name_set') || /\bnot\s*\(/.test(constraint)) {
      continue;
    }
    for (const match of constraint.matchAll(/"([^"\n]+)"/g)) {
      const value = match[1].trim();
      if (value) {
        values.add(value);
      }
    }
  }
  if (values.size === 0 && task.nature_language) {
    const visitMatch = task.nature_language.match(/\bvisit\s+(.+?)(?:\.|;|,|$)/i);
    if (visitMatch?.[1]) {
      values.add(visitMatch[1].trim());
    }
  }
  return Array.from(values);
}

function validatePrediction(prediction: TpcPrediction, task: TpcTask): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(prediction.people_number)) errors.push('people_number must be integer');
  if (prediction.people_number !== task.people_number) errors.push('people_number must match task');
  if (prediction.start_city !== task.start_city) errors.push('start_city must match task');
  if (prediction.target_city !== task.target_city) errors.push('target_city must match task');
  if (!Array.isArray(prediction.itinerary)) errors.push('itinerary must be array');
  if (prediction.itinerary.length !== task.days) errors.push('itinerary length must match task days');

  prediction.itinerary.forEach((day, dayIndex) => {
    if (!Number.isInteger(day.day)) errors.push(`itinerary[${dayIndex}].day must be integer`);
    if (day.day !== dayIndex + 1) errors.push(`itinerary[${dayIndex}].day must be ${dayIndex + 1}`);
    if (!Array.isArray(day.activities)) {
      errors.push(`itinerary[${dayIndex}].activities must be array`);
      return;
    }
    day.activities.forEach((activity, activityIndex) => {
      const prefix = `itinerary[${dayIndex}].activities[${activityIndex}]`;
      if (!ACTIVITY_TYPES.has(activity.type)) errors.push(`${prefix}.type is invalid`);
      if (!TIME_PATTERN.test(activity.start_time)) errors.push(`${prefix}.start_time must be HH:MM`);
      if (!TIME_PATTERN.test(activity.end_time)) errors.push(`${prefix}.end_time must be HH:MM`);
      if (!isFiniteNumber(activity.price)) errors.push(`${prefix}.price must be number`);
      if (!isFiniteNumber(activity.cost)) errors.push(`${prefix}.cost must be number`);
      if (!Array.isArray(activity.transports)) errors.push(`${prefix}.transports must be array`);
      if ((activity.type === 'train' || activity.type === 'airplane') && (!activity.start || !activity.end)) {
        errors.push(`${prefix}.start/end are required for intercity transport`);
      }
      if (activity.type === 'train' && !activity.TrainID) errors.push(`${prefix}.TrainID is required`);
      if (activity.type === 'airplane' && !activity.FlightID) errors.push(`${prefix}.FlightID is required`);
      if (['train', 'airplane', 'attraction'].includes(activity.type) && activity.tickets !== task.people_number) {
        errors.push(`${prefix}.tickets must equal people_number`);
      }
      if (activity.type === 'accommodation' && !Number.isInteger(activity.rooms)) {
        errors.push(`${prefix}.rooms must be integer`);
      }
      for (const [transportIndex, transport] of (activity.transports || []).entries()) {
        const tPrefix = `${prefix}.transports[${transportIndex}]`;
        if (!transport.start || !transport.end) errors.push(`${tPrefix}.start/end are required`);
        if (!TRANSPORT_TYPES.has(transport.mode)) errors.push(`${tPrefix}.mode is invalid`);
        if (!TIME_PATTERN.test(transport.start_time)) errors.push(`${tPrefix}.start_time must be HH:MM`);
        if (!TIME_PATTERN.test(transport.end_time)) errors.push(`${tPrefix}.end_time must be HH:MM`);
        if (!isFiniteNumber(transport.price)) errors.push(`${tPrefix}.price must be number`);
        if (!isFiniteNumber(transport.cost)) errors.push(`${tPrefix}.cost must be number`);
        if (!isFiniteNumber(transport.distance)) errors.push(`${tPrefix}.distance must be number`);
        if (transport.mode === 'metro' && transport.tickets !== task.people_number) {
          errors.push(`${tPrefix}.tickets must equal people_number for metro`);
        }
      }
    });
  });
  return errors;
}

function runOfficialVerifier(input: {
  args: any;
  workingDirectory: string;
  outDir: string;
  methodName: string;
  resultsMethodDir: string;
  split: string;
}): BaselineReport['verifier'] {
  const officialRepoDir = input.args?.official_repo_dir
    ? path.resolve(input.workingDirectory, String(input.args.official_repo_dir))
    : undefined;
  if (!officialRepoDir) {
    return {
      status: 'blocked_missing_repo',
      reason: 'run_verifier=true but official_repo_dir was not provided.',
    };
  }
  const evalPath = path.join(officialRepoDir, 'eval_tpc.py');
  if (!fs.existsSync(evalPath)) {
    return {
      status: 'blocked_missing_eval_tpc',
      official_repo_ref: datasetRef(officialRepoDir),
      reason: 'official_repo_dir does not contain eval_tpc.py.',
    };
  }

  const copyResults = readBoolean(input.args?.copy_results_to_official_repo, true);
  if (copyResults) {
    const sourceDir = path.join(input.outDir, 'results', input.resultsMethodDir);
    const destinationDir = path.join(officialRepoDir, 'results', input.resultsMethodDir);
    fs.rmSync(destinationDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
    fs.cpSync(sourceDir, destinationDir, { recursive: true });
  }

  const stdoutPath = path.join(input.outDir, 'verifier.stdout.log');
  const stderrPath = path.join(input.outDir, 'verifier.stderr.log');
  const pythonBin = readString(input.args?.python_bin, 'python');
  const commandArgs = ['eval_tpc.py', '--splits', input.split, '--method', input.methodName, '--lang', 'en'];
  const result = spawnSync(pythonBin, commandArgs, {
    cwd: officialRepoDir,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const stderr = result.stderr || result.error?.message || '';
  fs.writeFileSync(stdoutPath, result.stdout || '', 'utf-8');
  fs.writeFileSync(stderrPath, stderr, 'utf-8');

  const scoreSourcePath = path.join(officialRepoDir, 'your_tpc_scores.json');
  const scoreDestPath = path.join(input.outDir, 'verifier-scores.json');
  if (fs.existsSync(scoreSourcePath)) {
    fs.copyFileSync(scoreSourcePath, scoreDestPath);
  }
  return {
    status: result.status === 0 ? 'completed' : 'failed',
    command: `${pythonBin} ${commandArgs.join(' ')}`,
    official_repo_ref: datasetRef(officialRepoDir),
    stdout_path: relativeDisplayPath(stdoutPath, input.workingDirectory),
    stderr_path: relativeDisplayPath(stderrPath, input.workingDirectory),
    ...(fs.existsSync(scoreDestPath) ? { scores_path: relativeDisplayPath(scoreDestPath, input.workingDirectory) } : {}),
    exit_code: result.status,
    ...(result.error ? { reason: result.error.message } : {}),
    ...(!result.error && result.status !== 0 && isMissingOfficialDatabaseError(stderr)
      ? { reason: 'official verifier failed before scoring because required ChinaTravel environment database files were missing.' }
      : {}),
  };
}

function buildNextRepairFocus(verifier: BaselineReport['verifier']): string[] {
  if (verifier.reason?.includes('environment database')) {
    return [
      'provide the official ChinaTravel environment database under chinatravel/database/**',
      'rerun official eval_tpc.py and confirm it reaches schema / commonsense / hard-logic scoring',
      'then bind attractions/restaurants/hotels/trains to official environment entities',
      'repair hard constraints before optimizing DAV / ATT / DDR soft preferences',
    ];
  }
  return [
    'bind attractions/restaurants/hotels/trains to official environment entities',
    'parse hard_logic_py into concrete required/forbidden attraction constraints',
    'rerun official eval_tpc.py and classify schema / commonsense / logic failures',
    'repair hard constraints before optimizing DAV / ATT / DDR soft preferences',
  ];
}

function isMissingOfficialDatabaseError(stderr: string): boolean {
  return /FileNotFoundError/.test(stderr) && /chinatravel\/(?:environment\/tools\/.*\/\.\.\/\.\.\/)?database\//.test(stderr);
}

function createSubmissionZip(outDir: string, teamName: string, version: string, rootToZip: string): string | undefined {
  const zipPath = path.join(outDir, `${teamName}_v${version}.zip`);
  const result = spawnSync('zip', ['-qr', path.basename(zipPath), rootToZip], {
    cwd: outDir,
    encoding: 'utf-8',
  });
  if (result.error || result.status !== 0 || !fs.existsSync(zipPath)) {
    return undefined;
  }
  return zipPath;
}

function buildManifest(input: {
  runId: string;
  methodName: string;
  resultsMethodDir: string;
  outDir: string;
  resultsDir: string;
  reportJsonPath: string;
  reportMdPath: string;
  failureQueuePath: string;
  zipPath?: string;
  taskCount: number;
  verifier: BaselineReport['verifier'];
  workingDirectory: string;
}): Record<string, unknown> {
  return {
    version: 1,
    run_id: input.runId,
    method_name: input.methodName,
    results_method_dir: input.resultsMethodDir,
    task_count: input.taskCount,
    status: input.verifier.status === 'completed' ? 'verifier_completed' : 'needs_official_verifier',
    artifacts: {
      out_dir: relativeDisplayPath(input.outDir, input.workingDirectory),
      results_dir: relativeDisplayPath(input.resultsDir, input.workingDirectory),
      report_json: relativeDisplayPath(input.reportJsonPath, input.workingDirectory),
      report_md: relativeDisplayPath(input.reportMdPath, input.workingDirectory),
      failure_queue: relativeDisplayPath(input.failureQueuePath, input.workingDirectory),
      ...(input.zipPath ? { zip: relativeDisplayPath(input.zipPath, input.workingDirectory) } : {}),
    },
    verifier: input.verifier,
    next_owner: 'guide',
    reviewer_handoff: 'Ask ReviewerCat to inspect verifier evidence before real Phase 1 submission.',
  };
}

function buildArtifactManifest(input: {
  outDir?: string;
  resultsDir?: string;
  reportJsonPath?: string;
  reportMdPath?: string;
  failureQueuePath?: string;
  manifestPath?: string;
  zipPath?: string;
  workingDirectory: string;
}): ArtifactManifestItem[] {
  const items: ArtifactManifestItem[] = [];
  if (input.resultsDir) {
    items.push(artifact(input.resultsDir, 'directory', 'generated', input.workingDirectory, 'prediction_results'));
  }
  if (input.manifestPath) {
    items.push(artifact(input.manifestPath, 'json', 'generated', input.workingDirectory, 'run_manifest'));
  }
  if (input.reportJsonPath) {
    items.push(artifact(input.reportJsonPath, 'json', 'generated', input.workingDirectory, 'baseline_report'));
  }
  if (input.reportMdPath) {
    items.push(artifact(input.reportMdPath, 'markdown', 'generated', input.workingDirectory, 'human_report'));
  }
  if (input.failureQueuePath) {
    items.push(artifact(input.failureQueuePath, 'jsonl', 'generated', input.workingDirectory, 'repair_queue'));
  }
  if (input.zipPath) {
    items.push(artifact(input.zipPath, 'zip', 'generated', input.workingDirectory, 'phase1_submission_zip'));
  }
  return uniqueArtifacts(items.filter(item => item.path && !item.path.startsWith('..')));
}

function artifact(
  filePath: string,
  type: string,
  action: ArtifactManifestItem['action'],
  root: string,
  artifactRole: string,
): ArtifactManifestItem {
  return {
    path: relativeDisplayPath(filePath, root),
    type,
    action,
    metadata: {
      source: 'tool_owned',
      artifact_role: artifactRole,
    },
  };
}

function renderReport(report: BaselineReport): string {
  return [
    '# Guide TPC Baseline Report',
    '',
    `run_id: ${report.run_id}`,
    `status: ${report.status}`,
    `method: ${report.method_name}`,
    `results_dir: ${report.artifacts.results_dir}`,
    `tasks: ${report.dataset.files_processed}/${report.dataset.files_total}`,
    `local_schema: ${report.schema_check.passed}/${report.schema_check.passed + report.schema_check.failed}`,
    `verifier_status: ${report.verifier.status}`,
    report.verifier.command ? `verifier_command: ${report.verifier.command}` : '',
    report.artifacts.zip_path ? `zip: ${report.artifacts.zip_path}` : '',
    '',
    '## Next Repair Focus',
    '',
    ...report.next_repair_focus.map(item => `- ${item}`),
    '',
  ].filter(line => line !== '').join('\n');
}

function formatResult(report: BaselineReport): string {
  return [
    `guide_tpc_baseline: status=${report.status}`,
    `run_id=${report.run_id}`,
    `method=${report.method_name}`,
    `tasks=${report.dataset.files_processed}/${report.dataset.files_total}`,
    `schema_passed=${report.schema_check.passed}`,
    `schema_failed=${report.schema_check.failed}`,
    `verifier_status=${report.verifier.status}`,
    `results_dir=${report.artifacts.results_dir}`,
    `manifest=${report.artifacts.manifest_path}`,
    `report=${report.artifacts.report_json_path}`,
    `report_md=${report.artifacts.report_md_path}`,
    `failure_queue=${report.artifacts.failure_queue_path}`,
    ...(report.artifacts.zip_path ? [`zip=${report.artifacts.zip_path}`] : []),
    '',
    'next:',
    ...report.next_repair_focus.map(item => `- ${item}`),
  ].join('\n');
}

function resolveOutputDir(workingDirectory: string, value: unknown, runId: string): string {
  const defaultDir = path.join('output', 'guide', 'tpc-baseline', runId);
  const requested = readString(value, defaultDir);
  const resolved = path.resolve(workingDirectory, requested);
  const relative = path.relative(workingDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('out_dir must stay inside the current working directory.');
  }
  return resolved;
}

function normalizeMethodName(value: unknown): string {
  return safeSegment(readString(value, DEFAULT_METHOD).replace(/_en$/i, '')) || DEFAULT_METHOD;
}

function createRunId(): string {
  return `guide-tpc-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function readString(value: unknown, fallback: string): string {
  const text = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
  return text || fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|1|yes)$/i.test(value.trim())) return true;
    if (/^(false|0|no)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'guide';
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function relativeDisplayPath(filePath: string, root: string): string {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function datasetRef(datasetDir: string): string {
  const home = process.env.HOME;
  if (home && datasetDir.startsWith(home)) {
    return datasetDir.replace(home, '$HOME').replace(/\\/g, '/');
  }
  return path.basename(datasetDir) || '[dataset]';
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 80))}\n... [truncated; see report artifacts]`;
}

function parseKeyValueLines(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_]+)=(.+)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }
  return fields;
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
