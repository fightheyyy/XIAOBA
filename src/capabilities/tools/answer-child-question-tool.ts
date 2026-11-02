import { SubAgentManager } from '../../runtime/subagents/sub-agent-manager';
import type { Tool, ToolExecutionContext, ToolDefinition } from '../../runtime/contracts/tool';
import { toolBlocked, toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

export class AnswerChildQuestionTool implements Tool {
  definition: ToolDefinition = {
    name: 'answer_child_question',
    description: '仅回答当前父会话子任务提出的尚未消费的信息问题。不是任意 resume；需要真实用户确认的问题不能由此工具批准。',
    parameters: { type: 'object', properties: {
      question_id: { type: 'string' }, answer: { type: 'string' },
    }, required: ['question_id', 'answer'] },
  };
  isAvailable(context: Partial<ToolExecutionContext>): boolean {
    return context.subagentRouting === 'jev' && !context.parentSessionId && Boolean(context.sessionId)
      && !context.sessionId?.startsWith('subagent:')
      && ['base', 'default', 'none'].includes(context.roleName || '')
      && SubAgentManager.getInstance().listByParent(context.sessionId!, context.workingDirectory)
        .some(info => info.status === 'waiting_for_input' && info.pendingQuestionId);
  }
  async execute(args: any, context: ToolExecutionContext) {
    if (!this.isAvailable(context)) return toolBlocked('没有可回答的当前子任务问题', 'QUESTION_NOT_PENDING', 'Current parent pending question required.');
    if (typeof args?.question_id !== 'string' || typeof args?.answer !== 'string' || !args.answer.trim() || args.answer.length > 8000) {
      return toolFailure('需要 question_id 和不超过 8000 字符的 answer', 'INVALID_TOOL_ARGUMENTS');
    }
    const result = SubAgentManager.getInstance().answerQuestionForParent(context.sessionId!, args.question_id, args.answer, context.workingDirectory);
    return result === 'resumed' ? toolSuccess('信息问题已回答；不代表任何用户授权。')
      : toolFailure(result === 'user_confirmation_required' ? '此问题必须由真实用户确认' : '问题已过期或已被回答', result === 'user_confirmation_required' ? 'USER_CONFIRMATION_REQUIRED' : 'QUESTION_NOT_PENDING');
  }
}
