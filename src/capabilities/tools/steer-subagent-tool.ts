import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../../runtime/contracts/tool';
import { toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';
import { SubAgentManager } from '../../runtime/subagents/sub-agent-manager';

export class SteerSubagentTool implements Tool {
  definition: ToolDefinition = {
    name: 'steer_subagent',
    description: '给当前会话中正在运行的子智能体补充要求。消息在下一次推理前读取，不中断正在执行的工具。返回已接收不代表已经落实；等待回答的子任务用 resume_subagent，停止用 stop_subagent。',
    parameters: { type: 'object', properties: {
      subagent_id: { type: 'string', description: '已有子任务的 ID' },
      message: { type: 'string', description: '补充要求，最多 8000 字符' },
    }, required: ['subagent_id', 'message'] },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    if (typeof args.subagent_id !== 'string' || typeof args.message !== 'string'
      || !args.message.trim() || args.message.length > 8000) {
      return toolFailure('请提供子任务 ID 和不超过 8000 字符的补充要求。', 'INVALID_TOOL_ARGUMENTS');
    }
    const result = SubAgentManager.getInstance().steerForParent(context.sessionId || 'unknown', args.subagent_id, args.message);
    if (result === 'accepted') return toolSuccess('已接收补充要求，将在子智能体下一次推理前读取。');
    return toolFailure(result === 'not_running' ? '子任务当前不接收插话。请依据最新状态处理：等待输入时用 resume_subagent，已结束时检查结果。' : '未找到当前会话的子任务。',
      result === 'not_running' ? 'SUBAGENT_NOT_RUNNING' : 'SUBAGENT_NOT_FOUND');
  }
}
