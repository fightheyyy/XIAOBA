import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../../runtime/contracts/tool';
import { SubAgentManager } from '../../runtime/subagents/sub-agent-manager';
import { Logger } from '../../runtime/observability/logger';
import { toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

/**
 * resume_subagent - 恢复挂起的子智能体
 *
 * 当子智能体状态为 waiting_for_input 时，主 agent 用此工具提供答案，让子智能体继续执行。
 */
export class ResumeSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'resume_subagent',
    description: `恢复一个处于 waiting_for_input 状态的子智能体。

当子智能体遇到需要确认的问题时会挂起，通过 check_subagent 可以看到它的 pendingQuestion。
你可以自己判断如何回答，也可以先问用户再回答。用此工具把答案传给子智能体，让它继续执行。`,
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'string',
          description: '要恢复的子智能体 ID',
        },
        answer: {
          type: 'string',
          description: '给子智能体的回答/指令',
        },
      },
      required: ['subagent_id', 'answer'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { subagent_id, answer } = args;
    const sessionKey = context.sessionId || 'unknown';

    if (!subagent_id || !answer) {
      return toolFailure('错误：请提供 subagent_id 和 answer', 'INVALID_TOOL_ARGUMENTS');
    }

    const manager = SubAgentManager.getInstance();
    const result = manager.resumeForParent(sessionKey, subagent_id, answer);

    switch (result) {
      case 'resumed':
        Logger.info(`[ResumeSubagent] 已恢复 ${subagent_id}`);
        return toolSuccess(`子智能体 ${subagent_id} 已恢复执行。`);
      case 'not_waiting':
        return toolFailure(`子智能体 ${subagent_id} 当前未处于等待状态，无需恢复。`, 'SUBAGENT_NOT_WAITING');
      case 'forbidden':
      case 'not_found':
        return toolFailure(`未找到子智能体 ${subagent_id}。`, 'SUBAGENT_NOT_FOUND');
    }
  }
}
