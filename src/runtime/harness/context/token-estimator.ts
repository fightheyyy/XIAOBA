import { Message } from '../../contracts';
import { ToolDefinition } from '../../contracts/tool';

/**
 * Token 估算器
 *
 * 不追求精确（精确需要 tiktoken 等库，增加依赖），
 * 只需要量级正确，用于判断"是否该压缩了"。
 *
 * 估算规则：
 * - 英文/代码：~4 chars/token
 * - CJK（中日韩）：~1.25 chars/token
 * - JSON/结构化内容：~3 chars/token
 * - 最终统一乘保守系数，宁可略高估，也不要在接近上下文上限时低估
 */

/** 匹配 CJK 统一表意文字 + 常用标点 */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;

const ENGLISH_CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.25;
const JSON_CHARS_PER_TOKEN = 3;
const IMAGE_BLOCK_TOKENS = 1800;
const MESSAGE_OVERHEAD_TOKENS = 6;
const TOOL_CALL_OVERHEAD_TOKENS = 8;
const TOOL_DEFINITION_OVERHEAD_TOKENS = 16;
const TOKEN_SAFETY_MULTIPLIER = 1.25;

function applySafetyMargin(rawTokens: number): number {
  return Math.ceil(rawTokens * TOKEN_SAFETY_MULTIPLIER);
}

/**
 * 估算单段文本的 token 数
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = text.length - cjkCount;

  return Math.ceil(
    cjkCount / CJK_CHARS_PER_TOKEN + nonCjkCount / ENGLISH_CHARS_PER_TOKEN
  );
}

function estimateStructuredContent(content: unknown): number {
  try {
    const json = JSON.stringify(content ?? {});
    if (!json) return 0;
    return Math.ceil(json.length / JSON_CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

function estimateContentTokens(content: Message['content']): number {
  if (!content) return 0;
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return IMAGE_BLOCK_TOKENS;

  return content.reduce((sum, block) => {
    if (block.type === 'text') {
      return sum + estimateTokens(block.text);
    }
    if (block.type === 'image') {
      return sum + IMAGE_BLOCK_TOKENS;
    }
    return sum + estimateStructuredContent(block);
  }, 0);
}

/**
 * 估算单条消息的 token 数（含 role、content、tool_calls）
 */
export function estimateMessageTokens(message: Message): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  tokens += estimateContentTokens(message.content);

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      tokens += estimateTokens(tc.function.name);
      tokens += estimateStructuredContent(tc.function.arguments);
      tokens += TOOL_CALL_OVERHEAD_TOKENS;
    }
  }

  if (message.name) {
    tokens += estimateTokens(message.name);
  }

  return tokens;
}

/**
 * 估算整个消息数组的 token 数
 */
export function estimateMessagesTokens(messages: Message[]): number {
  const raw = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  return applySafetyMargin(raw);
}

/**
 * 估算 JSON 结构的 token 数
 */
export function estimateJsonTokens(value: unknown): number {
  return applySafetyMargin(estimateStructuredContent(value));
}

/**
 * 估算单个工具定义的 token 数
 */
export function estimateToolTokens(tool: ToolDefinition): number {
  const nameTokens = estimateTokens(tool.name || '');
  const descriptionTokens = estimateTokens(tool.description || '');
  const schemaTokens = estimateStructuredContent(tool.parameters);

  const raw = nameTokens + descriptionTokens + schemaTokens + TOOL_DEFINITION_OVERHEAD_TOKENS;
  return applySafetyMargin(raw);
}

/**
 * 估算所有工具定义的 token 数
 */
export function estimateToolsTokens(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
}
