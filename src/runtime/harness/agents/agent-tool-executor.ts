import {
  ArtifactManifestItem,
  DeliveryEvidence,
  ExternalDeliveryReceipt,
  Tool,
  ToolDefinition,
  ToolCall,
  ToolExecutionOutput,
  ToolResult,
  ToolExecutionContext,
  ToolExecutor,
} from '../../contracts/tool';
import { buildCanonicalToolResult, normalizeToolExecutionOutputFacts } from '../../contracts/tool-result';

const TOOL_NAME_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  shell: 'execute_shell',
  execute_bash: 'execute_shell',
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

/**
 * AgentToolExecutor - 轻量适配器
 * 将 Tool[] 包装为 ToolExecutor 接口，供 ConversationRunner 在 Agent/SubAgent 内部使用
 */
export class AgentToolExecutor implements ToolExecutor {
  constructor(
    private tools: Tool[],
    private workingDirectory: string,
    private contextDefaults: Partial<ToolExecutionContext> = {},
  ) {}

  getToolDefinitions(_contextOverrides?: Partial<ToolExecutionContext>): ToolDefinition[] {
    return this.tools.map(t => t.definition);
  }

  async executeTool(
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const requestedName = toolCall.function.name;
    const name = normalizeToolName(requestedName);
    const tool = this.tools.find(t => t.definition.name === name);

    if (!tool) {
      return buildCanonicalToolResult({
        tool_call_id: toolCall.id,
        name: requestedName,
        content: `错误：未找到工具 "${requestedName}"`,
        status: 'failure',
        errorCode: 'TOOL_NOT_FOUND',
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    try {
      const context: ToolExecutionContext = {
        workingDirectory: this.workingDirectory,
        conversationHistory: conversationHistory || [],
        ...this.contextDefaults,
        ...contextOverrides,
      };

      let args: unknown;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (error: any) {
        return buildCanonicalToolResult({
          tool_call_id: toolCall.id,
          name: requestedName,
          content: `工具参数解析错误: ${error.message}`,
          status: 'failure',
          errorCode: 'INVALID_TOOL_ARGUMENTS',
          retryable: false,
          durationMs: Date.now() - startedAt,
        });
      }

      const output = await tool.execute(args, context);
      const structuredOutput = isToolExecutionOutput(output) ? output : undefined;
      const content: string | import('../../contracts').ContentBlock[] = structuredOutput
        ? structuredOutput.toolContent
        : output as string | import('../../contracts').ContentBlock[];
      const structuredFacts = normalizeToolExecutionOutputFacts(structuredOutput);
      const status = structuredFacts.status || 'success';

      return buildCanonicalToolResult({
        tool_call_id: toolCall.id,
        name: requestedName,
        content,
        status,
        errorCode: structuredFacts.errorCode,
        blockedReason: structuredFacts.blockedReason,
        retryable: structuredFacts.retryable ?? false,
        retryCount: structuredFacts.retryCount,
        retryBudget: structuredFacts.retryBudget,
        retryBudgetExhausted: structuredFacts.retryBudgetExhausted,
        durationMs: Date.now() - startedAt,
        artifactManifest: status === 'success'
          ? buildToolOwnedArtifactManifest(tool, args, output, context)
          : [],
        ...(normalizeDeliveryEvidence(structuredOutput?.delivery_evidence).length
          ? { deliveryEvidence: normalizeDeliveryEvidence(structuredOutput?.delivery_evidence) }
          : {}),
        ...(normalizeExternalDeliveryReceipts(structuredOutput?.external_delivery_receipts).length
          ? { externalDeliveryReceipts: normalizeExternalDeliveryReceipts(structuredOutput?.external_delivery_receipts) }
          : {}),
        controlSignal: tool.definition.controlMode,
        ...(structuredOutput?.newMessages && { newMessages: structuredOutput.newMessages }),
      });
    } catch (error: any) {
      return buildCanonicalToolResult({
        tool_call_id: toolCall.id,
        name: requestedName,
        content: `工具执行错误: ${error.message}`,
        status: 'failure',
        errorCode: 'TOOL_EXECUTION_ERROR',
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

function isToolExecutionOutput(value: unknown): value is ToolExecutionOutput {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'toolContent' in value);
}

function normalizeDeliveryEvidence(value: unknown): DeliveryEvidence[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as DeliveryEvidence[] : [];
}

function normalizeExternalDeliveryReceipts(value: unknown): ExternalDeliveryReceipt[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as ExternalDeliveryReceipt[] : [];
}

function buildToolOwnedArtifactManifest(
  tool: Tool,
  args: unknown,
  output: string | import('../../contracts').ContentBlock[] | ToolExecutionOutput,
  context: ToolExecutionContext,
): ArtifactManifestItem[] {
  if (typeof tool.getArtifactManifest !== 'function') {
    return [];
  }
  try {
    return normalizeArtifactManifest(tool.getArtifactManifest(args, output, context));
  } catch {
    return [];
  }
}

function normalizeArtifactManifest(value: unknown): ArtifactManifestItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const filePath = typeof item.path === 'string' ? item.path.trim() : '';
    const type = typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'file';
    const action = isArtifactAction(item.action) ? item.action : 'captured';
    if (!filePath) return [];
    return [{
      path: filePath,
      type,
      action,
      metadata: {
        ...(isRecord(item.metadata) ? item.metadata : {}),
        source: 'tool_owned',
      },
    }];
  });
}

function isArtifactAction(value: unknown): value is ArtifactManifestItem['action'] {
  return value === 'created'
    || value === 'updated'
    || value === 'sent'
    || value === 'generated'
    || value === 'captured';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
