import { ContentBlock } from './';
import {
  ArtifactManifestItem,
  DeliveryEvidence,
  ExternalDeliveryReceipt,
  ToolControlMode,
  ToolExecutionOutput,
  ToolResult,
  ToolResultStatus,
} from './tool';

const TERMINAL_STATUSES = new Set<ToolResultStatus>([
  'success',
  'failure',
  'timeout',
  'cancelled',
  'blocked',
]);

export interface BuildToolResultParams {
  tool_call_id: string;
  name: string;
  content: string | ContentBlock[];
  status: ToolResultStatus;
  errorCode?: string;
  blockedReason?: string;
  retryable?: boolean;
  durationMs?: number;
  retryCount?: number;
  retryBudget?: number;
  retryBudgetExhausted?: boolean;
  artifactManifest?: ArtifactManifestItem[];
  deliveryEvidence?: DeliveryEvidence[];
  externalDeliveryReceipts?: ExternalDeliveryReceipt[];
  controlSignal?: ToolControlMode;
  newMessages?: import('./').Message[];
}

export interface CanonicalToolResultOptions {
  fallbackToolCallId?: string;
  fallbackName?: string;
  fallbackContent?: string | ContentBlock[];
  fallbackStatus?: ToolResultStatus;
  fallbackErrorCode?: string;
  fallbackBlockedReason?: string;
  startedAt?: number;
}

export interface ToolExecutionOutputFacts {
  status?: ToolResultStatus;
  errorCode?: string;
  blockedReason?: string;
  retryable?: boolean;
  retryCount?: number;
  retryBudget?: number;
  retryBudgetExhausted?: boolean;
}

export interface BuildToolExecutionOutputOptions {
  errorCode?: string;
  blockedReason?: string;
  retryable?: boolean;
  retryCount?: number;
  retryBudget?: number;
  retryBudgetExhausted?: boolean;
  deliveryEvidence?: DeliveryEvidence[];
  externalDeliveryReceipts?: ExternalDeliveryReceipt[];
  newMessages?: import('./').Message[];
}

export function buildCanonicalToolResult(params: BuildToolResultParams): ToolResult {
  return canonicalizeToolResult({
    tool_call_id: params.tool_call_id,
    role: 'tool',
    name: params.name,
    content: params.content,
    status: params.status,
    ...(params.errorCode && { error_code: params.errorCode, errorCode: params.errorCode }),
    ...(params.blockedReason && { blocked_reason: params.blockedReason }),
    ...(params.retryable !== undefined && { retryable: params.retryable }),
    ...(params.durationMs !== undefined && { duration_ms: params.durationMs }),
    ...(params.retryCount !== undefined && { retry_count: params.retryCount }),
    ...(params.retryBudget !== undefined && { retry_budget: params.retryBudget }),
    ...(params.retryBudgetExhausted !== undefined && { retry_budget_exhausted: params.retryBudgetExhausted }),
    ...(params.artifactManifest?.length ? { artifact_manifest: params.artifactManifest } : {}),
    ...(params.deliveryEvidence?.length ? { delivery_evidence: params.deliveryEvidence } : {}),
    ...(params.externalDeliveryReceipts?.length ? { external_delivery_receipts: params.externalDeliveryReceipts } : {}),
    ...(params.controlSignal && { controlSignal: params.controlSignal }),
    ...(params.newMessages && { newMessages: params.newMessages }),
  });
}

export function buildToolExecutionOutput(
  toolContent: ToolExecutionOutput['toolContent'],
  status: ToolResultStatus,
  options: BuildToolExecutionOutputOptions = {},
): ToolExecutionOutput {
  const ok = status === 'success';
  return {
    toolContent,
    status,
    ...(!ok && options.errorCode ? { error_code: options.errorCode, errorCode: options.errorCode } : {}),
    ...(status === 'blocked' && options.blockedReason ? { blocked_reason: options.blockedReason } : {}),
    ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
    ...(options.retryCount !== undefined ? { retry_count: normalizeNonNegativeInteger(options.retryCount) } : {}),
    ...(options.retryBudget !== undefined ? { retry_budget: normalizeNonNegativeInteger(options.retryBudget) } : {}),
    ...(options.retryBudgetExhausted !== undefined ? { retry_budget_exhausted: Boolean(options.retryBudgetExhausted) } : {}),
    ...(options.deliveryEvidence?.length ? { delivery_evidence: options.deliveryEvidence } : {}),
    ...(options.externalDeliveryReceipts?.length ? { external_delivery_receipts: options.externalDeliveryReceipts } : {}),
    ...(options.newMessages ? { newMessages: options.newMessages } : {}),
  };
}

export function toolSuccess(
  toolContent: ToolExecutionOutput['toolContent'],
  options: Omit<BuildToolExecutionOutputOptions, 'errorCode' | 'blockedReason'> = {},
): ToolExecutionOutput {
  return buildToolExecutionOutput(toolContent, 'success', {
    ...options,
    retryable: false,
  });
}

export function toolFailure(
  toolContent: ToolExecutionOutput['toolContent'],
  errorCode: string,
  options: Omit<BuildToolExecutionOutputOptions, 'errorCode' | 'blockedReason'> = {},
): ToolExecutionOutput {
  return buildToolExecutionOutput(toolContent, 'failure', {
    ...options,
    errorCode,
    retryable: options.retryable ?? false,
  });
}

export function toolBlocked(
  toolContent: ToolExecutionOutput['toolContent'],
  errorCode: string,
  blockedReason: string,
  options: Omit<BuildToolExecutionOutputOptions, 'errorCode' | 'blockedReason'> = {},
): ToolExecutionOutput {
  return buildToolExecutionOutput(toolContent, 'blocked', {
    ...options,
    errorCode,
    blockedReason,
    retryable: options.retryable ?? false,
  });
}

export function toolTimeout(
  toolContent: ToolExecutionOutput['toolContent'],
  options: Omit<BuildToolExecutionOutputOptions, 'errorCode' | 'blockedReason'> = {},
): ToolExecutionOutput {
  return buildToolExecutionOutput(toolContent, 'timeout', {
    ...options,
    errorCode: 'TOOL_TIMEOUT',
    retryable: options.retryable ?? true,
  });
}

export function normalizeToolExecutionOutputFacts(
  output: ToolExecutionOutput | undefined,
): ToolExecutionOutputFacts {
  if (!output) {
    return {};
  }

  const status = isToolResultStatus((output as { status?: unknown }).status)
    ? output.status
    : undefined;
  const errorCode = normalizeNonEmptyString(output.error_code || output.errorCode);
  const blockedReason = normalizeNonEmptyString(output.blocked_reason);

  return {
    ...(status && { status }),
    ...(errorCode && { errorCode }),
    ...(blockedReason && { blockedReason }),
    ...(output.retryable !== undefined && { retryable: Boolean(output.retryable) }),
    ...(output.retry_count !== undefined && { retryCount: normalizeNonNegativeInteger(output.retry_count) }),
    ...(output.retry_budget !== undefined && { retryBudget: normalizeNonNegativeInteger(output.retry_budget) }),
    ...(output.retry_budget_exhausted !== undefined && { retryBudgetExhausted: Boolean(output.retry_budget_exhausted) }),
  };
}

export function canonicalizeToolResult(
  result: ToolResult,
  options: CanonicalToolResultOptions = {},
): ToolResult {
  const {
    status: _status,
    ok: _ok,
    error_code: _errorCodeSnake,
    errorCode: _errorCodeCamel,
    blocked_reason: _blockedReason,
    duration_ms: _durationMs,
    retry_count: _retryCount,
    retry_budget: _retryBudget,
    retry_budget_exhausted: _retryBudgetExhausted,
    artifact_manifest: _artifactManifest,
    delivery_evidence: _deliveryEvidence,
    external_delivery_receipts: _externalDeliveryReceipts,
    controlSignal: _controlSignal,
    newMessages: _newMessages,
    ...rest
  } = result;
  const status = resolveStatus(result, options.fallbackStatus);
  const ok = status === 'success';
  const errorCode = ok
    ? undefined
    : result.error_code || result.errorCode || options.fallbackErrorCode || defaultErrorCodeForStatus(status);
  const blockedReason = status === 'blocked'
    ? result.blocked_reason || options.fallbackBlockedReason || contentPreview(result.content)
    : undefined;
  const durationMs = normalizeDuration(result.duration_ms, options.startedAt);

  return {
    ...rest,
    tool_call_id: result.tool_call_id || options.fallbackToolCallId || 'unknown_tool_call',
    role: 'tool',
    name: result.name || options.fallbackName || 'unknown_tool',
    content: result.content ?? options.fallbackContent ?? '',
    status,
    ok,
    duration_ms: durationMs,
    ...(errorCode && { error_code: errorCode, errorCode }),
    ...(blockedReason && { blocked_reason: blockedReason }),
    ...(result.retryable !== undefined && { retryable: result.retryable }),
    ...(result.retry_count !== undefined && { retry_count: normalizeNonNegativeInteger(result.retry_count) }),
    ...(result.retry_budget !== undefined && { retry_budget: normalizeNonNegativeInteger(result.retry_budget) }),
    ...(result.retry_budget_exhausted !== undefined && { retry_budget_exhausted: Boolean(result.retry_budget_exhausted) }),
    ...(result.artifact_manifest?.length ? { artifact_manifest: result.artifact_manifest } : {}),
    ...(result.delivery_evidence?.length ? { delivery_evidence: result.delivery_evidence } : {}),
    ...(result.external_delivery_receipts?.length ? { external_delivery_receipts: result.external_delivery_receipts } : {}),
    ...(result.controlSignal && { controlSignal: result.controlSignal }),
    ...(result.newMessages && { newMessages: result.newMessages }),
  };
}

function resolveStatus(result: ToolResult, fallback?: ToolResultStatus): ToolResultStatus {
  if (isToolResultStatus(result.status)) {
    return result.status;
  }
  if (result.ok === true) {
    return 'success';
  }
  if (result.ok === false || result.error_code || result.errorCode) {
    return fallback || 'failure';
  }
  return fallback || 'success';
}

function isToolResultStatus(value: unknown): value is ToolResultStatus {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value as ToolResultStatus);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function defaultErrorCodeForStatus(status: ToolResultStatus): string {
  switch (status) {
    case 'timeout':
      return 'TOOL_TIMEOUT';
    case 'cancelled':
      return 'TOOL_CANCELLED';
    case 'blocked':
      return 'TOOL_BLOCKED';
    case 'failure':
      return 'TOOL_EXECUTION_ERROR';
    case 'success':
      return '';
  }
}

function normalizeDuration(value: unknown, startedAt?: number): number {
  if (Number.isFinite(value) && Number(value) >= 0) {
    return Math.floor(Number(value));
  }
  if (startedAt !== undefined) {
    return Math.max(0, Date.now() - startedAt);
  }
  return 0;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function contentPreview(content: string | ContentBlock[] | undefined): string {
  if (!content) {
    return 'Tool call blocked.';
  }
  if (typeof content === 'string') {
    return content.slice(0, 500) || 'Tool call blocked.';
  }
  return content
    .map(block => block.type === 'text' ? block.text : '[non-text content]')
    .join('')
    .slice(0, 500)
    || 'Tool call blocked.';
}
