import { Tool, ToolExecutionContext, ToolDefinition } from '../../runtime/contracts/tool';
import { toolBlocked, toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

/** Surface-owned validation/delivery keeps the runtime independent of UI protocols. */
export class SendUITool implements Tool {
  definition: ToolDefinition = {
    name: 'send_ui',
    description: '在当前对话交付可信的 A2UI v0.9 声明式界面。messages 为 createSurface/updateComponents/updateDataModel/deleteSurface 消息数组。仅使用客户端声明的 catalog；不要生成 HTML/JS。交互结果由用户提交回 Main Agent。',
    parameters: { type: 'object', properties: {
      messages: { type: 'array', items: { type: 'object' }, description: '有序的 A2UI 消息。createSurface 的 catalogId 使用 xiaoba://ui/basic-v1；组件根 id 为 root。' },
    }, required: ['messages'] },
  };
  isAvailable(context: Partial<ToolExecutionContext>): boolean {
    return Boolean(context.channel?.sendUI) && !context.parentSessionId;
  }
  async execute(args: any, context: ToolExecutionContext) {
    if (!this.isAvailable(context)) return toolBlocked('当前入口不支持 UI 交付', 'TOOL_FORBIDDEN_FOR_SURFACE', 'Main session UI capability required.');
    if (!Array.isArray(args?.messages) || !args.messages.length) return toolFailure('messages must be a non-empty array', 'INVALID_TOOL_ARGUMENTS');
    try {
      await context.channel!.sendUI!({ kind: 'a2ui', messages: args.messages });
      return toolSuccess('界面已交付，用户可在当前对话提交操作。', { deliveryEvidence: [{ delivery_type: 'ui', status: 'delivered', surface: context.surface, timestamp: new Date().toISOString() }] });
    } catch (error: any) { return toolFailure(String(error.message || 'UI delivery failed'), 'UI_DELIVERY_FAILED'); }
  }
}
