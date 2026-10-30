import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../../runtime/contracts/tool';
import { normalizeExternalDeliveryReceipts } from '../../runtime/delivery/delivery-receipts';
import { toolBlocked, toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

/**
 * send_text 工具
 * 发送一条文本消息给用户
 */
export class SendTextTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_text',
    description: '发送一条用户可见文本消息。消息会话中，所有要让用户看到的文本都必须通过此工具发送；短消息也用它。按内容自然分段，不为字数强行拆分消息。',
    transcriptMode: 'outbound_message',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发送的文本内容。保持语义完整，按实际需要决定长度。',
        },
      },
      required: ['text'],
    },
  };

  async execute(args: { text: string }, context: ToolExecutionContext): Promise<string | ToolExecutionOutput> {
    const { text } = args;

    if (!context.channel) {
      return toolBlocked(
        'send_text 需要 channel 上下文',
        'TOOL_FORBIDDEN_FOR_SURFACE',
        'send_text requires a channel-backed surface context.',
      );
    }

    if (!text || !text.trim()) {
      return toolFailure('text 不能为空', 'INVALID_TOOL_ARGUMENTS');
    }

    const chatId = context.channel.chatId;
    const trimmedText = text.trim();
    try {
      const receipts = await context.channel.reply(chatId, trimmedText);
      const externalDeliveryReceipts = normalizeExternalDeliveryReceipts(receipts, {
        receiptType: 'message',
        surface: context.surface,
        deliveryId: `${context.surface || 'surface'}.send_text`,
      });

      return toolSuccess('已发送', {
        ...(externalDeliveryReceipts.length ? { externalDeliveryReceipts } : {}),
      });
    } catch (error: any) {
      const message = String(error?.message || error || '');
      const rateLimited = isRateLimitLikeMessage(message);
      return toolFailure(`工具执行错误: ${message}`, rateLimited ? 'RATE_LIMIT' : 'DELIVERY_FAILED', {
        retryable: rateLimited,
      });
    }
  }
}

function isRateLimitLikeMessage(message: string): boolean {
  return /\b429\b|rate limit|too many requests|频率受限|限流/i.test(message);
}
