import { Command } from 'commander';
import { renderDoctorJson, renderDoctorReport } from '../doctor/doctor-renderer';
import { runDoctor } from '../doctor/doctor-runner';
import { DoctorRunOptions, ReadinessReport } from '../doctor/types';

export interface DoctorCommandDependencies {
  run?: (options: DoctorRunOptions) => Promise<ReadinessReport>;
  write?: (output: string) => void;
}

export function registerDoctorCommand(
  program: Command,
  dependencies: DoctorCommandDependencies = {},
): void {
  program
    .command('doctor')
    .description('检查 XiaoBa 本机环境、角色与外部能力是否就绪')
    .option('-r, --role <name>', '按指定角色判断必需依赖')
    .option('--json', '输出可机器解析的 JSON')
    .action(async (options: { role?: string; json?: boolean }, command: Command) => {
      const globalOptions = command.optsWithGlobals() as { role?: string };
      const report = await (dependencies.run || runDoctor)({
        requestedRole: options.role || globalOptions.role,
      });
      const output = options.json ? renderDoctorJson(report) : renderDoctorReport(report);
      (dependencies.write || console.log)(output);
      if (report.overall === 'not_ready') {
        process.exitCode = 1;
      }
    });
}

