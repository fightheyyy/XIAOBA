import {
  ChannelDeliveryReceipt,
  ExternalDeliveryReceipt,
  ExternalDeliveryReceiptStatus,
  ExternalDeliveryReceiptType,
  ToolSurface,
} from '../contracts/tool';

interface ReceiptDefaults {
  receiptType: ExternalDeliveryReceiptType;
  surface?: ToolSurface;
  status?: ExternalDeliveryReceiptStatus;
  deliveryId?: string;
  fileName?: string;
  artifactPath?: string;
}

export function normalizeExternalDeliveryReceipts(
  value: ChannelDeliveryReceipt | void,
  defaults: ReceiptDefaults,
): ExternalDeliveryReceipt[] {
  const records = Array.isArray(value) ? value : value ? [value] : [];
  return records.flatMap((item, index) => normalizeExternalDeliveryReceipt(item, defaults, index));
}

function normalizeExternalDeliveryReceipt(
  item: unknown,
  defaults: ReceiptDefaults,
  index: number,
): ExternalDeliveryReceipt[] {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return [];
  }

  const record = item as Record<string, unknown>;
  const receiptType = readString(record.receipt_type)
    || readString(record.receiptType)
    || readString(record.type)
    || defaults.receiptType;
  const status = readString(record.status) || defaults.status || 'delivered';
  const timestamp = readString(record.timestamp)
    || readString(record.delivered_at)
    || readString(record.created_at)
    || new Date().toISOString();
  const platformMessageId = readString(record.platform_message_id)
    || readString(record.platformMessageId)
    || readString(record.message_id)
    || readString(record.messageId);
  const platformFileKey = readString(record.platform_file_key)
    || readString(record.platformFileKey)
    || readString(record.file_key)
    || readString(record.fileKey);
  const deliveryId = readString(record.delivery_id)
    || readString(record.deliveryId)
    || defaults.deliveryId
    || '';
  const receiptId = readString(record.receipt_id)
    || readString(record.receiptId)
    || readString(record.id)
    || receiptIdFromParts(defaults.surface, receiptType, deliveryId, platformMessageId, platformFileKey, index);

  return [{
    receipt_id: receiptId,
    receipt_type: receiptType as ExternalDeliveryReceipt['receipt_type'],
    surface: (readString(record.surface) || defaults.surface) as ExternalDeliveryReceipt['surface'],
    status: status as ExternalDeliveryReceipt['status'],
    timestamp,
    ...(platformMessageId && { platform_message_id: platformMessageId }),
    ...(platformFileKey && { platform_file_key: platformFileKey }),
    ...(deliveryId && { delivery_id: deliveryId }),
    ...(readString(record.file_name) || readString(record.fileName) || defaults.fileName
      ? { file_name: readString(record.file_name) || readString(record.fileName) || defaults.fileName }
      : {}),
    ...(readString(record.artifact_path) || readString(record.artifactPath) || readString(record.path) || defaults.artifactPath
      ? { artifact_path: readString(record.artifact_path) || readString(record.artifactPath) || readString(record.path) || defaults.artifactPath }
      : {}),
    ...(stringList(record.evidence_refs ?? record.evidenceRefs ?? record.artifacts).length
      ? { evidence_refs: stringList(record.evidence_refs ?? record.evidenceRefs ?? record.artifacts) }
      : {}),
    ...(readString(record.error_code) || readString(record.errorCode)
      ? { error_code: readString(record.error_code) || readString(record.errorCode) }
      : {}),
    ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
  }];
}

function receiptIdFromParts(
  surface: ToolSurface | undefined,
  receiptType: string,
  deliveryId: string,
  platformMessageId: string,
  platformFileKey: string,
  index: number,
): string {
  const stable = deliveryId || platformMessageId || platformFileKey || String(index + 1);
  return [surface || 'surface', receiptType || 'receipt', stable]
    .join('.')
    .replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(item => String(item || '').trim()).filter(Boolean);
}
