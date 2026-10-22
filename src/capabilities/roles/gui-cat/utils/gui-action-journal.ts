import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { hashOwner } from './desktop-lease';

export type GuiActionState = 'planned' | 'applied' | 'failed' | 'uncertain' | 'verified';

export interface GuiActionJournalEntry {
  schema_version: 1;
  action_id: string;
  timestamp: string;
  owner_hash: string;
  state: GuiActionState;
  action: string;
  target?: Record<string, unknown>;
  input?: {
    length: number;
    sha256: string;
  };
  snapshot_id?: string;
  risk?: string;
  driver_code?: string;
  detail?: string;
}

export interface GuiActionJournalOptions {
  now?: () => number;
}

/** Append-only, content-minimized evidence for GUI mutations. */
export class GuiActionJournal {
  private readonly now: () => number;

  constructor(
    private readonly workingDirectory: string,
    options: GuiActionJournalOptions = {},
  ) {
    this.now = options.now || Date.now;
  }

  start(input: {
    owner: string;
    action: string;
    target?: Record<string, unknown>;
    text?: string;
    snapshotId?: string;
    risk?: string;
  }): string {
    const actionId = crypto.randomUUID();
    this.append({
      schema_version: 1,
      action_id: actionId,
      timestamp: new Date(this.now()).toISOString(),
      owner_hash: hashOwner(input.owner),
      state: 'planned',
      action: input.action,
      ...(input.target && { target: sanitizeRecord(input.target) }),
      ...(typeof input.text === 'string' && { input: summarizeText(input.text) }),
      ...(input.snapshotId && { snapshot_id: input.snapshotId }),
      ...(input.risk && { risk: input.risk }),
    });
    return actionId;
  }

  finish(input: {
    owner: string;
    actionId: string;
    action: string;
    state: Exclude<GuiActionState, 'planned'>;
    driverCode?: string;
    detail?: string;
  }): void {
    this.append({
      schema_version: 1,
      action_id: input.actionId,
      timestamp: new Date(this.now()).toISOString(),
      owner_hash: hashOwner(input.owner),
      state: input.state,
      action: input.action,
      ...(input.driverCode && { driver_code: input.driverCode }),
      ...(input.detail && { detail: input.detail.slice(0, 500) }),
    });
  }

  getPath(owner: string): string {
    return this.getPathForOwnerHash(hashOwner(owner));
  }

  private append(entry: GuiActionJournalEntry): void {
    const filePath = this.getPathForOwnerHash(entry.owner_hash);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private getPathForOwnerHash(ownerHash: string): string {
    return path.join(
      this.workingDirectory,
      'data',
      'gui-cat',
      'journal',
      `${ownerHash.replace(':', '_')}.jsonl`,
    );
  }
}

function summarizeText(text: string): { length: number; sha256: string } {
  return {
    length: text.length,
    sha256: `sha256:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`,
  };
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|passcode|otp|secret|token|text|value/i.test(key)) continue;
    if (typeof item === 'string') result[key] = item.slice(0, 240);
    else if (typeof item === 'number' || typeof item === 'boolean' || item === null) result[key] = item;
  }
  return result;
}
