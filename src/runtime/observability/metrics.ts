import { TokenUsage } from '../contracts';

/** 单次 AI 调用记录 */
interface AICallRecord {
  model: string;
  usage?: TokenUsage;
  timestamp: number;
}

/** 单次工具调用记录 */
interface ToolCallRecord {
  name: string;
  durationMs: number;
  timestamp: number;
}

/** 一次执行的汇总 */
export interface MetricsSummary {
  aiCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolDurationMs: number;
  /** 按工具名分组的调用次数和总耗时 */
  toolBreakdown: Record<string, { count: number; totalMs: number }>;
}

/**
 * Metrics - 由执行方持有的轻量计数器
 *
 * 三层数据：Provider 层（token）→ 工具层（耗时）→ 会话层（汇总）
 */
export class Metrics {
  private aiCalls: AICallRecord[] = [];
  private toolCalls: ToolCallRecord[] = [];

  /** 记录一次 AI 调用 */
  recordAICall(model: string, usage?: TokenUsage): void {
    this.aiCalls.push({ model, usage: usage && { ...usage }, timestamp: Date.now() });
  }

  /** 记录一次工具执行 */
  recordToolCall(name: string, durationMs: number): void {
    this.toolCalls.push({ name, durationMs, timestamp: Date.now() });
  }

  /** 获取当前执行汇总 */
  getSummary(): MetricsSummary {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;

    for (const call of this.aiCalls) {
      totalPromptTokens += (call.usage?.promptTokens ?? 0);
      totalCompletionTokens += (call.usage?.completionTokens ?? 0);
      totalTokens += (call.usage?.totalTokens ?? 0);
    }

    let toolDurationMs = 0;
    const toolBreakdown: Record<string, { count: number; totalMs: number }> = {};

    for (const call of this.toolCalls) {
      toolDurationMs += call.durationMs;
      if (!Object.prototype.hasOwnProperty.call(toolBreakdown, call.name)) {
        Object.defineProperty(toolBreakdown, call.name, { value: { count: 0, totalMs: 0 }, enumerable: true });
      }
      toolBreakdown[call.name].count++;
      toolBreakdown[call.name].totalMs += call.durationMs;
    }

    return {
      aiCalls: this.aiCalls.length,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      toolCalls: this.toolCalls.length,
      toolDurationMs,
      toolBreakdown,
    };
  }

  /** 开始下一次请求前重置 */
  reset(): void {
    this.aiCalls = [];
    this.toolCalls = [];
  }
}
