import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../../runtime/contracts/tool';
import { SubAgentManager } from '../../runtime/subagents/sub-agent-manager';
import { toolBlocked, toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

/**
 * ask_parent - 子智能体向父会话请求输入
 *
 * 只能在 subagent 会话中使用。工具会挂起当前子智能体，
 * 通过平台回调把问题投递给主 agent，等待主 agent 用 resume_subagent 恢复。
 */
export class AskParentTool implements Tool {
  definition: ToolDefinition = {
    name: 'ask_parent',
    description: `子智能体在后台任务中遇到必须由主会话或用户确认的问题时使用。

调用后当前子智能体会进入 waiting_for_input 状态，主会话会收到问题。
主会话确认答案后会用 resume_subagent 恢复你，你将收到用户/主会话的答案。

只在继续执行会产生明显误改风险时使用。能基于现有上下文做安全默认选择时，不要频繁打断主会话。`,
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '需要主会话或用户确认的问题，需包含推荐选项、默认建议和风险说明',
        },
      },
      required: ['question'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { question } = args || {};
    if (!question || typeof question !== 'string') {
      return toolFailure('错误：请提供 question', 'INVALID_TOOL_ARGUMENTS');
    }

    const sessionId = context.sessionId || '';
    if (!sessionId.startsWith('subagent:')) {
      return toolBlocked(
        '错误：ask_parent 只能在子智能体会话中使用',
        'TOOL_FORBIDDEN_FOR_CONTEXT',
        'ask_parent can only run inside a subagent session.',
      );
    }

    const subAgentId = sessionId.slice('subagent:'.length);
    const answer = await SubAgentManager.getInstance().requestParentInput(subAgentId, question);
    return toolSuccess(`主会话回复：${answer}`);
  }
}
