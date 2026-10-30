import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../../runtime/contracts/tool';
import { SubAgentManager } from '../../runtime/subagents/sub-agent-manager';
import { AIService } from '../../runtime/harness/models/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { Logger } from '../../runtime/observability/logger';
import { RoleResolver } from '../roles/role-resolver';
import { styles } from '../../runtime/observability/colors';
import { toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

/**
 * spawn_subagent - 派遣子智能体后台执行 skill、role-scoped task 或 no-skill task
 *
 * 主 agent 像"甩活给小弟"一样使用这个工具：
 * 调用后立即返回，子智能体在后台独立运行，
 * 主会话不阻塞，可以继续和用户对话。
 */
export class SpawnSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'spawn_subagent',
    description: '启动独立后台任务并立即返回 ID；每会话最多并行 3 个。role_name 与 skill_name 互斥，可都省略；跨角色只传 role_name，目标角色自行选择 Skill。完成或需要输入时自动通知 Main，包含结果与产物路径。Sub 不直接向用户交付；运行中补充要求用 steer_subagent，回答挂起问题用 resume_subagent。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '可选：要预激活的当前 role 可见 skill。只填 skill_name 时会继承父会话 role；指定 role_name 时不要同时填 skill_name。',
        },
        role_name: {
          type: 'string',
          description: '可选：子智能体使用的角色名或别名。只填 role_name 时，子智能体会在该 role 内自行选择 skill；传 base/default/none 表示明确不使用角色。',
        },
        task_description: {
          type: 'string',
          description: '用户能理解的简短工作名，如“调整面试计划”。不要含 Role、工具名、派工或内部检查流程；详细执行要求写在 user_message。',
        },
        user_message: {
          type: 'string',
          description: '传递给子智能体的完整用户指令（包含文件路径等必要信息）',
        },
      },
      required: ['task_description', 'user_message'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { skill_name, role_name, task_description, user_message } = args;
    const requestedSkillName = typeof skill_name === 'string' ? skill_name.trim() : '';
    const requestedRoleName = typeof role_name === 'string' ? role_name.trim() : '';

    if (!task_description || !user_message) {
      return toolFailure('错误：task_description、user_message 均为必填参数', 'INVALID_TOOL_ARGUMENTS');
    }
    if (requestedSkillName && requestedRoleName) {
      return toolFailure('错误：role_name 和 skill_name 只能二选一。跨 role 派遣时只传 role_name，让子智能体在目标 role 内自行选择 skill；当前 role 的明确后台任务才只传 skill_name。', 'INVALID_TOOL_ARGUMENTS');
    }

    const manager = SubAgentManager.getInstance();
    const sessionKey = context.sessionId || 'unknown';
    const roleResolution = resolveSubAgentRoleName(
      requestedRoleName || undefined,
      requestedSkillName ? context.roleName : undefined,
    );
    if (roleResolution.error) {
      return toolFailure(roleResolution.error, 'ROLE_NOT_FOUND');
    }
    const roleName = roleResolution.roleName;
    const allowSkillSelection = Boolean(!requestedSkillName && requestedRoleName && roleName);

    // Production uses default services; deterministic eval can inject scripted sub-agent services.
    const injectedServices = context.subAgentServiceFactory
      ? await context.subAgentServiceFactory({
        roleName,
        skillName: requestedSkillName || undefined,
        allowSkillSelection,
        workingDirectory: context.workingDirectory,
        parentSessionId: sessionKey,
      })
      : undefined;
    const aiService = (injectedServices?.aiService as AIService | undefined) || new AIService();
    const skillManager = (injectedServices?.skillManager as SkillManager | undefined) || new SkillManager(roleName);
    await skillManager.loadSkills();

    const result = manager.spawn(
      sessionKey,
      requestedSkillName || undefined,
      task_description,
      user_message,
      context.workingDirectory,
      aiService,
      skillManager,
      {
        roleName,
        allowSkillSelection,
        observabilityContext: context.observabilityContext,
        parentSessionId: sessionKey,
        parentToolCallId: context.toolCallId,
      },
    );

    if ('error' in result) {
      return toolFailure(`派遣失败：${result.error}`, 'SUBAGENT_SPAWN_FAILED');
    }

    if (!Logger.isSilentMode()) {
      console.log('\n' + styles.highlight(`🚀 派遣子智能体: ${task_description}`));
      console.log(styles.text(`   ID: ${result.id}`));
      if (roleName) {
        console.log(styles.text(`   Role: ${roleName}`));
      }
      console.log(styles.text(`   Skill: ${formatSubAgentSkillLabel(requestedSkillName, allowSkillSelection)}\n`));
    }

    return toolSuccess([
      `子智能体 ${result.id} 已派遣，正在后台执行「${task_description}」。`,
      ...(roleName ? [`Role: ${roleName}`] : []),
      `Skill: ${formatSubAgentSkillLabel(requestedSkillName, allowSkillSelection)}`,
      `状态: running`,
      ``,
      `以上均为内部状态，不是给用户的消息。结果返回后由你结合整体交付意图判断何时汇报，允许先静默收下。实际交付时 channel 用 send_text/send_file，CLI 正常回复。默认不提子智能体、后台同事、派工、内部转交或消息同步，用户明确问架构/调试时除外。`,
      `派工后释放当前对话，不轮询等待。用户询问进度时用 check_subagent；要求停止时用 stop_subagent。`,
    ].join('\n'));
  }
}

function formatSubAgentSkillLabel(skillName: string, allowSkillSelection: boolean): string {
  if (skillName) {
    return skillName;
  }
  return allowSkillSelection ? '由子智能体自行选择' : '无预设 skill';
}

function resolveSubAgentRoleName(requestedRole: unknown, inheritedRole: unknown): { roleName?: string; error?: string } {
  const requested = typeof requestedRole === 'string' ? requestedRole.trim() : '';
  const inherited = typeof inheritedRole === 'string' ? inheritedRole.trim() : '';
  const rawRole = requested || inherited;
  if (!rawRole) {
    return {};
  }

  const normalized = RoleResolver.normalizeRoleName(rawRole);
  if (normalized === '' || normalized === 'base' || normalized === 'default' || normalized === 'none') {
    return {};
  }

  const resolved = RoleResolver.resolveRoleDirectoryName(rawRole);
  if (resolved) {
    return { roleName: resolved };
  }

  const available = RoleResolver.listAvailableRoles();
  const detail = available.length > 0
    ? `可用角色：${available.join(', ')}`
    : '当前项目还没有 roles 目录或角色定义。';
  return { error: `错误：未找到 role_name "${rawRole}"。${detail}` };
}
