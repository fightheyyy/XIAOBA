import { RoleRuntimeSupport, startRoleRuntimeServices } from '../../capabilities/roles/runtime-role-registry';

interface ActiveCommandSupport {
  roleSupport: RoleRuntimeSupport | null;
  stop(): Promise<void>;
}

let activeSupport: ActiveCommandSupport | null = null;
let startPromise: Promise<ActiveCommandSupport> | null = null;
let activeRoleSupport: RoleRuntimeSupport | null = null;

export async function startCommandSupport(): Promise<ActiveCommandSupport> {
  if (activeSupport) {
    return activeSupport;
  }

  if (!startPromise) {
    startPromise = (async () => {
      const roleSupport = await startRoleRuntimeServices({ workingDirectory: process.cwd() });
      activeRoleSupport = roleSupport;
      try {
        const support: ActiveCommandSupport = {
          roleSupport,
          async stop() {
            if (roleSupport) {
              await roleSupport.stop();
            }
          },
        };

        activeSupport = support;
        return support;
      } catch (error) {
        if (roleSupport) {
          await roleSupport.stop().catch(() => undefined);
        }
        activeRoleSupport = null;
        throw error;
      }
    })()
      .finally(() => {
        startPromise = null;
      });
  }

  return startPromise;
}

export async function stopCommandSupport(): Promise<void> {
  const support = activeSupport;
  activeSupport = null;
  if (support) {
    activeRoleSupport = null;
    await support.stop();
    return;
  }

  if (activeRoleSupport) {
    await activeRoleSupport.stop().catch(() => undefined);
    activeRoleSupport = null;
  }
}
