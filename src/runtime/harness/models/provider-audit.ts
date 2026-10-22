import type { AuditedProviderCallInput, ProviderAudit } from '../../contracts/provider-audit';

let audit: ProviderAudit | undefined;

/** Installed by the execution adapter before it creates model services. */
export function setProviderAudit(value: ProviderAudit | undefined): void {
  audit = value;
}

export function providerAuditEnabled(): boolean {
  return audit?.enabled() ?? false;
}

export function auditedProviderConfig() {
  return audit?.providerConfig();
}

export function runAuditedProviderCall(input: AuditedProviderCallInput) {
  return audit ? audit.invoke(input) : input.invoke();
}
