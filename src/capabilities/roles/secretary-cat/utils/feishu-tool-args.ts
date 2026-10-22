import { SecretaryToolError, optionalString } from './lark-cli-runner';

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function pushOptionalString(command: string[], flag: string, value: unknown): void {
  const text = optionalString(value);
  if (text) {
    command.push(flag, text);
  }
}

export function pushOptionalBooleanFlag(command: string[], flag: string, value: unknown): void {
  if (value === true) {
    command.push(flag);
  } else if (value === false) {
    command.push(`${flag}=false`);
  }
}

export function parseJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new SecretaryToolError('VALIDATION_ERROR', `${field} must be valid JSON object text.`);
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new SecretaryToolError('VALIDATION_ERROR', `${field} must be a JSON object.`);
}

export function parseJsonArray(value: unknown, field: string): unknown[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      throw new SecretaryToolError('VALIDATION_ERROR', `${field} must be valid JSON array text.`);
    }
  }

  if (Array.isArray(value)) {
    return value;
  }

  throw new SecretaryToolError('VALIDATION_ERROR', `${field} must be a JSON array.`);
}

export function parseJsonArrayString(value: unknown, field: string): string {
  return JSON.stringify(parseJsonArray(value, field));
}

export function parseJsonObjectString(value: unknown, field: string): string {
  return JSON.stringify(parseJsonObject(value, field));
}

export function parseOptionalJsonObjectString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return parseJsonObjectString(value, field);
}

export function pushRepeatedStringList(command: string[], flag: string, value: unknown): void {
  const items = normalizeStringList(value);
  for (const item of items) {
    command.push(flag, item);
  }
}

export function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean);
  }

  const text = optionalString(value);
  if (!text) {
    return [];
  }

  return text.split(',').map(item => item.trim()).filter(Boolean);
}
