import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../../runtime/contracts/tool';
import { normalizeExternalDeliveryReceipts } from '../../runtime/delivery/delivery-receipts';
import { Logger } from '../../runtime/observability/logger';
import { toolBlocked, toolFailure, toolSuccess } from '../../runtime/contracts/tool-result';

/**
 * 文件发送工具（平台通用）
 * 允许 AI 在处理过程中主动给用户发送文件
 *
 * 发送能力通过 ToolExecutionContext.channel 注入，无需 bind/unbind。
 */
export class SendFileTool implements Tool {
  definition: ToolDefinition = {
    name: 'send_file',
    description: `发送文件给用户（用于详细报告、长分析、超长内容）。

使用场景：
- 内容超过 500 字的详细报告或分析
- 包含大量数据、代码、详细说明
- 发送文件后，如需说明，只需用 send_text 工具简短说明"详情看文件"即可

避免在聊天中发送大段文字，改用文件。`,
    transcriptMode: 'outbound_file',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要发送的文件的绝对路径',
        },
        file_name: {
          type: 'string',
          description: '文件名（含扩展名），如 "论文精读.md"',
        },
      },
      required: ['file_path', 'file_name'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<string | ToolExecutionOutput> {
    const { file_path, file_name } = args;
    const channel = context.channel;

    if (!channel) {
      return toolBlocked(
        'send_file 需要 channel 上下文',
        'TOOL_FORBIDDEN_FOR_SURFACE',
        'send_file requires a channel-backed surface context.',
      );
    }

    if (!file_path || typeof file_path !== 'string') {
      return toolFailure('文件路径不能为空', 'INVALID_TOOL_ARGUMENTS');
    }

    if (!file_name || typeof file_name !== 'string') {
      return toolFailure('文件名不能为空', 'INVALID_TOOL_ARGUMENTS');
    }

    try {
      const receipts = await channel.sendFile(channel.chatId, file_path, file_name);
      const externalDeliveryReceipts = normalizeExternalDeliveryReceipts(receipts, {
        receiptType: 'file',
        surface: context.surface,
        deliveryId: `${context.surface || 'surface'}.send_file`,
        fileName: file_name,
        artifactPath: file_path,
      });
      Logger.info(`[send_file] 已发送: ${file_name}`);
      return toolSuccess(`文件 "${file_name}" 已发送`, {
        ...(externalDeliveryReceipts.length ? { externalDeliveryReceipts } : {}),
      });
    } catch (err: any) {
      const errorMsg = `文件发送失败: ${err.message}`;
      Logger.error(`[send_file] ${errorMsg}`);
      const rateLimited = isRateLimitLikeMessage(errorMsg);
      return toolFailure(errorMsg, rateLimited ? 'RATE_LIMIT' : 'DELIVERY_FAILED', {
        retryable: rateLimited,
      });
    }
  }
}

function isRateLimitLikeMessage(message: string): boolean {
  return /\b429\b|rate limit|too many requests|频率受限|限流/i.test(message);
}
