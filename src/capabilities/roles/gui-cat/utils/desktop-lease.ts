import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_TTL_MS = 45_000;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

interface LeaseRecord {
  schema_version: 1;
  lease_id: string;
  owner_hash: string;
  pid: number;
  acquired_at: string;
  expires_at: string;
}

export interface DesktopLeaseOptions {
  rootDir?: string;
  ttlMs?: number;
  now?: () => number;
  pid?: number;
}

export interface DesktopLeaseResult {
  acquired: boolean;
  leaseId?: string;
  ownerHash: string;
  expiresAt?: string;
  busyOwnerHash?: string;
  reason?: string;
}

/** Atomic mkdir-backed lease shared by XiaoBa processes for the physical desktop. */
export class DesktopLease {
  private readonly lockDir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly pid: number;

  constructor(options: DesktopLeaseOptions = {}) {
    const xiaobaHome = process.env.XIAOBA_HOME || path.join(os.homedir(), '.xiaoba');
    this.lockDir = path.join(options.rootDir || path.join(xiaobaHome, 'gui-cat'), 'desktop.lock');
    this.ttlMs = Math.max(5_000, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now || Date.now;
    this.pid = options.pid ?? process.pid;
  }

  acquire(owner: string): DesktopLeaseResult {
    const ownerHash = hashOwner(owner);
    fs.mkdirSync(path.dirname(this.lockDir), { recursive: true });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.mkdirSync(this.lockDir);
        const record = this.newRecord(ownerHash);
        this.writeRecord(record);
        return {
          acquired: true,
          leaseId: record.lease_id,
          ownerHash,
          expiresAt: record.expires_at,
        };
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
      }

      const existing = this.readRecord();
      if (existing?.owner_hash === ownerHash && !this.isExpired(existing)) {
        const refreshed: LeaseRecord = {
          ...existing,
          pid: this.pid,
          expires_at: new Date(this.now() + this.ttlMs).toISOString(),
        };
        this.writeRecord(refreshed);
        return {
          acquired: true,
          leaseId: refreshed.lease_id,
          ownerHash,
          expiresAt: refreshed.expires_at,
        };
      }

      if (existing ? this.isExpired(existing) : this.isIncompleteLockStale()) {
        if (this.moveStaleLeaseAside(existing)) continue;
      }

      return {
        acquired: false,
        ownerHash,
        busyOwnerHash: existing?.owner_hash,
        expiresAt: existing?.expires_at,
        reason: 'The physical desktop is controlled by another GuiCat session.',
      };
    }

    return {
      acquired: false,
      ownerHash,
      reason: 'The desktop lease could not be acquired after stale-lease recovery.',
    };
  }

  release(owner: string): boolean {
    const existing = this.readRecord();
    if (!existing || existing.owner_hash !== hashOwner(owner)) return false;
    const releasePath = `${this.lockDir}.release.${this.pid}.${crypto.randomUUID()}`;
    try {
      fs.renameSync(this.lockDir, releasePath);
      const moved = this.readRecordAt(releasePath);
      if (!sameLease(existing, moved)) {
        this.restoreMovedLease(releasePath);
        return false;
      }
      fs.rmSync(releasePath, { recursive: true, force: true });
      return true;
    } catch {
      this.restoreMovedLease(releasePath);
      return false;
    }
  }

  inspect(): LeaseRecord | undefined {
    const record = this.readRecord();
    if (!record || this.isExpired(record)) return undefined;
    return record;
  }

  private newRecord(ownerHash: string): LeaseRecord {
    const now = this.now();
    return {
      schema_version: 1,
      lease_id: crypto.randomUUID(),
      owner_hash: ownerHash,
      pid: this.pid,
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
    };
  }

  private isExpired(record: LeaseRecord): boolean {
    const expiresAt = Date.parse(record.expires_at);
    return !Number.isFinite(expiresAt) || expiresAt <= this.now();
  }

  private readRecord(): LeaseRecord | undefined {
    return this.readRecordAt(this.lockDir);
  }

  private readRecordAt(directory: string): LeaseRecord | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, 'lease.json'), 'utf8')) as LeaseRecord;
      if (value?.schema_version !== 1 || !value.lease_id || !value.owner_hash || !value.expires_at) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private writeRecord(record: LeaseRecord): void {
    const temporary = path.join(this.lockDir, `.lease.${this.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, path.join(this.lockDir, 'lease.json'));
  }

  private isIncompleteLockStale(): boolean {
    try {
      return this.now() - fs.statSync(this.lockDir).mtimeMs >= INCOMPLETE_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }

  private moveStaleLeaseAside(expected: LeaseRecord | undefined): boolean {
    const stalePath = `${this.lockDir}.stale.${this.pid}.${crypto.randomUUID()}`;
    try {
      fs.renameSync(this.lockDir, stalePath);
      const moved = this.readRecordAt(stalePath);
      const matchesExpected = expected
        ? sameLease(expected, moved)
        : !moved && this.isDirectoryOlderThan(stalePath, INCOMPLETE_LOCK_GRACE_MS);
      if (!matchesExpected) {
        this.restoreMovedLease(stalePath);
        return false;
      }
      fs.rmSync(stalePath, { recursive: true, force: true });
      return true;
    } catch {
      this.restoreMovedLease(stalePath);
      return false;
    }
  }

  private isDirectoryOlderThan(directory: string, ageMs: number): boolean {
    try {
      return this.now() - fs.statSync(directory).mtimeMs >= ageMs;
    } catch {
      return false;
    }
  }

  private restoreMovedLease(movedPath: string): void {
    if (!fs.existsSync(movedPath) || fs.existsSync(this.lockDir)) return;
    try {
      fs.renameSync(movedPath, this.lockDir);
    } catch {
      // Fail closed: never delete a moved lease whose identity we could not prove.
    }
  }
}

function sameLease(expected: LeaseRecord, actual: LeaseRecord | undefined): boolean {
  return Boolean(
    actual
    && actual.lease_id === expected.lease_id
    && actual.owner_hash === expected.owner_hash
    && actual.acquired_at === expected.acquired_at
    && actual.expires_at === expected.expires_at,
  );
}

export function hashOwner(owner: string): string {
  return `sha256:${crypto.createHash('sha256').update(owner || 'unknown').digest('hex').slice(0, 16)}`;
}
