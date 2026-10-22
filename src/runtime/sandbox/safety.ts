import * as fs from 'fs';
import * as path from 'path';

const DANGEROUS_TOOL_ALLOW_ENV = 'XIAOBA_TOOL_ALLOW';
const BASH_ALLOW_DANGEROUS_ENV = 'XIAOBA_BASH_ALLOW_DANGEROUS';
const FS_ALLOW_OUTSIDE_ENV = 'XIAOBA_FS_ALLOW_OUTSIDE';
const FS_ALLOW_OUTSIDE_READ_ENV = 'XIAOBA_FS_ALLOW_OUTSIDE_READ';
const FS_ALLOW_DOTENV_ENV = 'XIAOBA_FS_ALLOW_DOTENV';

const DEFAULT_DANGEROUS_TOOLS = new Set([
  'execute_shell',
  'execute_bash',
  'write_file',
  'edit_file',

  'self_evolution'
]);

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(?=[^;\n]*(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$))(?=[^;\n]*(?:-[a-z]*f[a-z]*|--force)(?:\s|$))[^;\n]+/i,
    reason: '检测到递归强制删除（rm recursive + force）',
  },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-z]:\\/i, reason: '检测到可能清空磁盘的 del /s /q' },
  { pattern: /\bformat(\.exe)?\s+[a-z]:/i, reason: '检测到磁盘格式化命令' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: '检测到文件系统格式化命令' },
  { pattern: /\bdiskpart\b/i, reason: '检测到磁盘分区工具' },
  { pattern: /\bshutdown\b/i, reason: '检测到关机/重启命令' },
  { pattern: /\breboot\b/i, reason: '检测到重启命令' },
  { pattern: /\bpoweroff\b/i, reason: '检测到关机命令' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, reason: '检测到 Fork Bomb' }
];

function parseAllowedTools(): Set<string> {
  const raw = (process.env[DANGEROUS_TOOL_ALLOW_ENV] || '').trim();
  if (!raw) return new Set();
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  const allowed = new Set(parts);

  // execute_shell 和 execute_bash 视为等价，避免迁移期配置失效
  if (allowed.has('execute_bash')) {
    allowed.add('execute_shell');
  }
  if (allowed.has('execute_shell')) {
    allowed.add('execute_bash');
  }
  return allowed;
}

export function isToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
  return { allowed: true };
}

export function isBashCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  if (process.env[BASH_ALLOW_DANGEROUS_ENV] === 'true') {
    return { allowed: true };
  }

  for (const rule of DANGEROUS_BASH_PATTERNS) {
    if (rule.pattern.test(command)) {
      return {
        allowed: false,
        reason: `${rule.reason}。如需强制执行，请设置 ${BASH_ALLOW_DANGEROUS_ENV}=true`
      };
    }
  }

  return { allowed: true };
}

function isOutsideWorkingDirectory(targetPath: string, workingDirectory: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedCwd = path.resolve(workingDirectory);

  if (resolvedTarget === resolvedCwd) {
    return false;
  }

  const normalizedTarget = resolvedTarget.toLowerCase();
  const normalizedCwd = resolvedCwd.toLowerCase();
  const cwdWithSep = normalizedCwd.endsWith(path.sep) ? normalizedCwd : normalizedCwd + path.sep;
  return !normalizedTarget.startsWith(cwdWithSep);
}

export function isReadPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  return { allowed: true };
}

export function isPathAllowed(targetPath: string, workingDirectory: string): { allowed: boolean; reason?: string } {
  return { allowed: true };
}

/**
 * Opt-in write boundary used by narrow runtime workflows such as EvolutionCat.
 * Normal roles keep the existing workspace policy unless their runtime supplies
 * an explicit allowedWriteRoot.
 */
export function isWritePathWithinRoot(
  targetPath: string,
  workingDirectory: string,
  allowedWriteRoot: string,
): { allowed: boolean; reason?: string } {
  if (!targetPath.trim()) {
    return { allowed: false, reason: '写入路径不能为空。' };
  }
  if (path.isAbsolute(targetPath) || path.win32.isAbsolute(targetPath)) {
    return { allowed: false, reason: '隔离子会话只允许相对于工作目录的写入路径。' };
  }
  if (targetPath.split(/[\\/]+/).includes('..')) {
    return { allowed: false, reason: '隔离子会话不允许包含 .. 的写入路径。' };
  }

  const lexicalRoot = path.resolve(allowedWriteRoot);
  const lexicalTarget = path.resolve(workingDirectory, targetPath);
  if (!isPathInside(lexicalTarget, lexicalRoot)) {
    return { allowed: false, reason: `写入路径超出允许目录: ${allowedWriteRoot}` };
  }

  try {
    const realRoot = fs.realpathSync(lexicalRoot);
    const existingAncestor = findExistingAncestor(lexicalTarget);
    const realAncestor = fs.realpathSync(existingAncestor);
    if (!isPathInside(realAncestor, realRoot)) {
      return { allowed: false, reason: `写入路径通过符号链接逃逸允许目录: ${allowedWriteRoot}` };
    }
  } catch (error: any) {
    return {
      allowed: false,
      reason: `无法验证隔离写入路径: ${error?.message || String(error)}`,
    };
  }

  return { allowed: true };
}

function findExistingAncestor(targetPath: string): string {
  let current = targetPath;
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`没有可验证的父目录: ${targetPath}`);
    }
    current = parent;
  }
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
