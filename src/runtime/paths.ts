import * as path from 'path';
import * as fs from 'fs';
import { ActiveRoleContext } from '../capabilities/roles/active-role-context';

/**
 * 路径解析工具类
 */
export class PathResolver {
  /** Installed application resources, independent of the task workspace. */
  static getApplicationRoot(): string {
    return path.resolve(__dirname, '../..');
  }

  static getProjectRoot(): string {
    return ActiveRoleContext.getProjectRoot();
  }

  static getPromptsPath(): string {
    return path.join(this.getProjectRoot(), 'prompts');
  }

  static getRolesPath(): string {
    return ActiveRoleContext.getRolesRoot();
  }

  static getActiveRolePath(): string | undefined {
    return ActiveRoleContext.getActiveRolePath();
  }

  static getRolePath(roleName?: string): string | undefined {
    if (!roleName) {
      return this.getActiveRolePath();
    }
    const resolved = ActiveRoleContext.resolveRoleDirectoryName(roleName);
    if (!resolved) {
      return undefined;
    }
    return path.join(ActiveRoleContext.getRolesRoot(), resolved);
  }

  static getRoleSubPath(relativePath: string): string | undefined {
    const rolePath = this.getActiveRolePath();
    if (!rolePath) {
      return undefined;
    }
    return path.join(rolePath, relativePath);
  }

  static getRoleSubPathForRole(roleName: string | undefined, relativePath: string): string | undefined {
    const rolePath = this.getRolePath(roleName);
    if (!rolePath) {
      return undefined;
    }
    return path.join(rolePath, relativePath);
  }

  static getBaseSkillsPath(): string {
    return process.env.XIAOBA_SKILLS_ROOT
      ? path.resolve(process.env.XIAOBA_SKILLS_ROOT)
      : path.join(this.getProjectRoot(), 'skills');
  }

  /**
   * 获取当前激活上下文的 skills 目录。
   * 有角色时返回 roles/<role>/skills，否则返回项目根目录 skills。
   */
  static getSkillsPath(): string {
    const roleSkillsPath = this.getRoleSubPath('skills');
    return roleSkillsPath || this.getBaseSkillsPath();
  }

  static getRoleToolsPath(): string | undefined {
    return this.getRoleSubPath('tools');
  }

  static getRoleHooksPath(): string | undefined {
    return this.getRoleSubPath('hooks');
  }

  /**
   * 确保目录存在
   */
  static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 递归查找所有 SKILL.md 文件
   */
  static findSkillFiles(baseDir: string): string[] {
    const results: string[] = [];

    if (!fs.existsSync(baseDir)) {
      return results;
    }

    const rootSkillFile = path.join(baseDir, 'SKILL.md');
    if (fs.existsSync(rootSkillFile)) {
      results.push(rootSkillFile);
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        // 递归查找子目录
        results.push(...this.findSkillFiles(fullPath));
      }
    }

    return results;
  }
}
