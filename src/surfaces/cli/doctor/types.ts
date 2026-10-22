export type ReadinessCheckStatus = 'pass' | 'warn' | 'fail' | 'blocked';
export type ReadinessOverallStatus = 'ready' | 'degraded' | 'not_ready';
export type ReadinessCategory = 'runtime' | 'project' | 'provider' | 'roles' | 'drivers' | 'surfaces';
export type ReadinessDataValue = string | number | boolean | null | string[];

export interface ReadinessCheck {
  id: string;
  category: ReadinessCategory;
  label: string;
  status: ReadinessCheckStatus;
  required: boolean;
  summary: string;
  nextAction?: string;
  data?: Record<string, ReadinessDataValue>;
}

export interface ReadinessReport {
  schemaVersion: 1;
  generatedAt: string;
  overall: ReadinessOverallStatus;
  ready: boolean;
  app: {
    name: 'xiaoba-cli';
    version: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  context: {
    cwd: string;
    projectRoot: string;
    rolesRoot: string;
    requestedRole: string;
    activeRole: string | null;
  };
  summary: {
    total: number;
    passed: number;
    warnings: number;
    failed: number;
    blocked: number;
    requiredIssues: number;
  };
  checks: ReadinessCheck[];
}

export interface DoctorRunOptions {
  requestedRole?: string;
  cwd?: string;
}

export interface SecretaryReadinessStatus {
  cliInstalled: boolean;
  profileMatched: boolean | null;
  userIdentity: string;
  botIdentity: string;
}
