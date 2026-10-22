import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { Logger } from '../../../runtime/observability/logger';
import { styles } from '../../../runtime/observability/colors';
import { RoleManager } from '../../../capabilities/roles/role-manager';

export function registerRoleCommand(program: Command): void {
  const roleCmd = program
    .command('role')
    .description('管理 XiaoBa roles');

  roleCmd
    .command('list')
    .description('列出所有可用的 roles')
    .action(() => {
      listRoles();
    });

  roleCmd
    .command('info <name>')
    .description('查看 role 详情')
    .action((name: string) => {
      showRoleInfo(name);
    });

  roleCmd
    .command('remove <name>')
    .alias('delete')
    .description('移除已安装的 role')
    .option('-f, --force', '强制移除，不询问确认')
    .action(async (name: string, options: { force?: boolean }) => {
      await removeRole(name, options.force);
    });
}

function listRoles(): void {
  Logger.title('可用的 Roles');

  const roles = RoleManager.listRoles();
  if (roles.length === 0) {
    Logger.warning('没有找到任何 role');
    Logger.info('\n提示：');
    Logger.info('  - 将 role 放在 roles/<role-name>/role.json');
    Logger.info('  - 默认安装包内置 review-loop roles，以及 engineer-cat、browser-cat、gui-cat、secretary-cat、evolution-cat');
    return;
  }

  Logger.info(`\n找到 ${styles.highlight(roles.length.toString())} 个 role:\n`);

  for (const role of roles) {
    const active = role.active ? ` ${chalk.green('(当前)')}` : '';
    Logger.info(`${styles.highlight('●')} ${styles.highlight(role.name)}${active}`);
    Logger.info(`  ${chalk.gray('显示名:')} ${role.displayName}`);
    if (role.description) {
      Logger.info(`  ${chalk.gray('描述:')} ${role.description}`);
    }
    if (role.aliases.length > 0) {
      Logger.info(`  ${chalk.gray('别名:')} ${role.aliases.join(', ')}`);
    }
    Logger.info(`  ${chalk.gray('路径:')} ${role.path}`);
    Logger.info('');
  }
}

function showRoleInfo(name: string): void {
  const role = RoleManager.getRole(name);
  if (!role) {
    Logger.error(`未找到 role: ${name}`);
    Logger.info('\n使用 xiaoba role list 查看所有可用的 roles');
    process.exit(1);
  }

  Logger.title(`Role 详情: ${role.name}`);
  Logger.info(`\n${chalk.gray('名称:')} ${styles.highlight(role.name)}`);
  Logger.info(`${chalk.gray('显示名:')} ${role.displayName}`);
  if (role.description) {
    Logger.info(`${chalk.gray('描述:')} ${role.description}`);
  }
  if (role.aliases.length > 0) {
    Logger.info(`${chalk.gray('别名:')} ${role.aliases.join(', ')}`);
  }
  Logger.info(`${chalk.gray('Prompt:')} ${role.promptFile || '-'}`);
  Logger.info(`${chalk.gray('当前激活:')} ${role.active ? '是' : '否'}`);
  Logger.info(`${chalk.gray('路径:')} ${role.path}`);
}

async function removeRole(name: string, force?: boolean): Promise<void> {
  Logger.title(`移除 Role: ${name}`);

  const role = RoleManager.getRole(name);
  if (!role) {
    Logger.error(`未找到 role: ${name}`);
    Logger.info('\n使用 xiaoba role list 查看所有可用的 roles');
    process.exit(1);
  }

  Logger.info(`\n${chalk.gray('名称:')} ${styles.highlight(role.name)}`);
  Logger.info(`${chalk.gray('显示名:')} ${role.displayName}`);
  if (role.description) {
    Logger.info(`${chalk.gray('描述:')} ${role.description}`);
  }
  Logger.info(`${chalk.gray('路径:')} ${role.path}`);

  if (!force) {
    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: '\n确定要移除这个 role 吗？',
        default: false,
      },
    ]);

    if (!confirmed) {
      Logger.info('已取消移除');
      return;
    }
  }

  try {
    const removed = RoleManager.removeRole(name);
    Logger.success(`\n✓ Role ${styles.highlight(removed.name)} 已成功移除！`);
    Logger.info(`已删除目录: ${removed.path}`);
    if (removed.wasActive) {
      Logger.info('已清空当前激活角色，后续会话将回到 Base。');
    }
  } catch (error: any) {
    Logger.error(`移除失败: ${error.message}`);
    process.exit(1);
  }
}
