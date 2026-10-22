import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGuiCatTools } from '../src/capabilities/roles/gui-cat/tools/gui-tools';
import { DesktopLease, hashOwner } from '../src/capabilities/roles/gui-cat/utils/desktop-lease';
import {
  DefaultPeekabooRunner,
  PeekabooCommandResult,
  PeekabooDriverStatus,
  PeekabooRunner,
  PeekabooRunnerError,
} from '../src/capabilities/roles/gui-cat/utils/peekaboo-runner';
import { Tool, ToolExecutionContext, ToolExecutionOutput } from '../src/runtime/contracts/tool';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const temporaryRoots: string[] = [];

class FakePeekabooRunner implements PeekabooRunner {
  readonly calls: string[][] = [];
  statusCalls = 0;
  failCommand?: string;
  private snapshotNumber = 0;

  constructor(
    readonly elements: Array<Record<string, unknown>> = defaultElements(),
    readonly statusValue: PeekabooDriverStatus = readyStatus(),
  ) {}

  async status(): Promise<PeekabooDriverStatus> {
    this.statusCalls += 1;
    return this.statusValue;
  }

  async run(argv: string[]): Promise<PeekabooCommandResult> {
    this.calls.push([...argv]);
    if (this.failCommand === argv[0]) {
      throw new PeekabooRunnerError(
        'timeout',
        'simulated driver timeout',
        'GUI_DRIVER_TIMEOUT',
      );
    }

    if (argv[0] === 'see' || argv[0] === 'image') {
      const pathIndex = argv.indexOf('--path');
      if (pathIndex >= 0) {
        const artifactPath = argv[pathIndex + 1];
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, PNG_1X1);
      }
    }

    if (argv[0] === 'see') {
      this.snapshotNumber += 1;
      return commandResult({
        snapshot_id: 'snapshot-' + this.snapshotNumber,
        app: 'TextEdit',
        ui_elements: this.elements,
      });
    }
    if (argv[0] === 'agent') {
      return commandResult({
        result: {
          content: 'Task completed.',
          sessionId: 'agent-session-1',
          toolCalls: [{ name: 'inspect_ui' }, { name: 'click' }],
          metadata: { toolCallCount: 2, executionTime: 1.5, modelName: 'OpenAI/gpt-test' },
        },
      });
    }
    return commandResult({ command: argv[0], accepted: true });
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('GuiCat typed Peekaboo adapter', () => {
  test('uses XIAOBA_PEEKABOO_BIN and accepts only the pinned Peekaboo 3.8.x line', async () => {
    const root = temporaryRoot('xiaoba-gui-bin-');
    const binary = path.join(root, 'peekaboo-fixture');
    const executable = [
      '#!' + process.execPath,
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') process.stdout.write('Peekaboo 3.8.7\\n');",
      "else if (args[0] === 'permissions') process.stdout.write(JSON.stringify({ success: true, data: { permissions: [",
      "  { name: 'Screen Recording', isGranted: true },",
      "  { name: 'Accessibility', isGranted: true },",
      "  { name: 'Event Synthesizing', isGranted: true }",
      "] } }));",
      "else if (args[0] === 'bridge') process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));",
      "else process.stdout.write(JSON.stringify({ success: true, data: {} }));",
      '',
    ].join('\n');
    fs.writeFileSync(binary, executable, { mode: 0o700 });

    const runner = new DefaultPeekabooRunner({
      environment: {
        XIAOBA_PEEKABOO_BIN: binary,
        HOME: root,
        TMPDIR: root,
        PATH: process.env.PATH,
      },
      platform: 'darwin',
      osRelease: '24.0.0',
      statusCacheMs: 0,
    });
    const status = await runner.status({ refresh: true });

    assert.equal(status.binaryPath, fs.realpathSync(binary));
    assert.equal(status.version, '3.8.7');
    assert.equal(status.versionCompatible, true);
    assert.deepEqual(status.permissions, {
      screenRecording: true,
      accessibility: true,
      eventSynthesizing: true,
    });
    assert.equal(status.ready, true);
  });

  test('discovers a fixed local @steipete/peekaboo npm installation', async () => {
    const root = temporaryRoot('xiaoba-gui-package-bin-');
    const binary = path.join(root, 'node_modules', '@steipete', 'peekaboo', 'peekaboo');
    writePeekabooFixture(binary, '3.8.6');
    const runner = new DefaultPeekabooRunner({
      environment: {
        HOME: root,
        TMPDIR: root,
        PATH: '',
      },
      platform: 'darwin',
      osRelease: '24.0.0',
      projectRoot: root,
      resourcesPath: path.join(root, 'missing-resources'),
      statusCacheMs: 0,
    });

    const status = await runner.status({ refresh: true });
    assert.equal(status.binaryPath, fs.realpathSync(binary));
    assert.equal(status.version, '3.8.6');
    assert.equal(status.ready, true);
  });

  test('exposes only privacy-minimized driver and bridge diagnostics to the model', async () => {
    const root = temporaryRoot('xiaoba-gui-status-privacy-');
    const driverStatus: PeekabooDriverStatus = {
      ...readyStatus(),
      binaryPath: '/Users/private-user/bin/peekaboo',
      reason: 'driver log at /Users/private-user/Library/Peekaboo/debug.log',
      bridge: {
        connected: true,
        selectedSource: 'native',
        socketPath: '/Users/private-user/.peekaboo/bridge.sock',
        clientHost: 'private-macbook.local',
        debugLogs: ['/Users/private-user/Library/Peekaboo/debug.log'],
      },
    };
    const runner = new FakePeekabooRunner(defaultElements(), driverStatus);
    const result = await execute(createTools(root, runner), 'gui_driver_status', {}, context(root, 'gui-status'));
    const visibleText = outputText(result);
    const visible = payload(result);

    assert.equal(visible.trust, 'untrusted_driver_diagnostics');
    assert.equal(visible.status.platform, 'darwin');
    assert.equal(visible.status.version, '3.8.0');
    assert.deepEqual(visible.status.bridge, { connected: true, selected_source: 'native' });
    assert.equal('binaryPath' in visible.status, false);
    assert.equal(visibleText.includes('/Users/private-user'), false);
    assert.equal(visibleText.includes('socketPath'), false);
    assert.equal(visibleText.includes('clientHost'), false);
    assert.equal(visibleText.includes('debugLogs'), false);
  });

  test('binds safe clicks to a fresh snapshot and journals planned/applied evidence', async () => {
    const root = temporaryRoot('xiaoba-gui-click-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const ctx = context(root, 'gui-safe');

    const observed = await execute(tools, 'gui_observe', {
      app: 'TextEdit',
      include_screenshot: false,
    }, ctx);
    const observation = payload(observed);
    assert.equal(observed.status, 'success');
    assert.equal(observation.trust, 'untrusted_desktop_content');
    assert.equal(observation.snapshot_id, 'snapshot-1');

    const clicked = await execute(tools, 'gui_click', {
      snapshot_id: observation.snapshot_id,
      element_id: 'safe-button',
    }, ctx);
    const receipt = payload(clicked);
    assert.equal(clicked.status, 'success');
    assert.equal(receipt.state, 'applied');
    assert.deepEqual(runner.calls, [
      ['see', '--app', 'TextEdit', '--mode', 'window', '--json'],
      ['click', '--on', 'safe-button', '--snapshot', 'snapshot-1', '--app', 'TextEdit', '--json'],
    ]);

    const journal = fs.readFileSync(path.join(root, receipt.journal_path), 'utf8');
    assert.deepEqual(journal.trim().split('\n').map(line => JSON.parse(line).state), ['planned', 'applied']);
  });

  test('executes a bounded safe click sequence and automatically re-observes the same target window', async () => {
    const root = temporaryRoot('xiaoba-gui-sequence-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const ctx = context(root, 'gui-sequence');
    const observation = payload(await execute(tools, 'gui_observe', {
      app: 'TextEdit',
      mode: 'frontmost',
      include_screenshot: false,
    }, ctx));

    const result = await execute(tools, 'gui_click_sequence', {
      snapshot_id: observation.snapshot_id,
      element_ids: ['safe-button', 'safe-button'],
    }, ctx);
    const sequence = payload(result);

    assert.equal(result.status, 'success');
    assert.equal(sequence.state, 'applied_and_observed');
    assert.equal(sequence.click_count, 2);
    assert.equal(sequence.result_snapshot.snapshot_id, 'snapshot-2');
    assert.deepEqual(runner.calls, [
      ['see', '--app', 'TextEdit', '--mode', 'window', '--json'],
      ['click', '--on', 'safe-button', '--snapshot', 'snapshot-1', '--app', 'TextEdit', '--json'],
      ['click', '--on', 'safe-button', '--snapshot', 'snapshot-1', '--app', 'TextEdit', '--json'],
      ['see', '--app', 'TextEdit', '--mode', 'window', '--json'],
    ]);
  });

  test('requires the consequential tool and blocks that tool in subagent contexts', async () => {
    const root = temporaryRoot('xiaoba-gui-confirm-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const direct = context(root, 'gui-direct');
    const observation = payload(await execute(tools, 'gui_observe', {
      include_screenshot: false,
    }, direct));
    const action = {
      action: 'click',
      target_description: 'Delete document',
      confirmed: true,
      snapshot_id: observation.snapshot_id,
      element_id: 'delete-button',
    };

    const ordinary = await execute(tools, 'gui_click', {
      snapshot_id: observation.snapshot_id,
      element_id: 'delete-button',
    }, direct);
    assert.equal(ordinary.status, 'blocked');
    assert.equal(ordinary.error_code, 'GUI_CONFIRMATION_REQUIRED');

    const subagent = await execute(tools, 'gui_confirmed_action', action, {
      ...direct,
      sessionId: 'subagent:gui-child',
      surface: 'agent',
    });
    assert.equal(subagent.status, 'blocked');
    assert.equal(subagent.error_code, 'GUI_SUBAGENT_CONFIRMATION_UNTRUSTED');

    const confirmed = await execute(tools, 'gui_confirmed_action', action, direct);
    assert.equal(confirmed.status, 'success');
    assert.equal(runner.calls.filter(call => call[0] === 'click').length, 1);
  });

  test('blocks terminal, secure-field, and dangerous-command input while redacting ordinary text evidence', async () => {
    const root = temporaryRoot('xiaoba-gui-input-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const ctx = context(root, 'gui-input');
    const observation = payload(await execute(tools, 'gui_observe', {
      include_screenshot: false,
    }, ctx));

    const terminal = await execute(tools, 'gui_input', {
      snapshot_id: observation.snapshot_id,
      element_id: 'terminal-field',
      text: 'echo hello',
    }, ctx);
    assert.equal(terminal.status, 'blocked');
    assert.equal(terminal.error_code, 'GUI_INPUT_FORBIDDEN');

    const secure = await execute(tools, 'gui_input', {
      snapshot_id: observation.snapshot_id,
      element_id: 'password-field',
      text: 'not-a-real-password',
    }, ctx);
    assert.equal(secure.status, 'blocked');
    assert.equal(secure.error_code, 'GUI_INPUT_FORBIDDEN');

    const ideTerminal = await execute(tools, 'gui_input', {
      snapshot_id: observation.snapshot_id,
      element_id: 'ide-terminal-field',
      text: 'echo from IDE',
    }, ctx);
    assert.equal(ideTerminal.status, 'blocked');
    assert.equal(ideTerminal.error_code, 'GUI_INPUT_FORBIDDEN');

    const dangerous = await execute(tools, 'gui_input', {
      snapshot_id: observation.snapshot_id,
      element_id: 'notes-field',
      text: 'rm -rf /',
    }, ctx);
    assert.equal(dangerous.status, 'blocked');
    assert.equal(dangerous.error_code, 'GUI_INPUT_FORBIDDEN');

    const ordinaryText = 'ordinary gui text 123';
    const ordinary = await execute(tools, 'gui_input', {
      snapshot_id: observation.snapshot_id,
      element_id: 'notes-field',
      text: ordinaryText,
      mode: 'set_value',
    }, ctx);
    const ordinaryPayload = payload(ordinary);
    assert.equal(ordinary.status, 'success');
    assert.equal(ordinaryPayload.text_length, ordinaryText.length);
    assert.match(ordinaryPayload.text_sha256, /^sha256:/);
    assert.equal(outputText(ordinary).includes(ordinaryText), false);
    assert.deepEqual(runner.calls.at(-1), [
      'set-value', '--on', 'notes-field', '--snapshot', 'snapshot-1',
      '--value', ordinaryText, '--json',
    ]);

    const journal = fs.readFileSync(path.join(root, ordinaryPayload.journal_path), 'utf8');
    assert.equal(journal.includes(ordinaryText), false);
    const planned = JSON.parse(journal.trim().split('\n')[0]);
    assert.equal(planned.input.length, ordinaryText.length);
    assert.match(planned.input.sha256, /^sha256:/);
  });

  test('enforces one cross-service physical desktop lease until the owner releases it', async () => {
    const root = temporaryRoot('xiaoba-gui-lease-');
    const leaseRoot = path.join(root, 'shared-lease');
    const runnerA = new FakePeekabooRunner();
    const runnerB = new FakePeekabooRunner();
    const toolsA = createGuiCatTools({
      runner: runnerA,
      lease: new DesktopLease({ rootDir: leaseRoot }),
    });
    const toolsB = createGuiCatTools({
      runner: runnerB,
      lease: new DesktopLease({ rootDir: leaseRoot }),
    });
    const contextA = context(root, 'gui-owner-a');
    const contextB = context(root, 'gui-owner-b');

    assert.equal((await execute(toolsA, 'gui_observe', { include_screenshot: false }, contextA)).status, 'success');
    const busy = await execute(toolsB, 'gui_observe', { include_screenshot: false }, contextB);
    assert.equal(busy.status, 'blocked');
    assert.equal(busy.error_code, 'GUI_DESKTOP_BUSY');
    assert.equal(runnerB.calls.length, 0);

    const released = payload(await execute(toolsA, 'gui_release_control', {}, contextA));
    assert.equal(released.released, true);
    assert.equal((await execute(toolsB, 'gui_observe', { include_screenshot: false }, contextB)).status, 'success');
    assert.equal(runnerB.calls.length, 1);
  });

  test('marks lease-free observations read-only and refuses them as mutation authority', async () => {
    const root = temporaryRoot('xiaoba-gui-readonly-snapshot-');
    const leaseRoot = path.join(root, 'shared-lease');
    const controllingRunner = new FakePeekabooRunner();
    const passiveRunner = new FakePeekabooRunner();
    const controllingTools = createGuiCatTools({
      runner: controllingRunner,
      lease: new DesktopLease({ rootDir: leaseRoot }),
    });
    const passiveTools = createGuiCatTools({
      runner: passiveRunner,
      lease: new DesktopLease({ rootDir: leaseRoot }),
    });
    const controllingContext = context(root, 'gui-controller');
    const passiveContext = context(root, 'gui-passive');

    await execute(controllingTools, 'gui_observe', { include_screenshot: false }, controllingContext);
    const passiveObservation = payload(await execute(passiveTools, 'gui_observe', {
      include_screenshot: false,
      claim_control: false,
    }, passiveContext));
    assert.equal(passiveObservation.snapshot_actionable, false);

    const mutation = await execute(passiveTools, 'gui_click', {
      snapshot_id: passiveObservation.snapshot_id,
      element_id: 'safe-button',
    }, passiveContext);
    assert.equal(mutation.status, 'blocked');
    assert.equal(mutation.error_code, 'GUI_SNAPSHOT_NOT_ACTIONABLE');
    assert.equal(passiveRunner.calls.filter(call => call[0] === 'click').length, 0);
  });

  test('does not evict a fresh lease that wins during stale takeover', () => {
    const root = temporaryRoot('xiaoba-gui-lease-cas-');
    const leaseRoot = path.join(root, 'lease');
    const expiredOwner = new DesktopLease({ rootDir: leaseRoot, ttlMs: 5_000, now: () => 0, pid: 1001 });
    assert.equal(expiredOwner.acquire('expired-owner').acquired, true);

    const winner = new DesktopLease({ rootDir: leaseRoot, ttlMs: 5_000, now: () => 10_000, pid: 1002 });
    let winnerResult: ReturnType<DesktopLease['acquire']> | undefined;
    let triggered = false;
    const racingRecoverer = new DesktopLease({
      rootDir: leaseRoot,
      ttlMs: 5_000,
      pid: 1003,
      now: () => {
        if (!triggered) {
          triggered = true;
          winnerResult = winner.acquire('fresh-winner');
        }
        return 10_000;
      },
    });

    const losingResult = racingRecoverer.acquire('late-recoverer');
    assert.equal(winnerResult?.acquired, true);
    assert.equal(losingResult.acquired, false);
    assert.equal(winner.inspect()?.owner_hash, hashOwner('fresh-winner'));
  });

  test('records mutation timeouts as uncertain and never retries the action', async () => {
    const root = temporaryRoot('xiaoba-gui-timeout-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const ctx = context(root, 'gui-timeout');
    const observation = payload(await execute(tools, 'gui_observe', {
      include_screenshot: false,
    }, ctx));
    runner.failCommand = 'click';

    const result = await execute(tools, 'gui_click', {
      snapshot_id: observation.snapshot_id,
      element_id: 'safe-button',
    }, ctx);
    assert.equal(result.status, 'failure');
    assert.equal(result.error_code, 'GUI_ACTION_OUTCOME_UNKNOWN');
    assert.equal(runner.calls.filter(call => call[0] === 'click').length, 1);

    const journals = fs.readdirSync(path.join(root, 'data', 'gui-cat', 'journal'));
    const journal = fs.readFileSync(path.join(root, 'data', 'gui-cat', 'journal', journals[0]), 'utf8');
    assert.deepEqual(journal.trim().split('\n').map(line => JSON.parse(line).state), ['planned', 'uncertain']);

    const stale = await execute(tools, 'gui_click', {
      snapshot_id: observation.snapshot_id,
      element_id: 'safe-button',
    }, ctx);
    assert.equal(stale.error_code, 'GUI_SNAPSHOT_STALE');
    assert.equal(runner.calls.filter(call => call[0] === 'click').length, 1);
  });

  test('blocks both Arena markers before touching the real driver', async () => {
    for (const environment of [
      { XIAOBA_ARENA: '1' },
      { XIAOBA_ARENA_SANDBOXED: '1' },
    ]) {
      const root = temporaryRoot('xiaoba-gui-arena-');
      const runner = new FakePeekabooRunner();
      const tools = createGuiCatTools({
        runner,
        environment,
        lease: new DesktopLease({ rootDir: path.join(root, 'lease') }),
      });
      const result = await execute(tools, 'gui_driver_status', {}, context(root, 'gui-arena'));
      assert.equal(result.status, 'blocked');
      assert.equal(result.error_code, 'GUI_FORBIDDEN_IN_ARENA');
      assert.equal(runner.statusCalls, 0);
      assert.equal(runner.calls.length, 0);
    }
  });

  test('uses closed manage argv and refuses terminal applications', async () => {
    const root = temporaryRoot('xiaoba-gui-manage-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const ctx = context(root, 'gui-manage');

    const terminal = await execute(tools, 'gui_manage', {
      action: 'app_launch',
      app: 'Terminal',
    }, ctx);
    assert.equal(terminal.status, 'blocked');
    assert.equal(terminal.error_code, 'GUI_TERMINAL_FORBIDDEN');
    assert.equal(runner.calls.length, 0);

    const launched = await execute(tools, 'gui_manage', {
      action: 'app_launch',
      app: 'TextEdit',
    }, ctx);
    assert.equal(launched.status, 'success');
    assert.deepEqual(runner.calls, [
      ['app', 'launch', 'TextEdit', '--wait-until-ready', '--json'],
    ]);
  });

  test('rejects option-like typed identifiers while preserving leading-dash input text as one option value', async () => {
    const root = temporaryRoot('xiaoba-gui-option-confusion-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const ctx = context(root, 'gui-option-confusion');

    const appOption = await execute(tools, 'gui_manage', {
      action: 'app_launch',
      app: '--help',
    }, ctx);
    assert.equal(appOption.status, 'failure');
    assert.equal(appOption.error_code, 'GUI_INVALID_ARGUMENTS');
    assert.equal(runner.calls.length, 0);

    const titleOption = await execute(tools, 'gui_observe', {
      window_title: '--json',
      include_screenshot: false,
    }, ctx);
    assert.equal(titleOption.status, 'failure');
    assert.equal(titleOption.error_code, 'GUI_INVALID_ARGUMENTS');
    assert.equal(runner.calls.length, 0);
    await execute(tools, 'gui_release_control', {}, ctx);

    const observation = payload(await execute(tools, 'gui_observe', {
      include_screenshot: false,
    }, ctx));
    const leadingDashText = '--help is ordinary document text';
    const input = await execute(tools, 'gui_input', {
      snapshot_id: observation.snapshot_id,
      element_id: 'notes-field',
      text: leadingDashText,
    }, ctx);
    assert.equal(input.status, 'success');
    assert.deepEqual(runner.calls.at(-1), [
      'set-value', '--on', 'notes-field', '--snapshot', 'snapshot-1',
      '--value', leadingDashText, '--json',
    ]);
  });

  test('creates controlled screenshot artifacts with tool-owned evidence metadata', async () => {
    const root = temporaryRoot('xiaoba-gui-capture-');
    const runner = new FakePeekabooRunner();
    const tools = createTools(root, runner);
    const capture = findTool(tools, 'gui_capture');
    const ctx = context(root, 'gui-capture');
    const result = asOutput(await capture.execute({ mode: 'frontmost' }, ctx));
    const captured = payload(result);

    assert.equal(result.status, 'success');
    assert.equal(captured.trust, 'untrusted_desktop_content');
    assert.equal(fs.existsSync(captured.artifact_path), true);
    assert.ok(Array.isArray(result.toolContent));
    const manifest = capture.getArtifactManifest?.({}, result, ctx) || [];
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].action, 'captured');
    assert.equal(manifest[0].metadata?.source, 'tool_owned');
    assert.equal(manifest[0].metadata?.trust, 'untrusted_desktop_content');
    assert.equal(path.isAbsolute(manifest[0].path), false);
  });

  test('rejects snapshots after the configured freshness window', async () => {
    const root = temporaryRoot('xiaoba-gui-stale-');
    const runner = new FakePeekabooRunner();
    let now = 1_000;
    const tools = createGuiCatTools({
      runner,
      now: () => now,
      snapshotTtlMs: 1_000,
      lease: new DesktopLease({ rootDir: path.join(root, 'lease-2') }),
    });
    const ctx = context(root, 'gui-stale');
    const observation = payload(await execute(tools, 'gui_observe', {
      include_screenshot: false,
    }, ctx));
    now = 2_001;

    const stale = await execute(tools, 'gui_click', {
      snapshot_id: observation.snapshot_id,
      element_id: 'safe-button',
    }, ctx);
    assert.equal(stale.status, 'failure');
    assert.equal(stale.error_code, 'GUI_SNAPSHOT_STALE');
    assert.equal(runner.calls.filter(call => call[0] === 'click').length, 0);
  });
});

function createTools(root: string, runner: PeekabooRunner): Tool[] {
  return createGuiCatTools({
    runner,
    lease: new DesktopLease({ rootDir: path.join(root, 'lease') }),
  });
}

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find(candidate => candidate.definition.name === name);
  assert.ok(tool, 'missing tool ' + name);
  return tool;
}

async function execute(
  tools: Tool[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutput> {
  return asOutput(await findTool(tools, name).execute(args, ctx));
}

function asOutput(value: unknown): ToolExecutionOutput {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && 'toolContent' in value);
  return value as ToolExecutionOutput;
}

function outputText(output: ToolExecutionOutput): string {
  if (typeof output.toolContent === 'string') return output.toolContent;
  const textBlock = output.toolContent.find(block => block.type === 'text');
  assert.ok(textBlock && textBlock.type === 'text');
  return textBlock.text;
}

function payload(output: ToolExecutionOutput): Record<string, any> {
  return JSON.parse(outputText(output)) as Record<string, any>;
}

function commandResult(data: unknown): PeekabooCommandResult {
  return {
    data,
    stdout: JSON.stringify({ success: true, data }),
    stderr: '',
  };
}

function readyStatus(): PeekabooDriverStatus {
  return {
    platform: 'darwin',
    macosVersion: '15',
    supportedPlatform: true,
    binaryPath: '/fake/peekaboo',
    version: '3.8.0',
    versionCompatible: true,
    permissions: {
      screenRecording: true,
      accessibility: true,
      eventSynthesizing: true,
    },
    ready: true,
  };
}

function defaultElements(): Array<Record<string, unknown>> {
  return [
    { id: 'safe-button', role: 'AXButton', label: 'Open', app: 'TextEdit' },
    { id: 'delete-button', role: 'AXButton', label: 'Delete Document', app: 'TextEdit' },
    { id: 'notes-field', role: 'AXTextField', label: 'Notes', app: 'TextEdit' },
    { id: 'password-field', role: 'AXSecureTextField', label: 'Password', app: 'TextEdit' },
    { id: 'terminal-field', role: 'AXTextField', label: 'Command', app: 'Terminal' },
    { id: 'ide-terminal-field', role: 'AXTextArea', label: 'Integrated Terminal', app: 'Visual Studio Code' },
  ];
}

function context(root: string, sessionId: string): ToolExecutionContext {
  return {
    workingDirectory: root,
    conversationHistory: [],
    sessionId,
    surface: 'cli',
    roleName: 'gui-cat',
  };
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function writePeekabooFixture(binary: string, version: string): void {
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const executable = [
    '#!' + process.execPath,
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') process.stdout.write('Peekaboo " + version + "\\n');",
    "else if (args[0] === 'permissions') process.stdout.write(JSON.stringify({ success: true, data: { permissions: [",
    "  { name: 'Screen Recording', isGranted: true },",
    "  { name: 'Accessibility', isGranted: true },",
    "  { name: 'Event Synthesizing', isGranted: true }",
    "] } }));",
    "else if (args[0] === 'bridge') process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));",
    "else process.stdout.write(JSON.stringify({ success: true, data: {} }));",
    '',
  ].join('\n');
  fs.writeFileSync(binary, executable, { mode: 0o700 });
}
