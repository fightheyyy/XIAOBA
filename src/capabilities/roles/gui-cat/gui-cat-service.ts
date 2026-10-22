import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ContentBlock } from '../../../runtime/contracts';
import { ToolExecutionContext, ToolExecutionOutput } from '../../../runtime/contracts/tool';
import {
  buildToolExecutionOutput,
  toolBlocked,
  toolFailure,
  toolSuccess,
} from '../../../runtime/contracts/tool-result';
import { DesktopLease, hashOwner } from './utils/desktop-lease';
import { GuiActionJournal } from './utils/gui-action-journal';
import {
  classifyDescription,
  classifyElementAction,
  GuiElementSnapshot,
  isHighRiskSubagentContext,
  isSecureElement,
  isTerminalApplication,
  validateGuiInput,
} from './utils/gui-policy';
import {
  DefaultPeekabooRunner,
  PeekabooDriverStatus,
  PeekabooRunner,
  PeekabooRunnerError,
} from './utils/peekaboo-runner';

const DEFAULT_SNAPSHOT_TTL_MS = 60_000;
const MAX_UI_ELEMENTS = 250;
const MAX_MODEL_UI_ELEMENTS = 120;
const MAX_CLICK_SEQUENCE = 20;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const SAFE_KEYS = new Set(['tab', 'escape', 'up', 'down', 'left', 'right', 'space']);

interface CachedSnapshot {
  snapshotId: string;
  ownerHash: string;
  createdAt: number;
  actionable: boolean;
  app?: string;
  target: GuiTarget;
  elements: Map<string, GuiElementSnapshot>;
}

interface GuiTarget {
  app?: string;
  pid?: number;
  window_id?: number;
  window_title?: string;
}

interface MutationCommand {
  argv: string[];
  timeoutMs?: number;
}

export interface GuiCatServiceOptions {
  runner?: PeekabooRunner;
  lease?: DesktopLease;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  snapshotTtlMs?: number;
  journalFactory?: (workingDirectory: string) => GuiActionJournal;
}

class GuiCatPolicyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly blocked = true,
  ) {
    super(message);
    this.name = 'GuiCatPolicyError';
  }
}

export class GuiCatService {
  private readonly runner: PeekabooRunner;
  private readonly lease: DesktopLease;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly snapshotTtlMs: number;
  private readonly journalFactory: (workingDirectory: string) => GuiActionJournal;
  private readonly snapshots = new Map<string, CachedSnapshot>();

  constructor(options: GuiCatServiceOptions = {}) {
    this.runner = options.runner || new DefaultPeekabooRunner({ environment: options.environment });
    this.lease = options.lease || new DesktopLease();
    this.environment = options.environment || process.env;
    this.now = options.now || Date.now;
    this.snapshotTtlMs = Math.max(1_000, options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS);
    this.journalFactory = options.journalFactory || (cwd => new GuiActionJournal(cwd));
  }

  async driverStatus(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      const status = await this.runner.status({
        refresh: args?.refresh === true,
        abortSignal: context.abortSignal,
      });
      return toolSuccess(toJson({
        ok: true,
        trust: 'untrusted_driver_diagnostics',
        driver: 'peekaboo',
        required_version: '3.8.x',
        status: publicDriverStatus(status),
        lease: publicLeaseSummary(this.lease.inspect()),
      }));
    } catch (error) {
      return this.errorOutput(error, false);
    }
  }

  async observe(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      const kind = enumValue(args?.kind, ['see', 'apps', 'windows', 'screens', 'dialogs'], 'see');
      const includeScreenshot = kind === 'see' && args?.include_screenshot === true;
      await this.requireDriver(context, {
        screenRecording: kind === 'see',
        accessibility: kind === 'see' || kind === 'dialogs',
      });

      const claimedControl = args?.claim_control !== false;
      if (claimedControl) this.requireLease(context);

      let artifactPath: string | undefined;
      let argv: string[];
      if (kind === 'see') {
        artifactPath = includeScreenshot ? this.createCapturePath(context, 'observe') : undefined;
        argv = ['see'];
        appendTargetArgs(argv, args);
        const target = guiTarget(args);
        const requestedMode = optionalEnum(args?.mode, ['screen', 'window', 'frontmost', 'multi']);
        const mode = hasGuiTarget(target)
          ? 'window'
          : (requestedMode || 'frontmost');
        argv.push('--mode', mode);
        if (artifactPath) argv.push('--path', artifactPath);
        argv.push('--json');
      } else if (kind === 'dialogs') {
        argv = ['dialog', 'list'];
        appendTargetArgs(argv, args);
        argv.push('--json');
      } else {
        argv = ['list', kind];
        if (kind === 'windows') appendInventoryTargetArgs(argv, args);
        argv.push('--json');
      }

      const command = kind === 'see'
        ? await this.runReadOnlyWithBridgeRetry(argv, context, 3)
        : await this.runner.run(argv, {
          timeoutMs: 12_000,
          abortSignal: context.abortSignal,
        });
      const owner = ownerKey(context);
      const payload: Record<string, unknown> = {
        ok: true,
        trust: 'untrusted_desktop_content',
        kind,
      };

      if (kind === 'see') {
        const snapshotId = findString(command.data, ['snapshot_id', 'snapshotId']);
        if (!snapshotId) {
          throw new GuiCatPolicyError('Peekaboo observation did not return a snapshot id.', 'GUI_SNAPSHOT_MISSING', false);
        }
        const requestedApp = optionalCliValue(args?.app, 'app', 240);
        const observedApp = optionalCliValue(
          findString(command.data, ['app', 'application_name', 'target_app']),
          'observed app',
          240,
        );
        const target = guiTarget(args);
        const elements = normalizeElements(command.data, observedApp || requestedApp);
        const modelElements = compactElementsForModel(elements);
        this.snapshots.set(snapshotId, {
          snapshotId,
          ownerHash: hashOwner(owner),
          createdAt: this.now(),
          actionable: claimedControl,
          app: observedApp || requestedApp,
          target: {
            ...target,
            ...(observedApp ? { app: observedApp } : {}),
          },
          elements: new Map(elements.map(element => [element.id, element])),
        });
        payload.snapshot_id = snapshotId;
        payload.snapshot_actionable = claimedControl;
        payload.element_count = elements.length;
        payload.returned_element_count = modelElements.length;
        payload.observed_target = removeUndefined({
          app: observedApp,
          window_title: findString(command.data, ['window_title', 'windowTitle']),
          mode: hasGuiTarget(target) ? 'window' : (optionalEnum(args?.mode, ['screen', 'window', 'frontmost', 'multi']) || 'frontmost'),
        });
        payload.elements = modelElements;
      } else {
        payload.data = sanitizeValue(command.data);
      }

      if (artifactPath && isSafeImageFile(artifactPath)) payload.artifact_path = artifactPath;
      return successWithOptionalImage(payload, artifactPath);
    } catch (error) {
      return this.errorOutput(error, false);
    }
  }

  async capture(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      await this.requireDriver(context, { screenRecording: true });
      const artifactPath = this.createCapturePath(context, 'capture');
      const argv = ['image'];
      const target = guiTarget(args);
      const requestedMode = enumValue(args?.mode, ['screen', 'window', 'frontmost'], 'screen');
      const mode = hasGuiTarget(target) ? 'window' : requestedMode;
      argv.push('--mode', mode);
      appendTargetArgs(argv, args);
      argv.push('--path', artifactPath, '--json');
      await this.runner.run(argv, { timeoutMs: 25_000, abortSignal: context.abortSignal });
      if (!isSafeImageFile(artifactPath)) {
        throw new GuiCatPolicyError('Peekaboo did not create the expected screenshot artifact.', 'GUI_CAPTURE_MISSING', false);
      }
      return successWithOptionalImage({
        ok: true,
        trust: 'untrusted_desktop_content',
        artifact_path: artifactPath,
        mode,
      }, artifactPath);
    } catch (error) {
      return this.errorOutput(error, false);
    }
  }

  async click(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      await this.requireDriver(context, { accessibility: true });
      const snapshot = this.requireSnapshot(args, context);
      const element = this.requireElement(snapshot, args?.element_id);
      const decision = classifyElementAction(element);
      if (decision.risk === 'forbidden') {
        throw new GuiCatPolicyError(decision.reason || 'GUI target is forbidden.', 'GUI_ACTION_FORBIDDEN');
      }
      if (decision.risk === 'confirmation_required') {
        throw new GuiCatPolicyError(
          decision.reason || 'This click requires explicit confirmation.',
          'GUI_CONFIRMATION_REQUIRED',
        );
      }

      const argv = ['click', '--on', element.id, '--snapshot', snapshot.snapshotId];
      if (snapshot.app) argv.push('--app', snapshot.app);
      if (args?.delivery_mode === 'foreground') argv.push('--foreground');
      argv.push('--json');
      return await this.runMutation({
        context,
        action: 'click',
        risk: 'safe',
        snapshot,
        target: summarizeElement(element),
        commands: [{ argv }],
      });
    } catch (error) {
      return this.errorOutput(error, true);
    }
  }

  async clickSequence(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      await this.requireDriver(context, { accessibility: true });
      const snapshot = this.requireSnapshot(args, context);
      const rawIds: unknown[] = Array.isArray(args?.element_ids) ? args.element_ids : [];
      if (rawIds.length < 2 || rawIds.length > MAX_CLICK_SEQUENCE) {
        throw new GuiCatPolicyError(
          `element_ids must contain between 2 and ${MAX_CLICK_SEQUENCE} elements.`,
          'GUI_INVALID_ARGUMENTS',
        );
      }
      const elements = rawIds.map(id => this.requireElement(snapshot, id));
      for (const element of elements) {
        const decision = classifyElementAction(element);
        if (decision.risk === 'forbidden') {
          throw new GuiCatPolicyError(decision.reason || 'GUI sequence target is forbidden.', 'GUI_ACTION_FORBIDDEN');
        }
        if (decision.risk === 'confirmation_required') {
          throw new GuiCatPolicyError(
            decision.reason || 'A GUI sequence target requires explicit confirmation.',
            'GUI_CONFIRMATION_REQUIRED',
          );
        }
      }

      const deliveryMode = enumValue(args?.delivery_mode, ['background', 'foreground'], 'background');
      const commands = elements.map(element => {
        const argv = ['click', '--on', element.id, '--snapshot', snapshot.snapshotId];
        if (snapshot.app) argv.push('--app', snapshot.app);
        if (deliveryMode === 'foreground') argv.push('--foreground');
        argv.push('--json');
        return { argv };
      });
      const mutation = await this.runMutation({
        context,
        action: 'click_sequence',
        risk: 'safe',
        snapshot,
        target: {
          app: snapshot.app,
          click_count: elements.length,
          elements: elements.map(element => summarizeElement(element)),
        },
        commands,
        response: { click_count: elements.length },
      });
      if (mutation.status !== 'success') return mutation;

      const observed = await this.observe({
        kind: 'see',
        ...snapshot.target,
        mode: hasGuiTarget(snapshot.target) ? 'window' : 'frontmost',
        include_screenshot: false,
        claim_control: true,
      }, context);
      if (observed.status !== 'success') {
        return toolFailure(toJson({
          ok: false,
          error: {
            code: 'GUI_SEQUENCE_RESULT_UNVERIFIED',
            message: 'The click sequence was applied, but the target window could not be re-observed.',
          },
          mutation: parseToolJson(mutation),
          observe: parseToolJson(observed),
        }), 'GUI_SEQUENCE_RESULT_UNVERIFIED');
      }
      return toolSuccess(toJson({
        ok: true,
        action: 'click_sequence',
        state: 'applied_and_observed',
        click_count: elements.length,
        mutation: parseToolJson(mutation),
        result_snapshot: parseToolJson(observed),
      }));
    } catch (error) {
      return this.errorOutput(error, true);
    }
  }

  async input(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      const mode = enumValue(args?.mode, ['set_value', 'type'], 'set_value');
      const deliveryMode = enumValue(args?.delivery_mode, ['background', 'foreground'], 'background');
      await this.requireDriver(context, {
        accessibility: true,
        eventSynthesizing: mode === 'type' && deliveryMode === 'background',
      });
      const snapshot = this.requireSnapshot(args, context);
      const element = this.requireElement(snapshot, args?.element_id);
      const text = requiredInputText(args?.text, 'text', 10_000);
      const decision = validateGuiInput(element, text, stringValue(args?.app) || snapshot.app);
      if (decision.risk !== 'safe') {
        throw new GuiCatPolicyError(decision.reason || 'GUI input is forbidden.', 'GUI_INPUT_FORBIDDEN');
      }

      const commands: MutationCommand[] = [];
      if (mode === 'set_value') {
        commands.push({
          argv: ['set-value', '--on', element.id, '--snapshot', snapshot.snapshotId, '--value', text, '--json'],
        });
      } else {
        const clickArgv = ['click', '--on', element.id, '--snapshot', snapshot.snapshotId];
        if (snapshot.app) clickArgv.push('--app', snapshot.app);
        if (deliveryMode === 'foreground') clickArgv.push('--foreground');
        clickArgv.push('--json');
        commands.push({ argv: clickArgv });

        const typeArgv = ['type', '--snapshot', snapshot.snapshotId];
        if (snapshot.app) typeArgv.push('--app', snapshot.app);
        if (args?.clear === true) typeArgv.push('--clear');
        if (deliveryMode === 'foreground') typeArgv.push('--foreground');
        typeArgv.push('--text', text, '--json');
        commands.push({ argv: typeArgv, timeoutMs: 20_000 });
      }

      return await this.runMutation({
        context,
        action: `input.${mode}`,
        risk: 'safe',
        snapshot,
        target: summarizeElement(element),
        text,
        commands,
        response: {
          mode,
          text_length: text.length,
          text_sha256: shortHash(text),
        },
      });
    } catch (error) {
      return this.errorOutput(error, true);
    }
  }

  async manage(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      const action = requiredEnum(args?.action, [
        'app_launch', 'app_switch', 'window_focus', 'window_move', 'window_resize',
        'window_minimize', 'window_maximize', 'scroll', 'press_key',
      ], 'action');
      await this.requireDriver(context, {
        accessibility: true,
        eventSynthesizing: action === 'press_key' && args?.delivery_mode !== 'foreground',
      });

      const app = stringValue(args?.app);
      if (isTerminalApplication(app)) {
        throw new GuiCatPolicyError('GuiCat does not control terminal applications.', 'GUI_TERMINAL_FORBIDDEN');
      }

      const argv = buildManageArgv(action, args);
      return await this.runMutation({
        context,
        action: `manage.${action}`,
        risk: 'safe',
        target: compactTarget(args),
        commands: [{ argv }],
      });
    } catch (error) {
      return this.errorOutput(error, true);
    }
  }

  async confirmedAction(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      this.assertOutsideArena();
      if (isHighRiskSubagentContext(context)) {
        throw new GuiCatPolicyError(
          'Consequential GUI actions are blocked in subagents until a trusted parent-user confirmation token exists.',
          'GUI_SUBAGENT_CONFIRMATION_UNTRUSTED',
        );
      }
      if (args?.confirmed !== true) {
        throw new GuiCatPolicyError('The confirmed action requires confirmed=true.', 'GUI_CONFIRMATION_REQUIRED');
      }
      const action = requiredEnum(args?.action, [
        'click', 'press_return', 'dialog_click', 'dialog_file', 'menu_click', 'window_close', 'app_quit',
      ], 'action');
      const description = requiredString(args?.target_description, 'target_description', 500);
      const descriptionRisk = classifyDescription(description);
      if (descriptionRisk.risk === 'forbidden') {
        throw new GuiCatPolicyError(descriptionRisk.reason || 'This action is outside GuiCat v1.', 'GUI_ACTION_FORBIDDEN');
      }
      if (isTerminalApplication(stringValue(args?.app))) {
        throw new GuiCatPolicyError('GuiCat does not control terminal applications.', 'GUI_TERMINAL_FORBIDDEN');
      }

      const needsEvent = action === 'press_return';
      await this.requireDriver(context, { accessibility: true, eventSynthesizing: needsEvent });
      const built = this.buildConfirmedAction(action, args, context);
      return await this.runMutation({
        context,
        action: `confirmed.${action}`,
        risk: 'confirmation_required',
        snapshot: built.snapshot,
        target: { ...built.target, target_description: description },
        commands: [{ argv: built.argv }],
      });
    } catch (error) {
      return this.errorOutput(error, true);
    }
  }

  async releaseControl(_args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    try {
      const owner = ownerKey(context);
      const released = this.lease.release(owner);
      if (released) {
        const ownerHash = hashOwner(owner);
        for (const [snapshotId, snapshot] of this.snapshots) {
          if (snapshot.ownerHash === ownerHash) this.snapshots.delete(snapshotId);
        }
      }
      return toolSuccess(toJson({
        ok: true,
        released,
        owner_hash: hashOwner(owner),
      }));
    } catch (error) {
      return this.errorOutput(error, false);
    }
  }

  private async runReadOnlyWithBridgeRetry(
    argv: string[],
    context: ToolExecutionContext,
    maxAttempts: number,
  ): Promise<Awaited<ReturnType<PeekabooRunner['run']>>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runner.run(argv, {
          timeoutMs: 30_000,
          abortSignal: context.abortSignal,
        });
      } catch (error) {
        lastError = error;
        if (!isBridgeTransient(error) || attempt === maxAttempts) throw error;
        await new Promise(resolve => setTimeout(resolve, 150 * attempt));
      }
    }
    throw lastError;
  }

  private buildConfirmedAction(
    action: string,
    args: any,
    context: ToolExecutionContext,
  ): { argv: string[]; snapshot?: CachedSnapshot; target: Record<string, unknown> } {
    if (action === 'click') {
      const snapshot = this.requireSnapshot(args, context);
      const element = this.requireElement(snapshot, args?.element_id);
      const decision = classifyElementAction(element);
      if (decision.risk === 'forbidden') {
        throw new GuiCatPolicyError(decision.reason || 'GUI target is forbidden.', 'GUI_ACTION_FORBIDDEN');
      }
      const argv = ['click', '--on', element.id, '--snapshot', snapshot.snapshotId];
      if (snapshot.app) argv.push('--app', snapshot.app);
      if (args?.delivery_mode === 'foreground') argv.push('--foreground');
      argv.push('--json');
      return { argv, snapshot, target: summarizeElement(element) };
    }

    if (action === 'press_return') {
      const snapshot = this.requireSnapshot(args, context);
      const argv = ['press', 'return', '--count', '1', '--snapshot', snapshot.snapshotId];
      if (snapshot.app) argv.push('--app', snapshot.app);
      if (args?.delivery_mode === 'foreground') argv.push('--foreground');
      argv.push('--json');
      return { argv, snapshot, target: { app: snapshot.app, key: 'return' } };
    }

    if (action === 'dialog_click') {
      const button = requiredCliValue(args?.button || args?.target_description, 'button', 240);
      const argv = ['dialog', 'click', '--button', button];
      appendTargetArgs(argv, args);
      argv.push('--json');
      return { argv, target: { app: stringValue(args?.app), button } };
    }

    if (action === 'dialog_file') {
      const argv = ['dialog', 'file'];
      const filePath = optionalCliValue(args?.path, 'path', 2_000);
      const name = optionalCliValue(args?.name, 'name', 500);
      if (!filePath && !name) throw new GuiCatPolicyError('dialog_file requires path or name.', 'GUI_INVALID_ARGUMENTS');
      if (filePath) argv.push('--path', filePath);
      if (name) argv.push('--name', name);
      const select = optionalCliValue(args?.select, 'select', 240);
      if (select) argv.push('--select', select);
      appendTargetArgs(argv, args);
      argv.push('--json');
      return { argv, target: { app: stringValue(args?.app), path: filePath, name, select } };
    }

    if (action === 'menu_click') {
      const app = requiredCliValue(args?.app, 'app', 240);
      const menuPath = requiredCliValue(args?.menu_path || args?.target_description, 'menu_path', 500);
      return {
        argv: ['menu', 'click', '--app', app, '--path', menuPath, '--json'],
        target: { app, menu_path: menuPath },
      };
    }

    if (action === 'window_close') {
      const argv = ['window', 'close'];
      appendTargetArgs(argv, args);
      requireTarget(argv, args);
      argv.push('--json');
      return { argv, target: compactTarget(args) };
    }

    const app = requiredCliValue(args?.app, 'app', 240);
    return { argv: ['app', 'quit', '--app', app, '--json'], target: { app } };
  }

  private async runMutation(input: {
    context: ToolExecutionContext;
    action: string;
    risk: string;
    target?: Record<string, unknown>;
    text?: string;
    snapshot?: CachedSnapshot;
    commands: MutationCommand[];
    response?: Record<string, unknown>;
  }): Promise<ToolExecutionOutput> {
    const owner = ownerKey(input.context);
    this.requireLease(input.context);
    const journal = this.journalFactory(input.context.workingDirectory);
    const actionId = journal.start({
      owner,
      action: input.action,
      target: input.target,
      text: input.text,
      snapshotId: input.snapshot?.snapshotId,
      risk: input.risk,
    });

    try {
      let lastData: unknown = {};
      for (const command of input.commands) {
        const result = await this.runner.run(command.argv, {
          timeoutMs: command.timeoutMs ?? 15_000,
          abortSignal: input.context.abortSignal,
        });
        lastData = result.data;
      }
      journal.finish({ owner, actionId, action: input.action, state: 'applied' });
      if (input.snapshot) this.snapshots.delete(input.snapshot.snapshotId);
      return toolSuccess(toJson({
        ok: true,
        action_id: actionId,
        state: 'applied',
        action: input.action,
        ...(input.response || {}),
        receipt: input.text === undefined ? sanitizeValue(lastData) : { redacted: true },
        journal_path: workspaceRelative(input.context.workingDirectory, journal.getPath(owner)),
      }));
    } catch (error) {
      const uncertain = error instanceof PeekabooRunnerError
        && (error.kind === 'timeout' || error.kind === 'aborted');
      journal.finish({
        owner,
        actionId,
        action: input.action,
        state: uncertain ? 'uncertain' : 'failed',
        driverCode: error instanceof PeekabooRunnerError ? error.code : undefined,
        detail: normalizeErrorMessage(error),
      });
      if (input.snapshot) this.snapshots.delete(input.snapshot.snapshotId);
      if (uncertain) {
        throw new GuiCatPolicyError(
          `GUI action outcome is unknown after driver ${error instanceof PeekabooRunnerError ? error.kind : 'failure'}; re-observe before any further action.`,
          'GUI_ACTION_OUTCOME_UNKNOWN',
          false,
        );
      }
      throw error;
    }
  }

  private async requireDriver(
    context: ToolExecutionContext,
    requirements: Partial<Record<keyof PeekabooDriverStatus['permissions'], boolean>>,
  ): Promise<PeekabooDriverStatus> {
    const status = await this.runner.status({ abortSignal: context.abortSignal });
    if (!status.supportedPlatform) {
      throw new GuiCatPolicyError(status.reason || 'macOS 15+ is required.', 'GUI_PLATFORM_UNSUPPORTED');
    }
    if (!status.binaryPath) {
      throw new GuiCatPolicyError(status.reason || 'Peekaboo CLI was not found.', 'GUI_DRIVER_NOT_FOUND');
    }
    if (!status.versionCompatible) {
      throw new GuiCatPolicyError(status.reason || 'Peekaboo 3.8.x is required.', 'GUI_DRIVER_VERSION_UNSUPPORTED');
    }
    if (requirements.screenRecording && !status.permissions.screenRecording) {
      throw new GuiCatPolicyError('Screen Recording permission is required.', 'GUI_PERMISSION_SCREEN_RECORDING_REQUIRED');
    }
    if (requirements.accessibility && !status.permissions.accessibility) {
      throw new GuiCatPolicyError('Accessibility permission is required.', 'GUI_PERMISSION_ACCESSIBILITY_REQUIRED');
    }
    if (requirements.eventSynthesizing && !status.permissions.eventSynthesizing) {
      throw new GuiCatPolicyError('Event Synthesizing permission is required for background keyboard input.', 'GUI_PERMISSION_EVENT_SYNTHESIZING_REQUIRED');
    }
    return status;
  }

  private requireSnapshot(args: any, context: ToolExecutionContext): CachedSnapshot {
    const snapshotId = requiredCliValue(args?.snapshot_id, 'snapshot_id', 300);
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || this.now() - snapshot.createdAt > this.snapshotTtlMs) {
      this.snapshots.delete(snapshotId);
      throw new GuiCatPolicyError('Snapshot is missing or stale; call gui_observe again.', 'GUI_SNAPSHOT_STALE', false);
    }
    if (snapshot.ownerHash !== hashOwner(ownerKey(context))) {
      throw new GuiCatPolicyError('Snapshot belongs to another GUI session.', 'GUI_SNAPSHOT_OWNER_MISMATCH');
    }
    if (!snapshot.actionable) {
      throw new GuiCatPolicyError(
        'Snapshot was captured without the desktop lease and cannot authorize a mutation; observe again with claim_control=true.',
        'GUI_SNAPSHOT_NOT_ACTIONABLE',
      );
    }
    return snapshot;
  }

  private requireElement(snapshot: CachedSnapshot, rawElementId: unknown): GuiElementSnapshot {
    const elementId = requiredCliValue(rawElementId, 'element_id', 300);
    const element = snapshot.elements.get(elementId);
    if (!element) {
      throw new GuiCatPolicyError('Element is not present in the cached snapshot; call gui_observe again.', 'GUI_ELEMENT_NOT_IN_SNAPSHOT', false);
    }
    return element;
  }

  private requireLease(context: ToolExecutionContext): void {
    const result = this.lease.acquire(ownerKey(context));
    if (!result.acquired) {
      throw new GuiCatPolicyError(
        result.reason || 'Another GuiCat session controls the desktop.',
        'GUI_DESKTOP_BUSY',
      );
    }
  }

  private assertOutsideArena(): void {
    if (this.environment.XIAOBA_ARENA === '1' || this.environment.XIAOBA_ARENA_SANDBOXED === '1') {
      throw new GuiCatPolicyError('Real GUI control is forbidden inside Arena.', 'GUI_FORBIDDEN_IN_ARENA');
    }
  }

  private createCapturePath(context: ToolExecutionContext, prefix: string): string {
    const session = hashOwner(ownerKey(context)).replace(':', '_');
    const root = path.resolve(context.workingDirectory, 'data', 'gui-cat', 'captures', session);
    fs.mkdirSync(root, { recursive: true });
    return path.join(root, `${prefix}-${this.now()}-${crypto.randomUUID()}.png`);
  }

  private errorOutput(error: unknown, mutation: boolean): ToolExecutionOutput {
    if (error instanceof GuiCatPolicyError) {
      return error.blocked
        ? toolBlocked(toJson({ ok: false, error: { code: error.code, message: error.message } }), error.code, error.message)
        : toolFailure(toJson({ ok: false, error: { code: error.code, message: error.message } }), error.code);
    }
    if (error instanceof PeekabooRunnerError) {
      if (['not_found', 'unsupported_platform', 'unsupported_version', 'permission'].includes(error.kind)) {
        return toolBlocked(
          toJson({ ok: false, error: { code: error.code, message: error.message } }),
          error.code,
          error.message,
        );
      }
      if (error.kind === 'aborted') {
        return buildToolExecutionOutput(
          toJson({ ok: false, error: { code: error.code, message: error.message } }),
          'cancelled',
          { errorCode: error.code, retryable: false },
        );
      }
      if (error.kind === 'timeout') {
        return mutation
          ? toolFailure(toJson({ ok: false, error: { code: 'GUI_ACTION_OUTCOME_UNKNOWN', message: error.message } }), 'GUI_ACTION_OUTCOME_UNKNOWN')
          : buildToolExecutionOutput(
            toJson({ ok: false, error: { code: error.code, message: error.message } }),
            'timeout',
            { errorCode: error.code, retryable: false },
          );
      }
      if (/SNAPSHOT_STALE/i.test(error.code)) {
        return toolFailure(toJson({ ok: false, error: { code: 'GUI_SNAPSHOT_STALE', message: error.message } }), 'GUI_SNAPSHOT_STALE');
      }
      return toolFailure(toJson({ ok: false, error: { code: error.code, message: error.message } }), error.code);
    }
    return toolFailure(
      toJson({ ok: false, error: { code: 'GUI_INTERNAL_ERROR', message: normalizeErrorMessage(error) } }),
      'GUI_INTERNAL_ERROR',
    );
  }
}

function buildManageArgv(action: string, args: any): string[] {
  if (action === 'app_launch') {
    const app = requiredCliValue(args?.app, 'app', 240);
    return ['app', 'launch', app, '--wait-until-ready', '--json'];
  }
  if (action === 'app_switch') {
    const app = requiredCliValue(args?.app, 'app', 240);
    return ['app', 'switch', '--to', app, '--verify', '--json'];
  }
  if (action.startsWith('window_')) {
    const subcommand = action.slice('window_'.length).replace('_', '-');
    const argv = ['window', subcommand];
    appendTargetArgs(argv, args);
    requireTarget(argv, args);
    if (action === 'window_move') {
      argv.push('-x', integerString(args?.x, 'x'), '-y', integerString(args?.y, 'y'));
    } else if (action === 'window_resize') {
      argv.push('-w', positiveIntegerString(args?.width, 'width'), '--height', positiveIntegerString(args?.height, 'height'));
    } else if (action === 'window_focus') {
      argv.push('--verify');
    }
    argv.push('--json');
    return argv;
  }
  if (action === 'scroll') {
    const direction = requiredEnum(args?.direction, ['up', 'down', 'left', 'right'], 'direction');
    const amount = boundedInteger(args?.amount, 1, 50, 3);
    const argv = ['scroll', '--direction', direction, '--amount', String(amount)];
    const snapshotId = optionalCliValue(args?.snapshot_id, 'snapshot_id', 300);
    const elementId = optionalCliValue(args?.element_id, 'element_id', 300);
    if (snapshotId) argv.push('--snapshot', snapshotId);
    if (elementId) argv.push('--on', elementId);
    appendTargetArgs(argv, args);
    argv.push('--json');
    return argv;
  }
  const key = requiredString(args?.key, 'key', 30).toLowerCase();
  if (!SAFE_KEYS.has(key)) {
    throw new GuiCatPolicyError('Only navigation keys are allowed by gui_manage.', 'GUI_KEY_FORBIDDEN');
  }
  const count = boundedInteger(args?.count, 1, 20, 1);
  const argv = ['press', key, '--count', String(count)];
  const snapshotId = optionalCliValue(args?.snapshot_id, 'snapshot_id', 300);
  if (snapshotId) argv.push('--snapshot', snapshotId);
  appendTargetArgs(argv, args);
  if (args?.delivery_mode === 'foreground') argv.push('--foreground');
  argv.push('--json');
  return argv;
}

function appendTargetArgs(argv: string[], args: any): void {
  const app = optionalCliValue(args?.app, 'app', 240);
  const pid = positiveIdentifier(args?.pid);
  const windowId = positiveIdentifier(args?.window_id);
  const windowTitle = optionalCliValue(args?.window_title, 'window_title', 500);
  if (windowId !== undefined) argv.push('--window-id', String(windowId));
  else if (pid !== undefined) argv.push('--pid', String(pid));
  else if (app) argv.push('--app', app);
  if (windowTitle) argv.push('--window-title', windowTitle);
}

function appendInventoryTargetArgs(argv: string[], args: any): void {
  const app = optionalCliValue(args?.app, 'app', 240);
  const pid = positiveIdentifier(args?.pid);
  if (pid !== undefined) argv.push('--pid', String(pid));
  else if (app) argv.push('--app', app);
}

function requireTarget(_argv: string[], args: any): void {
  if (!stringValue(args?.app) && numberValue(args?.pid) === undefined && numberValue(args?.window_id) === undefined) {
    throw new GuiCatPolicyError('An app, pid, or window_id target is required.', 'GUI_INVALID_ARGUMENTS');
  }
}

function normalizeElements(data: unknown, fallbackApp?: string): GuiElementSnapshot[] {
  const candidates = findArray(data, ['ui_elements', 'elements', 'interactables']);
  if (!candidates) return [];
  const result: GuiElementSnapshot[] = [];
  for (const item of candidates.slice(0, MAX_UI_ELEMENTS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = findString(record, ['id', 'element_id', 'elementId']);
    if (!id) continue;
    const element: GuiElementSnapshot = {
      id,
      role: findString(record, ['role', 'role_description', 'type']),
      label: findString(record, ['label', 'name']),
      title: findString(record, ['title']),
      description: findString(record, ['description', 'help']),
      value: findString(record, ['value']),
      app: findString(record, ['app', 'application_name']) || fallbackApp,
      bundleId: findString(record, ['bundle_id', 'bundleId']),
      enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
      bounds: sanitizeValue(record.bounds),
    };
    if (isSecureElement(element)) element.value = '[REDACTED]';
    result.push(removeUndefined(element));
  }
  return result;
}

function findArray(value: unknown, keys: string[], depth = 0): unknown[] | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return undefined;
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const child of Object.values(record)) {
    const found = findArray(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = stringValue(record[key]);
    if (found) return found;
  }
  for (const child of Object.values(record)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function successWithOptionalImage(payload: Record<string, unknown>, artifactPath?: string): ToolExecutionOutput {
  if (!artifactPath || !isSafeImageFile(artifactPath)) return toolSuccess(toJson(payload));
  const data = fs.readFileSync(artifactPath).toString('base64');
  const blocks: ContentBlock[] = [
    { type: 'text', text: toJson(payload) },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ];
  return toolSuccess(blocks);
}

function isSafeImageFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= MAX_SCREENSHOT_BYTES;
  } catch {
    return false;
  }
}

function sanitizeValue(value: unknown, keyHint = '', depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (/password|passcode|otp|secret|token|clipboard/i.test(keyHint)) return '[REDACTED]';
  if (typeof value === 'string') return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_UI_ELEMENTS).map(item => sanitizeValue(item, keyHint, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 250)) {
      result[key] = sanitizeValue(item, key, depth + 1);
    }
    return result;
  }
  return String(value);
}

function publicDriverStatus(status: PeekabooDriverStatus): Record<string, unknown> {
  return removeUndefined({
    platform: status.platform,
    macosVersion: status.macosVersion,
    supportedPlatform: status.supportedPlatform,
    version: status.version,
    versionCompatible: status.versionCompatible,
    permissions: { ...status.permissions },
    ready: status.ready,
    reason: status.reason ? redactDiagnosticPaths(status.reason) : undefined,
    bridge: publicBridgeSummary(status.bridge),
  });
}

function publicBridgeSummary(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const connected = firstBoolean(record, ['connected', 'isConnected', 'ready', 'available']);
  const selectedSource = safeBridgeSource(
    record.selected_source ?? record.selectedSource ?? record.source,
  );
  const summary = removeUndefined({
    connected,
    selected_source: selectedSource,
  });
  return Object.keys(summary).length ? summary : undefined;
}

function publicLeaseSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { held: false };
  const record = value as Record<string, unknown>;
  return removeUndefined({
    held: true,
    expires_at: stringValue(record.expires_at),
  });
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key] as boolean;
  }
  return undefined;
}

function safeBridgeSource(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    value = record.name ?? record.type ?? record.id;
  }
  const source = stringValue(value);
  if (!source || source.length > 80 || /[/\\]|\.sock\b|localhost|\d{1,3}(?:\.\d{1,3}){3}/i.test(source)) {
    return undefined;
  }
  return source;
}

function redactDiagnosticPaths(value: string): string {
  return value
    .replace(/\/(?:Users|private|var|tmp|opt|usr|Applications|Library)\/[^\s'\"]+/g, '[REDACTED_PATH]')
    .slice(0, 500);
}

function summarizeElement(element: GuiElementSnapshot): Record<string, unknown> {
  return removeUndefined({
    element_id: element.id,
    role: element.role,
    label: element.label,
    title: element.title,
    app: element.app,
    bundle_id: element.bundleId,
  });
}

function compactTarget(args: any): Record<string, unknown> {
  return removeUndefined({
    app: stringValue(args?.app),
    pid: numberValue(args?.pid),
    window_id: numberValue(args?.window_id),
    window_title: stringValue(args?.window_title),
    element_id: stringValue(args?.element_id),
    direction: stringValue(args?.direction),
    key: stringValue(args?.key),
  });
}

function guiTarget(args: any): GuiTarget {
  return removeUndefined({
    app: stringValue(args?.app),
    pid: positiveIdentifier(args?.pid),
    window_id: positiveIdentifier(args?.window_id),
    window_title: stringValue(args?.window_title),
  });
}

function hasGuiTarget(target: GuiTarget): boolean {
  return Boolean(target.app || target.pid !== undefined || target.window_id !== undefined || target.window_title);
}

function compactElementsForModel(elements: GuiElementSnapshot[]): GuiElementSnapshot[] {
  const genericText = /^(?:按钮|button|组|group|图像|image|文本|text)$/i;
  return elements
    .filter(element => {
      if (/^menu(?:item)?_/i.test(element.id) || /^(?:menu|menu item)$/i.test(element.role || '')) return false;
      const semantics = [element.label, element.title, element.description, element.value]
        .filter((value): value is string => Boolean(value && value.trim()))
        .filter(value => !genericText.test(value.trim()));
      if (semantics.length > 0) return true;
      return /button|textfield|textbox|checkbox|radio|menuitem|combobox|slider/i.test(element.role || '');
    })
    .slice(0, MAX_MODEL_UI_ELEMENTS)
    .map(element => removeUndefined({
      id: element.id,
      role: element.role,
      label: element.label,
      title: element.title,
      description: element.description,
      value: element.value,
      app: element.app,
      bundleId: element.bundleId,
      enabled: element.enabled,
    }));
}

function positiveIdentifier(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseToolJson(output: ToolExecutionOutput): unknown {
  const content = output.toolContent;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.find(block => block.type === 'text')?.text || ''
      : '';
  try {
    return JSON.parse(text);
  } catch {
    return { status: output.status, content: text.slice(0, 1_000) };
  }
}

function ownerKey(context: ToolExecutionContext): string {
  return context.sessionId || context.runId || `${context.surface || 'unknown'}:${process.pid}`;
}

function workspaceRelative(cwd: string, filePath: string): string {
  const relative = path.relative(path.resolve(cwd), path.resolve(filePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function shortHash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  const text = stringValue(value);
  if (!text) throw new GuiCatPolicyError(`${name} is required.`, 'GUI_INVALID_ARGUMENTS', false);
  if (text.includes('\0')) throw new GuiCatPolicyError(`${name} cannot contain NUL.`, 'GUI_INVALID_ARGUMENTS', false);
  if (text.length > maxLength) throw new GuiCatPolicyError(`${name} exceeds ${maxLength} characters.`, 'GUI_INVALID_ARGUMENTS', false);
  return text;
}

function requiredInputText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GuiCatPolicyError(`${name} is required.`, 'GUI_INVALID_ARGUMENTS', false);
  }
  if (value.includes('\0')) throw new GuiCatPolicyError(`${name} cannot contain NUL.`, 'GUI_INVALID_ARGUMENTS', false);
  if (value.length > maxLength) throw new GuiCatPolicyError(`${name} exceeds ${maxLength} characters.`, 'GUI_INVALID_ARGUMENTS', false);
  return value;
}

function requiredCliValue(value: unknown, name: string, maxLength: number): string {
  const text = requiredString(value, name, maxLength);
  if (text.startsWith('-')) {
    throw new GuiCatPolicyError(`${name} cannot start with '-'.`, 'GUI_INVALID_ARGUMENTS', false);
  }
  return text;
}

function optionalCliValue(value: unknown, name: string, maxLength: number): string | undefined {
  const text = stringValue(value);
  return text === undefined ? undefined : requiredCliValue(text, name, maxLength);
}

function enumValue(value: unknown, allowed: string[], fallback: string): string {
  const text = stringValue(value) || fallback;
  if (!allowed.includes(text)) {
    throw new GuiCatPolicyError(`Expected one of: ${allowed.join(', ')}.`, 'GUI_INVALID_ARGUMENTS', false);
  }
  return text;
}

function optionalEnum(value: unknown, allowed: string[]): string | undefined {
  const text = stringValue(value);
  return text ? enumValue(text, allowed, allowed[0]) : undefined;
}

function requiredEnum(value: unknown, allowed: string[], name: string): string {
  const text = requiredString(value, name, 80);
  return enumValue(text, allowed, allowed[0]);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new GuiCatPolicyError(`Expected integer between ${min} and ${max}.`, 'GUI_INVALID_ARGUMENTS', false);
  }
  return parsed;
}

function integerString(value: unknown, name: string): string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new GuiCatPolicyError(`${name} must be an integer.`, 'GUI_INVALID_ARGUMENTS', false);
  return String(parsed);
}

function positiveIntegerString(value: unknown, name: string): string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GuiCatPolicyError(`${name} must be a positive integer.`, 'GUI_INVALID_ARGUMENTS', false);
  }
  return String(parsed);
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeErrorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message || error || 'Unknown GuiCat error.');
}

function isBridgeTransient(error: unknown): boolean {
  if (!(error instanceof PeekabooRunnerError)) return false;
  return /bridge operation failed|bridge.*(?:temporar|unavailable|disconnect)/i.test(error.message);
}

function removeUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined),
  ) as T;
}

export function extractGuiArtifactPath(result: string | ContentBlock[] | ToolExecutionOutput): string | undefined {
  const content = isToolOutput(result) ? result.toolContent : result;
  const text = typeof content === 'string'
    ? content
    : content.find(block => block.type === 'text')?.type === 'text'
      ? (content.find(block => block.type === 'text') as { type: 'text'; text: string }).text
      : '';
  try {
    return stringValue((JSON.parse(text) as Record<string, unknown>).artifact_path);
  } catch {
    return undefined;
  }
}

function isToolOutput(value: unknown): value is ToolExecutionOutput {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'toolContent' in value);
}
