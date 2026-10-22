import { ReadinessCategory, ReadinessReport } from './types';

const CATEGORY_ORDER: ReadinessCategory[] = [
  'runtime',
  'project',
  'provider',
  'roles',
  'drivers',
  'surfaces',
];

const CATEGORY_LABELS: Record<ReadinessCategory, string> = {
  runtime: 'Runtime',
  project: 'Project',
  provider: 'Provider',
  roles: 'Roles',
  drivers: 'Drivers',
  surfaces: 'Surfaces',
};

export function renderDoctorReport(report: ReadinessReport): string {
  const lines = [
    `XiaoBa Doctor ${report.app.version}`,
    `Overall: ${report.overall.toUpperCase()}`,
    `Active role: ${report.context.activeRole || 'base'}`,
    '',
  ];

  for (const category of CATEGORY_ORDER) {
    const checks = report.checks.filter(check => check.category === category);
    if (checks.length === 0) continue;
    lines.push(CATEGORY_LABELS[category]);
    for (const check of checks) {
      const requirement = check.required ? ' required' : '';
      lines.push(`  [${check.status.toUpperCase()}]${requirement} ${check.label}: ${check.summary}`);
    }
    lines.push('');
  }

  const nextActions = Array.from(new Set(report.checks
    .map(check => check.nextAction)
    .filter((action): action is string => Boolean(action))));
  if (nextActions.length > 0) {
    lines.push('Next actions');
    nextActions.forEach(action => lines.push(`  - ${action}`));
    lines.push('');
  }

  lines.push(
    `Summary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, `
      + `${report.summary.failed} failed, ${report.summary.blocked} blocked`,
  );
  return lines.join('\n');
}

export function renderDoctorJson(report: ReadinessReport): string {
  return JSON.stringify(report, null, 2);
}
