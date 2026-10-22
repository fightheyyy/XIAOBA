import { runTraceReplay, renderTraceReplayReport } from '../../../eval/replay/trace-replay-runner';

export interface ReplayCommandOptions {
  trace?: string;
  out?: string;
  cwd?: string;
  petId?: string;
  sessionKey?: string;
  maxTurns?: string;
  timeoutMs?: string;
}

export async function replayCommand(options: ReplayCommandOptions): Promise<void> {
  if (!options.trace) {
    throw new Error('缺少 --trace <traces.jsonl>');
  }

  const report = await runTraceReplay({
    tracePath: options.trace,
    outDir: options.out,
    cwd: options.cwd,
    petId: options.petId,
    sessionKey: options.sessionKey,
    maxTurns: parseOptionalPositiveInt(options.maxTurns, '--max-turns'),
    timeoutMs: parseOptionalPositiveInt(options.timeoutMs, '--timeout-ms'),
  });

  console.log(renderTraceReplayReport(report));
  console.log(`Artifacts: ${report.out_dir}`);
}

function parseOptionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
