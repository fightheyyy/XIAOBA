import { getRoleSpecificToolsForResolvedRole } from '../roles/runtime-role-registry';
import { ToolManager } from './tool-manager';
import { ToolExecutionContext } from '../../runtime/contracts/tool';
import { RoleResolver } from '../roles/role-resolver';

export function createRoleAwareToolManager(
  workingDirectory: string = process.cwd(),
  contextDefaults: Partial<ToolExecutionContext> = {},
  roleName?: string,
): ToolManager {
  const contextRoleName = typeof contextDefaults.roleName === 'string' && contextDefaults.roleName.trim()
    ? contextDefaults.roleName.trim()
    : undefined;
  const requestedRoleName = roleName || contextRoleName || RoleResolver.getActiveRoleName();
  const normalizedRequestedRoleName = requestedRoleName
    ? RoleResolver.normalizeRoleName(requestedRoleName)
    : '';
  const isBaseRole = ['', 'base', 'default', 'none'].includes(normalizedRequestedRoleName);
  const effectiveRoleName = requestedRoleName && !isBaseRole
    ? RoleResolver.resolveRoleDirectoryName(requestedRoleName)
    : undefined;
  if (requestedRoleName && !isBaseRole && !effectiveRoleName) {
    throw new Error(`Role "${requestedRoleName}" is unavailable or blocked.`);
  }
  const roleConfig = effectiveRoleName ? RoleResolver.getRoleConfig(effectiveRoleName) : undefined;

  return new ToolManager(
    workingDirectory,
    { ...contextDefaults, roleName: effectiveRoleName || 'base' },
    getRoleSpecificToolsForResolvedRole(effectiveRoleName),
    {
      inheritBaseTools: roleConfig?.inheritBaseTools,
      baseToolAllowlist: roleConfig?.baseToolAllowlist,
      baseToolDenylist: roleConfig?.baseToolDenylist,
    },
  );
}
