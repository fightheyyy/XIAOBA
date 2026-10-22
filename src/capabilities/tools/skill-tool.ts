import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../../runtime/contracts/tool';
import { SkillManager } from '../skills/skill-manager';
import { SkillInvocationContext } from '../../runtime/contracts/skill';
import { buildSkillActivationSignal } from '../skills/skill-activation-protocol';
import { Logger } from '../../runtime/observability/logger';
import { toolBlocked, toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

/**
 * Skill 工具 - 调用已注册的 skills
 */
export class SkillTool implements Tool {
  definition: ToolDefinition = {
    name: 'skill',
    description: '调用已注册的 skill。Skills 是预定义的任务模板，可以执行复杂的多步骤任务。',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill 名称（如 "paper-analysis", "commit" 等）'
        },
        args: {
          type: 'string',
          description: 'Skill 参数（可选）'
        }
      },
      required: ['skill']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { skill: skillName, args: skillArgs = '' } = args;

    try {
      const skillManager = new SkillManager(context.roleName);
      // 特殊命令：reload
      if (skillName === 'reload' || skillName === '__reload__') {
        await skillManager.loadSkills();
        const count = skillManager.getAllSkills().length;
        return toolSuccess(JSON.stringify({ __reload_skills__: true, message: `已重新加载 ${count} 个 skills` }));
      }

      // 加载所有 skills
      await skillManager.loadSkills();

      // 获取指定的 skill
      const skill = skillManager.getSkill(skillName);

      if (!skill) {
        const availableSkills = skillManager.getUserInvocableSkills()
          .map(s => s.metadata.name)
          .join(', ');

        return toolFailure(`错误：未找到 skill "${skillName}"。\n\n可用的 skills: ${availableSkills}`, 'SKILL_NOT_FOUND');
      }

      // 检查 skill 是否可被用户调用
      if (skill.metadata.userInvocable === false) {
        return toolBlocked(
          `错误：Skill "${skillName}" 不允许用户调用。`,
          'SKILL_NOT_USER_INVOCABLE',
          `Skill "${skillName}" is not user invocable.`,
        );
      }

      Logger.info(`执行 Skill: ${skillName}`);
      if (skillArgs) {
        Logger.info(`参数: ${skillArgs}`);
      }

      // 解析参数
      const argumentsArray = skillArgs ? skillArgs.trim().split(/\s+/) : [];

      // 创建 skill 调用上下文
      const invocationContext: SkillInvocationContext = {
        skillName: skillName,
        arguments: argumentsArray,
        rawArguments: skillArgs,
        userMessage: skillArgs
      };

      // 返回结构化激活信号，由 ConversationRunner 统一处理
      const signal = buildSkillActivationSignal(skill, invocationContext);

      return toolSuccess(JSON.stringify(signal));
    } catch (error: any) {
      Logger.error(`Skill 执行失败: ${error.message}`);
      return toolFailure(`Skill 执行失败: ${error.message}`, 'SKILL_EXECUTION_FAILED');
    }
  }
}
