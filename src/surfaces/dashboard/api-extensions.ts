import { Router } from 'express';
import { registerRoleSpecificApiRoutes } from '../../capabilities/roles/runtime-role-registry';
import { ActiveRoleContext } from '../../capabilities/roles/active-role-context';

export function getDashboardActiveRole(): string | null {
  return ActiveRoleContext.getActiveRoleName() || null;
}

export function registerDashboardApiExtensions(router: Router): void {
  registerRoleSpecificApiRoutes(router);
}
