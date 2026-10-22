import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENT_BROWSER_VERSION,
  AgentBrowserBinaryResolver,
  AgentBrowserDriverError,
  AgentBrowserDriverStatus,
  AgentBrowserExecFile,
  AgentBrowserResponse,
  AgentBrowserRunOptions,
  AgentBrowserRunner,
  DefaultAgentBrowserBinaryResolver,
  DefaultAgentBrowserRunner,
  buildDriverEnvironment,
  buildPinnedDriverArgs,
  isNativeAgentBrowserBinary,
  parseAgentBrowserResponse,
  resolveAgentBrowserBinaryName,
  resolveXiaoBaApplicationRoot,
} from '../src/capabilities/roles/browser-cat/agent-browser-runner';
import {
  BrowserScreenshotTool,
  createBrowserCatTools,
  validateHttpUrl,
} from '../src/capabilities/roles/browser-cat/browser-tools';
import { deriveBrowserSessionId } from '../src/capabilities/roles/browser-cat/browser-session-store';
import { Tool, ToolExecutionContext, ToolExecutionOutput } from '../src/runtime/contracts/tool';

class FakeRunner implements AgentBrowserRunner {
  readonly calls: Array<{ command: string[]; options: AgentBrowserRunOptions }> = [];
  readonly responses: AgentBrowserResponse[] = [];
  readonly errors: unknown[] = [];

  async getStatus(): Promise<AgentBrowserDriverStatus> {
    return {
      installed: true,
      ready: true,
      version: AGENT_BROWSER_VERSION,
      expectedVersion: AGENT_BROWSER_VERSION,
      binaryPath: '/fake/agent-browser',
      doctor: { success: true, summary: { pass: 5, fail: 0, warn: 0 } },
    };
  }

  async run(command: string[], options: AgentBrowserRunOptions): Promise<AgentBrowserResponse> {
    this.calls.push({ command: [...command], options: { ...options } });
    const error = this.errors.shift();
    if (error) throw error;
    const response = this.responses.shift() || { success: true, data: { action: command[0] } };
    if (response.success && command[0] === 'screenshot' && command[1]) {
      fs.mkdirSync(path.dirname(command[1]), { recursive: true });
      fs.writeFileSync(command[1], Buffer.from('89504e470d0a1a0a', 'hex'));
    }
    return response;
  }
}

const temporaryRoots: string[] = [];

afterEach(() => {
  delete process.env.XIAOBA_ARENA;
  delete process.env.XIAOBA_ARENA_SANDBOXED;
  delete process.env.XIAOBA_LLM_API_KEY;
  delete process.env.XIAOBA_LLM_MODEL;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('agent-browser pinned runner', () => {
  test('never forwards XiaoBa provider credentials into the browser driver', () => {
    const environment = buildDriverEnvironment({
      XIAOBA_LLM_API_KEY: 'secret-key',
      XIAOBA_LLM_API_BASE: 'http://127.0.0.1:8317/v1',
    });
    assert.strictEqual(environment.AI_GATEWAY_API_KEY, undefined);
    assert.strictEqual(environment.AI_GATEWAY_URL, undefined);
    assert.strictEqual(environment.AI_GATEWAY_MODEL, undefined);
    assert.strictEqual(environment.XIAOBA_LLM_API_KEY, undefined);
    assert.strictEqual(environment.XIAOBA_LLM_API_BASE, undefined);
  });

  test('pins deterministic sessions and rejects the upstream chat loop', () => {
    const ordinary = buildPinnedDriverArgs(['snapshot', '-i'], {
      sessionId: 'typed-session',
      cwd: '/workspace',
    }, '/private/config.json');
    assert.deepStrictEqual(ordinary.slice(0, 2), ['--config', '/private/config.json']);
    assert.ok(ordinary.includes('--session'));
    assert.throws(() => buildPinnedDriverArgs(['chat', 'inspect the current page'], {
      sessionId: 'typed-session',
      cwd: '/workspace',
    }, '/private/config.json'), (error: any) => error?.code === 'BROWSER_DRIVER_COMMAND_FORBIDDEN');
  });

  test('uses exact binary version and execFile argv without shell interpolation', async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-runner-'));
    temporaryRoots.push(runtime);
    const safeConfig = path.join(runtime, 'config.json');
    fs.writeFileSync(safeConfig, '{}\n');
    const executions: Array<{ binary: string; args: string[] }> = [];
    const resolver: AgentBrowserBinaryResolver = { resolve: () => '/pinned/agent-browser' };
    const executor: AgentBrowserExecFile = async (binary, args) => {
      executions.push({ binary, args: [...args] });
      if (args[0] === '--version') {
        return { stdout: `agent-browser ${AGENT_BROWSER_VERSION}\n`, stderr: '' };
      }
      return { stdout: JSON.stringify({ success: true, data: { ok: true } }), stderr: '' };
    };
    const runner = new DefaultAgentBrowserRunner(resolver, executor, safeConfig);
    const hostileText = 'hello"; $(touch /tmp/should-not-run); rm -rf /';

    const response = await runner.run(['fill', '@e1', hostileText], {
      sessionId: 'xb-browser-test',
      cwd: process.cwd(),
    });

    assert.strictEqual(response.success, true);
    assert.strictEqual(executions.length, 2);
    assert.strictEqual(executions[1].binary, '/pinned/agent-browser');
    assert.deepStrictEqual(executions[1].args.slice(0, 2), ['--config', safeConfig]);
    assert.ok(executions[1].args.includes('--content-boundaries'));
    assert.ok(executions[1].args.includes('--restore'));
    assert.deepStrictEqual(executions[1].args.slice(-3), ['fill', '@e1', hostileText]);
  });

  test('rejects a mismatched driver version before executing a browser command', async () => {
    const resolver: AgentBrowserBinaryResolver = { resolve: () => '/wrong/agent-browser' };
    const executor: AgentBrowserExecFile = async () => ({ stdout: 'agent-browser 0.30.0\n', stderr: '' });
    const runner = new DefaultAgentBrowserRunner(resolver, executor);

    await assert.rejects(
      () => runner.run(['open', 'https://example.com/'], { sessionId: 'xb-test', cwd: process.cwd() }),
      (error: unknown) => error instanceof AgentBrowserDriverError
        && error.code === 'BROWSER_DRIVER_VERSION_MISMATCH',
    );
  });

  test('preserves structured JSON failures emitted with a nonzero process exit', async () => {
    let call = 0;
    const runner = new DefaultAgentBrowserRunner(
      { resolve: () => '/pinned/agent-browser' },
      async () => {
        call += 1;
        if (call === 1) return { stdout: `agent-browser ${AGENT_BROWSER_VERSION}\n`, stderr: '' };
        const error = new Error('process exited 1') as Error & { stdout?: string };
        error.stdout = JSON.stringify({ success: false, data: null, error: 'navigation blocked' });
        throw error;
      },
    );

    const response = await runner.run(['open', 'https://example.com/'], {
      sessionId: 'xb-test',
      cwd: process.cwd(),
    });
    assert.deepStrictEqual(response, {
      success: false,
      data: null,
      error: 'navigation blocked',
    });
  });

  test('real runner is blocked in Arena while fake runners remain injectable', async () => {
    process.env.XIAOBA_ARENA = '1';
    let executed = false;
    const runner = new DefaultAgentBrowserRunner(
      { resolve: () => '/fake/agent-browser' },
      async () => {
        executed = true;
        return { stdout: '', stderr: '' };
      },
    );

    await assert.rejects(
      () => runner.run(['snapshot', '-i'], { sessionId: 'xb-test', cwd: process.cwd() }),
      (error: unknown) => error instanceof AgentBrowserDriverError
        && error.code === 'BROWSER_DISABLED_IN_ARENA',
    );
    assert.strictEqual(executed, false);

    const fake = new FakeRunner();
    const snapshot = toolByName(createBrowserCatTools({ runner: fake }), 'browser_snapshot');
    fake.responses.push({ success: true, data: { snapshot: '- button "Safe" [ref=e1]' } });
    const output = await snapshot.execute({}, toolContext('agent'));
    assert.strictEqual(asOutput(output).status, 'success');
  });

  test('runner only permits BrowserCat allowlisted commands and validates JSON envelopes', () => {
    assert.throws(
      () => buildPinnedDriverArgs(['eval', 'document.cookie'], {
        sessionId: 'xb-test',
        cwd: process.cwd(),
      }),
      (error: unknown) => error instanceof AgentBrowserDriverError
        && error.code === 'BROWSER_DRIVER_COMMAND_FORBIDDEN',
    );
    assert.throws(
      () => parseAgentBrowserResponse('{"data":{}}'),
      (error: unknown) => error instanceof AgentBrowserDriverError
        && error.code === 'BROWSER_DRIVER_INVALID_OUTPUT',
    );
    assert.deepStrictEqual(parseAgentBrowserResponse('{"success":true,"data":{}}'), {
      success: true,
      data: {},
    });
  });

  test('maps supported native binary names and rejects unsupported Windows arm64', () => {
    assert.strictEqual(resolveAgentBrowserBinaryName('darwin', 'arm64'), 'agent-browser-darwin-arm64');
    assert.strictEqual(resolveAgentBrowserBinaryName('darwin', 'x64'), 'agent-browser-darwin-x64');
    assert.strictEqual(resolveAgentBrowserBinaryName('win32', 'x64'), 'agent-browser-win32-x64.exe');
    assert.throws(
      () => resolveAgentBrowserBinaryName('win32', 'arm64'),
      (error: unknown) => error instanceof AgentBrowserDriverError
        && error.code === 'BROWSER_DRIVER_NOT_FOUND',
    );
  });

  test('accepts native executable headers and rejects npm or shell wrapper scripts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-binary-'));
    temporaryRoots.push(root);
    const nativeBinary = path.join(root, 'agent-browser-darwin-arm64');
    const wrapper = path.join(root, 'agent-browser');
    fs.writeFileSync(nativeBinary, Buffer.from('cffaedfe00000000', 'hex'));
    fs.writeFileSync(wrapper, '#!/usr/bin/env node\nconsole.log("wrapper");\n');

    assert.strictEqual(isNativeAgentBrowserBinary(nativeBinary, 'darwin'), true);
    assert.strictEqual(isNativeAgentBrowserBinary(wrapper, 'darwin'), false);
  });

  test('resolves packaged binaries from the XiaoBa install root rather than the user workspace', () => {
    const applicationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-app-root-'));
    temporaryRoots.push(applicationRoot);
    const binaryDirectory = path.join(applicationRoot, 'node_modules', 'agent-browser', 'bin');
    fs.mkdirSync(binaryDirectory, { recursive: true });
    const binary = path.join(binaryDirectory, 'agent-browser-darwin-arm64');
    fs.writeFileSync(binary, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o755 });
    fs.chmodSync(binary, 0o755);

    const resolver = new DefaultAgentBrowserBinaryResolver(applicationRoot, 'darwin', 'arm64');
    assert.strictEqual(resolver.resolve(), binary);
    assert.strictEqual(
      resolveXiaoBaApplicationRoot('/opt/xiaoba/dist/capabilities/roles/browser-cat', {}),
      '/opt/xiaoba',
    );
    assert.strictEqual(
      resolveXiaoBaApplicationRoot('/ignored/module/path', { XIAOBA_APP_ROOT: '/packaged/xiaoba' }),
      '/packaged/xiaoba',
    );
  });

  test('passes only required process variables and explicit agent-browser settings to the driver', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-runtime-'));
    temporaryRoots.push(runtime);
    const environment = buildDriverEnvironment({
      PATH: '/bin',
      HOME: '/home/test',
      USERPROFILE: 'C:\\Users\\test',
      XDG_RUNTIME_DIR: '/run/user/host',
      XDG_CONFIG_HOME: '/home/test/.config',
      XDG_CACHE_HOME: '/home/test/.cache',
      XDG_DATA_HOME: '/home/test/.local/share',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      PLAYWRIGHT_BROWSERS_PATH: '/trusted/playwright-browsers',
      PUPPETEER_CACHE_DIR: '/trusted/puppeteer-cache',
      LANG: 'en_US.UTF-8',
      AGENT_BROWSER_ALLOWED_DOMAINS: 'example.com',
      AGENT_BROWSER_ACTION_POLICY: '/hostile/policy.json',
      AGENT_BROWSER_DEFAULT_TIMEOUT: '999999',
      AGENT_BROWSER_HIDE_SCROLLBARS: '1',
      AGENT_BROWSER_NO_AUTO_DIALOG: '1',
      AGENT_BROWSER_STATE_EXPIRE_DAYS: '9999',
      AGENT_BROWSER_ENCRYPTION_KEY: 'must-not-reach-driver',
      AGENT_BROWSER_CONFIG: '/hostile/config.json',
      AGENT_BROWSER_CDP: 'ws://attacker.invalid/',
      AGENT_BROWSER_PROFILE: '/hostile/profile',
      AGENT_BROWSER_STATE: '/hostile/state.json',
      AGENT_BROWSER_INIT_SCRIPTS: '/hostile/init.js',
      AGENT_BROWSER_EXTENSIONS: '/hostile/extension',
      AGENT_BROWSER_PLUGINS: '[{"name":"evil"}]',
      AGENT_BROWSER_EXECUTABLE_PATH: '/hostile/browser',
      AGENT_BROWSER_ALLOW_FILE_ACCESS: '1',
      AGENT_BROWSER_ARGS: '--load-extension=/hostile/extension',
      AGENT_BROWSER_PROVIDER: 'evil-provider',
      AGENT_BROWSER_SOCKET_DIR: '/hostile/socket',
      AGENT_BROWSER_SCREENSHOT_DIR: '/hostile/screenshots',
      XIAOBA_API_KEY: 'xiaoba-secret',
      OPENAI_API_KEY: 'openai-secret',
      FEISHU_APP_SECRET: 'feishu-secret',
      WEIXIN_TOKEN: 'weixin-secret',
      RANDOM_PASSWORD: 'password',
    }, runtime);

    assert.strictEqual(environment.PATH, '/bin');
    assert.strictEqual(environment.HOME, path.join(runtime, 'home'));
    assert.strictEqual(environment.USERPROFILE, path.join(runtime, 'home'));
    assert.strictEqual(environment.XDG_RUNTIME_DIR, path.join(runtime, 'xdg', 'runtime'));
    assert.strictEqual(environment.XDG_CONFIG_HOME, path.join(runtime, 'xdg', 'config'));
    assert.strictEqual(environment.XDG_CACHE_HOME, path.join(runtime, 'xdg', 'cache'));
    assert.strictEqual(environment.XDG_DATA_HOME, path.join(runtime, 'xdg', 'data'));
    assert.strictEqual(environment.APPDATA, path.join(runtime, 'appdata', 'roaming'));
    assert.strictEqual(environment.LOCALAPPDATA, path.join(runtime, 'appdata', 'local'));
    assert.strictEqual(environment.TMPDIR, path.join(runtime, 'tmp'));
    assert.strictEqual(environment.TMP, path.join(runtime, 'tmp'));
    assert.strictEqual(environment.TEMP, path.join(runtime, 'tmp'));
    assert.strictEqual(environment.PLAYWRIGHT_BROWSERS_PATH, '/trusted/playwright-browsers');
    assert.strictEqual(environment.PUPPETEER_CACHE_DIR, '/trusted/puppeteer-cache');
    assert.strictEqual(environment.AGENT_BROWSER_ALLOWED_DOMAINS, 'example.com');
    assert.strictEqual(environment.AGENT_BROWSER_CONTENT_BOUNDARIES, '1');
    assert.strictEqual(environment.AGENT_BROWSER_NO_AUTO_DIALOG, '0');
    assert.strictEqual(environment.AGENT_BROWSER_SOCKET_DIR, path.join(runtime, 'sockets'));
    for (const key of [
      'AGENT_BROWSER_CONFIG',
      'AGENT_BROWSER_ACTION_POLICY',
      'AGENT_BROWSER_DEFAULT_TIMEOUT',
      'AGENT_BROWSER_HIDE_SCROLLBARS',
      'AGENT_BROWSER_STATE_EXPIRE_DAYS',
      'AGENT_BROWSER_ENCRYPTION_KEY',
      'AGENT_BROWSER_CDP',
      'AGENT_BROWSER_PROFILE',
      'AGENT_BROWSER_STATE',
      'AGENT_BROWSER_INIT_SCRIPTS',
      'AGENT_BROWSER_EXTENSIONS',
      'AGENT_BROWSER_PLUGINS',
      'AGENT_BROWSER_EXECUTABLE_PATH',
      'AGENT_BROWSER_ALLOW_FILE_ACCESS',
      'AGENT_BROWSER_ARGS',
      'AGENT_BROWSER_PROVIDER',
      'AGENT_BROWSER_SCREENSHOT_DIR',
    ]) {
      assert.strictEqual(environment[key], undefined, `${key} must not reach the driver`);
    }
    assert.strictEqual(environment.XIAOBA_API_KEY, undefined);
    assert.strictEqual(environment.OPENAI_API_KEY, undefined);
    assert.strictEqual(environment.FEISHU_APP_SECRET, undefined);
    assert.strictEqual(environment.WEIXIN_TOKEN, undefined);
    assert.strictEqual(environment.RANDOM_PASSWORD, undefined);
    for (const key of [
      'HOME',
      'USERPROFILE',
      'XDG_RUNTIME_DIR',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'APPDATA',
      'LOCALAPPDATA',
      'AGENT_BROWSER_SOCKET_DIR',
    ]) {
      assert.ok(environment[key]);
      assert.ok(fs.statSync(String(environment[key])).isDirectory(), `${key} must use a runtime-owned directory`);
    }

    const withoutControlledRuntime = buildDriverEnvironment({
      HOME: '/real/home',
      USERPROFILE: 'C:\\Users\\real',
      XDG_CONFIG_HOME: '/real/config',
      APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local',
    });
    assert.strictEqual(withoutControlledRuntime.HOME, undefined);
    assert.strictEqual(withoutControlledRuntime.USERPROFILE, undefined);
    assert.strictEqual(withoutControlledRuntime.XDG_CONFIG_HOME, undefined);
    assert.strictEqual(withoutControlledRuntime.APPDATA, undefined);
    assert.strictEqual(withoutControlledRuntime.LOCALAPPDATA, undefined);
  });

  test('isolates all driver processes from a hostile workspace config and cwd', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-hostile-workspace-'));
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-safe-runtime-'));
    temporaryRoots.push(workspace, runtime);
    fs.writeFileSync(path.join(workspace, 'agent-browser.json'), JSON.stringify({
      cdp: 'ws://attacker.invalid/',
      initScripts: ['/hostile/init.js'],
      plugins: [{ name: 'evil', command: '/hostile/plugin', capabilities: ['launch.mutate'] }],
      allowFileAccess: true,
    }));
    const safeConfig = path.join(runtime, 'config.json');
    fs.writeFileSync(safeConfig, '{}\n');
    const executions: Array<{ args: string[]; options: Parameters<AgentBrowserExecFile>[2] }> = [];
    const hostileEnvironment: Record<string, string> = {
      AGENT_BROWSER_CONFIG: path.join(workspace, 'agent-browser.json'),
      AGENT_BROWSER_INIT_SCRIPTS: '/hostile/init.js',
      AGENT_BROWSER_PLUGINS: '[{"name":"evil","command":"/hostile/plugin"}]',
      AGENT_BROWSER_CDP: 'ws://attacker.invalid/',
      AGENT_BROWSER_PROFILE: '/hostile/profile',
      AGENT_BROWSER_ALLOW_FILE_ACCESS: '1',
      AGENT_BROWSER_SOCKET_DIR: '/hostile/socket',
    };
    const previousEnvironment = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(hostileEnvironment)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
    const runner = new DefaultAgentBrowserRunner(
      { resolve: () => '/pinned/agent-browser' },
      async (_binary, args, options) => {
        executions.push({ args: [...args], options });
        if (args[0] === '--version') {
          return { stdout: `agent-browser ${AGENT_BROWSER_VERSION}\n`, stderr: '' };
        }
        return { stdout: JSON.stringify({ success: true, data: { ok: true } }), stderr: '' };
      },
      safeConfig,
    );

    try {
      await runner.run(['open', 'https://example.com/'], {
        sessionId: 'xb-isolated',
        cwd: workspace,
      });
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    assert.strictEqual(executions.length, 2);
    for (const execution of executions) {
      assert.strictEqual(execution.options.cwd, runtime);
      assert.notStrictEqual(execution.options.cwd, workspace);
      assert.strictEqual(execution.options.env?.AGENT_BROWSER_CONFIG, undefined);
      assert.strictEqual(execution.options.env?.AGENT_BROWSER_INIT_SCRIPTS, undefined);
      assert.strictEqual(execution.options.env?.AGENT_BROWSER_PLUGINS, undefined);
      assert.strictEqual(execution.options.env?.AGENT_BROWSER_CDP, undefined);
      assert.strictEqual(execution.options.env?.AGENT_BROWSER_PROFILE, undefined);
      assert.strictEqual(execution.options.env?.AGENT_BROWSER_ALLOW_FILE_ACCESS, undefined);
      assert.strictEqual(execution.options.env?.AGENT_BROWSER_SOCKET_DIR, path.join(runtime, 'sockets'));
    }
    assert.deepStrictEqual(executions[1].args.slice(0, 2), ['--config', safeConfig]);
  });

  test('uses the official offline quick JSON doctor contract inside the safe runtime', async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-doctor-'));
    temporaryRoots.push(runtime);
    const safeConfig = path.join(runtime, 'config.json');
    fs.writeFileSync(safeConfig, '{}\n');
    const executions: Array<{ args: string[]; cwd?: string }> = [];
    const runner = new DefaultAgentBrowserRunner(
      { resolve: () => '/pinned/agent-browser' },
      async (_binary, args, options) => {
        executions.push({ args: [...args], cwd: options.cwd });
        if (args[0] === '--version') {
          return { stdout: `agent-browser ${AGENT_BROWSER_VERSION}\n`, stderr: '' };
        }
        return { stdout: JSON.stringify({ success: true, summary: { pass: 5, fail: 0, warn: 0 } }), stderr: '' };
      },
      safeConfig,
    );

    const status = await runner.getStatus({ cwd: '/hostile/workspace' });
    assert.strictEqual(status.ready, true);
    assert.deepStrictEqual(executions[1].args, [
      '--config', safeConfig, 'doctor', '--offline', '--quick', '--json',
    ]);
    assert.strictEqual(executions[1].cwd, runtime);
  });

  test('keeps the production runtime path short enough for macOS Unix sockets', async () => {
    const runner = new DefaultAgentBrowserRunner(
      { resolve: () => '/pinned/agent-browser' },
      async (_binary, args, options) => {
        if (args[0] === '--version') {
          return { stdout: `agent-browser ${AGENT_BROWSER_VERSION}\n`, stderr: '' };
        }
        const sessionIndex = args.indexOf('--session');
        const socketRoot = options.env?.AGENT_BROWSER_SOCKET_DIR || '';
        const sessionName = sessionIndex >= 0 ? args[sessionIndex + 1] : '';
        assert.ok(`${socketRoot}/xiaoba-${sessionName}.sock`.length <= 103);
        return { stdout: JSON.stringify({ success: true, data: {} }), stderr: '' };
      },
    );

    const response = await runner.run(['open', 'https://example.com/'], {
      sessionId: 'xb-browser-12345678901234567890',
      cwd: process.cwd(),
    });
    assert.strictEqual(response.success, true);
  });
});

describe('BrowserCat typed tools', () => {
  test('isolates concurrent child sessions under one parent and direct sessions', () => {
    const childA = {
      ...toolContext('agent'),
      parentSessionId: 'parent-session',
      sessionId: 'child-session-a',
    } as ToolExecutionContext & { parentSessionId: string };
    const childB = {
      ...childA,
      sessionId: 'child-session-b',
    };
    const otherParent = {
      ...childA,
      parentSessionId: 'other-parent-session',
    };
    const directA = {
      ...toolContext('cli'),
      sessionId: 'direct-session-a',
    };
    const directB = {
      ...directA,
      sessionId: 'direct-session-b',
    };

    assert.strictEqual(deriveBrowserSessionId(childA), deriveBrowserSessionId({ ...childA }));
    assert.notStrictEqual(deriveBrowserSessionId(childA), deriveBrowserSessionId(childB));
    assert.notStrictEqual(deriveBrowserSessionId(childA), deriveBrowserSessionId(otherParent));
    assert.notStrictEqual(deriveBrowserSessionId(directA), deriveBrowserSessionId(directB));
    assert.notStrictEqual(deriveBrowserSessionId(childA), deriveBrowserSessionId(directA));
  });

  test('rejects non-http URLs, embedded credentials, and invalid element refs', async () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://user:secret@example.com/',
    ]) {
      assert.throws(() => validateHttpUrl(url));
    }

    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const open = toolByName(tools, 'browser_open');
    const click = toolByName(tools, 'browser_click');
    const context = toolContext();
    const blockedUrl = asOutput(await open.execute({ url: 'file:///etc/passwd' }, context));
    assert.strictEqual(blockedUrl.status, 'blocked');
    assert.strictEqual(blockedUrl.error_code, 'BROWSER_URL_SCHEME_BLOCKED');

    const invalidRef = asOutput(await click.execute({ ref: '@e1; rm -rf /' }, context));
    assert.strictEqual(invalidRef.status, 'blocked');
    assert.strictEqual(invalidRef.error_code, 'BROWSER_INVALID_REF');
    assert.strictEqual(fake.calls.length, 0);
  });

  test('accepts both driver eN refs and snapshot @eN refs without discarding a valid snapshot', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const snapshot = toolByName(tools, 'browser_snapshot');
    const sequence = toolByName(tools, 'browser_action_sequence');
    const context = toolContext();
    fake.responses.push({
      success: true,
      data: {
        snapshot: '- textbox "Token" [ref=e3]\n- button "Run Check" [ref=e2]',
        refs: { e3: { role: 'textbox', name: 'Token' }, e2: { role: 'button', name: 'Run Check' } },
      },
    });
    assert.strictEqual(asOutput(await snapshot.execute({}, context)).status, 'success');

    const invalid = asOutput(await sequence.execute({ actions: [{ action: 'click', ref: 'bad' }] }, context));
    assert.strictEqual(invalid.status, 'blocked');

    fake.responses.push(
      { success: true, data: { filled: '@e3' } },
      { success: true, data: { clicked: '@e2' } },
      { success: true, data: { snapshot: '- paragraph "READY"' } },
    );
    const output = asOutput(await sequence.execute({
      actions: [
        { action: 'fill', ref: 'e3', text: 'value' },
        { action: 'click', ref: 'e2' },
      ],
    }, context));
    assert.strictEqual(output.status, 'success');
    assert.deepStrictEqual(fake.calls.at(-3)?.command, ['fill', '@e3', 'value']);
    assert.deepStrictEqual(fake.calls.at(-2)?.command, ['click', '@e2']);
  });

  test('marks snapshots untrusted, preserves fill text as one argv item, and blocks password/risky refs', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const snapshot = toolByName(tools, 'browser_snapshot');
    const fill = toolByName(tools, 'browser_fill');
    const click = toolByName(tools, 'browser_click');
    const confirmedClick = toolByName(tools, 'browser_click_confirmed');
    const snapshotText = [
      '- textbox "Email" [ref=e1]',
      '- textbox "Password" [ref=e2]',
      '- button "Open details" [ref=e3]',
      '- button "Delete account" [ref=e4]',
    ].join('\n');
    fake.responses.push({
      success: true,
      data: { snapshot: snapshotText, origin: 'https://example.com' },
      _boundary: { nonce: 'nonce', origin: 'https://example.com' },
    });

    const snapshotOutput = asOutput(await snapshot.execute({}, context));
    assert.strictEqual(snapshotOutput.status, 'success');
    assert.match(String(snapshotOutput.toolContent), /untrusted_web_content/);
    assert.match(String(snapshotOutput.toolContent), /"ref_count":4/);

    const hostileText = 'hello"; $(touch /tmp/not-executed)';
    const fillOutput = asOutput(await fill.execute({ ref: '@e1', text: hostileText }, context));
    assert.strictEqual(fillOutput.status, 'success');
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['fill', '@e1', hostileText]);

    fake.responses.push({ success: true, data: { snapshot: snapshotText, origin: 'https://example.com' } });
    await snapshot.execute({}, context);

    const passwordOutput = asOutput(await fill.execute({ ref: '@e2', text: 'secret' }, context));
    assert.strictEqual(passwordOutput.status, 'blocked');
    assert.strictEqual(passwordOutput.error_code, 'BROWSER_SENSITIVE_INPUT_BLOCKED');

    const riskyOutput = asOutput(await click.execute({ ref: '@e4' }, context));
    assert.strictEqual(riskyOutput.status, 'blocked');
    assert.strictEqual(riskyOutput.error_code, 'BROWSER_CONFIRMATION_REQUIRED');

    const subagentConfirmed = asOutput(await confirmedClick.execute({
      ref: '@e4',
      action_summary: 'Delete account',
      confirmed: true,
    }, toolContext('agent')));
    assert.strictEqual(subagentConfirmed.status, 'blocked');
    assert.strictEqual(subagentConfirmed.error_code, 'BROWSER_TRUSTED_CONFIRMATION_UNAVAILABLE');

    const safeOutput = asOutput(await click.execute({ ref: '@e3' }, context));
    assert.strictEqual(safeOutput.status, 'success');
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['click', '@e3']);
  });

  test('executes a bounded safe action sequence and automatically returns a fresh snapshot', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const snapshot = toolByName(tools, 'browser_snapshot');
    const sequence = toolByName(tools, 'browser_action_sequence');
    fake.responses.push({
      success: true,
      data: { snapshot: '- textbox "Name" [ref=e1]\n- button "Next Page" [ref=e2]' },
    });
    await snapshot.execute({}, context);
    fake.responses.push(
      { success: true, data: { action: 'fill' } },
      { success: true, data: { action: 'click' } },
      {
        success: true,
        data: { snapshot: '- heading "Done"\n- link "Details" [ref=e3]', origin: 'https://example.com/done' },
      },
    );

    const output = asOutput(await sequence.execute({
      actions: [
        { action: 'fill', ref: '@e1', text: 'XiaoBa' },
        { action: 'click', ref: '@e2' },
      ],
    }, context));
    const result = JSON.parse(String(output.toolContent));

    assert.strictEqual(output.status, 'success');
    assert.strictEqual(result.state, 'applied_and_observed');
    assert.strictEqual(result.completed_steps, 2);
    assert.strictEqual(result.ref_count, 1);
    assert.deepStrictEqual(fake.calls.slice(-3).map(call => call.command), [
      ['fill', '@e1', 'XiaoBa'],
      ['click', '@e2'],
      ['snapshot', '-i'],
    ]);
  });

  test('blocks sensitive or consequential targets before a browser action sequence reaches the driver', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const snapshot = toolByName(tools, 'browser_snapshot');
    const sequence = toolByName(tools, 'browser_action_sequence');
    fake.responses.push({
      success: true,
      data: { snapshot: '- textbox "Password" [ref=e1]\n- button "Delete account" [ref=e2]' },
    });
    await snapshot.execute({}, context);

    const password = asOutput(await sequence.execute({
      actions: [{ action: 'fill', ref: '@e1', text: 'secret' }],
    }, context));
    assert.strictEqual(password.status, 'blocked');
    assert.strictEqual(password.error_code, 'BROWSER_SENSITIVE_INPUT_BLOCKED');

    fake.responses.push({
      success: true,
      data: { snapshot: '- textbox "Password" [ref=e1]\n- button "Delete account" [ref=e2]' },
    });
    await snapshot.execute({}, context);
    const risky = asOutput(await sequence.execute({ actions: [{ action: 'click', ref: '@e2' }] }, context));
    assert.strictEqual(risky.status, 'blocked');
    assert.strictEqual(risky.error_code, 'BROWSER_CONFIRMATION_REQUIRED');
    assert.strictEqual(fake.calls.length, 2, 'only the two snapshots should reach the driver');
  });

  test('uses the official snapshot refs object when snapshot text does not inline ref metadata', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const snapshot = toolByName(tools, 'browser_snapshot');
    const fill = toolByName(tools, 'browser_fill');
    const click = toolByName(tools, 'browser_click');
    fake.responses.push({
      success: true,
      data: {
        snapshot: '- textbox "masked field"\n- button "destructive action"',
        origin: 'https://example.com',
        refs: {
          e1: { role: 'textbox', name: 'Password' },
          e2: { role: 'button', name: 'Delete account' },
        },
      },
    });

    const snapshotOutput = asOutput(await snapshot.execute({}, context));
    assert.match(String(snapshotOutput.toolContent), /"ref_count":2/);
    const passwordOutput = asOutput(await fill.execute({ ref: '@e1', text: 'secret' }, context));
    const riskyOutput = asOutput(await click.execute({ ref: '@e2' }, context));
    assert.strictEqual(passwordOutput.error_code, 'BROWSER_SENSITIVE_INPUT_BLOCKED');
    assert.strictEqual(riskyOutput.error_code, 'BROWSER_CONFIRMATION_REQUIRED');
    assert.strictEqual(fake.calls.length, 1, 'blocked refs must not reach the driver');
  });

  test('fails closed for unnamed or ambiguous buttons while allowing clearly safe navigation', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const snapshot = toolByName(tools, 'browser_snapshot');
    const click = toolByName(tools, 'browser_click');
    const refs = {
      e1: { role: 'button', name: 'Continue' },
      e2: { role: 'button', name: 'Confirm' },
      e3: { role: 'button', name: 'Save' },
      e4: { role: 'button', name: 'Accept' },
      e5: { role: 'button', name: 'Checkout' },
      e6: { role: 'button', name: 'Yes' },
      e7: { role: 'button', name: 'OK' },
      e8: { role: 'button', name: '' },
      e9: { role: 'button', name: 'Open' },
      e10: { role: 'button', name: 'Next Page' },
    };
    const response: AgentBrowserResponse = {
      success: true,
      data: { snapshot: '- controls without inline ref names', refs },
    };
    fake.responses.push(response);
    await snapshot.execute({}, context);

    for (const ref of ['@e1', '@e2', '@e3', '@e4', '@e5', '@e6', '@e7', '@e8']) {
      const output = asOutput(await click.execute({ ref }, context));
      assert.strictEqual(output.status, 'blocked', ref);
      assert.strictEqual(output.error_code, 'BROWSER_CONFIRMATION_REQUIRED', ref);
    }
    assert.strictEqual(fake.calls.length, 1, 'ambiguous buttons must not reach the driver');

    const openOutput = asOutput(await click.execute({ ref: '@e9' }, context));
    assert.strictEqual(openOutput.status, 'success');
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['click', '@e9']);

    fake.responses.push(response);
    await snapshot.execute({}, context);
    const nextPageOutput = asOutput(await click.execute({ ref: '@e10' }, context));
    assert.strictEqual(nextPageOutput.status, 'success');
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['click', '@e10']);
  });

  test('blocks dangerous shell commands from being entered into web terminals or cloud consoles', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const snapshot = toolByName(tools, 'browser_snapshot');
    const fill = toolByName(tools, 'browser_fill');
    fake.responses.push({
      success: true,
      data: { snapshot: '- textbox "Cloud Shell terminal" [ref=e1]' },
    });
    await snapshot.execute({}, context);

    for (const command of [
      'rm -rf /tmp/example',
      'rm -r -f /tmp/example',
      'rm --force --recursive /tmp/example',
      'sudo apt-get remove package',
      'mkfs.ext4 /dev/sda',
      'diskutil eraseDisk APFS Empty /dev/disk2',
      'shutdown -h now',
      'reboot',
      'powershell -Command Remove-Item C:\\Data',
      'cmd /c del /s /q C:\\Data',
      'Remove-Item C:\\Data -Force -Recurse',
    ]) {
      const output = asOutput(await fill.execute({ ref: '@e1', text: command }, context));
      assert.strictEqual(output.status, 'blocked', command);
      assert.strictEqual(output.error_code, 'BROWSER_DANGEROUS_SHELL_TEXT_BLOCKED', command);
    }

    const safe = asOutput(await fill.execute({
      ref: '@e1',
      text: 'Please remove the old cache directory after the review.',
    }, context));
    assert.strictEqual(safe.status, 'success');
    assert.strictEqual(fake.calls.length, 2, 'only snapshot and the safe fill should reach the driver');
  });

  test('blocks option-like fill/select/wait values instead of letting the CLI reinterpret them as flags', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const snapshot = toolByName(tools, 'browser_snapshot');
    const fill = toolByName(tools, 'browser_fill');
    const select = toolByName(tools, 'browser_select');
    const wait = toolByName(tools, 'browser_wait');
    fake.responses.push({
      success: true,
      data: { snapshot: '- textbox "Amount" [ref=e1]\n- combobox "Choice" [ref=e2]' },
    });
    await snapshot.execute({}, context);

    const fillOutput = asOutput(await fill.execute({ ref: '@e1', text: '--json' }, context));
    const selectOutput = asOutput(await select.execute({ ref: '@e2', value: '-v' }, context));
    const waitOutput = asOutput(await wait.execute({ kind: 'text', value: '--url' }, context));
    assert.strictEqual(fillOutput.error_code, 'BROWSER_OPTION_LIKE_VALUE_BLOCKED');
    assert.strictEqual(selectOutput.error_code, 'BROWSER_OPTION_LIKE_VALUE_BLOCKED');
    assert.strictEqual(waitOutput.error_code, 'BROWSER_OPTION_LIKE_VALUE_BLOCKED');
    assert.strictEqual(fake.calls.length, 1, 'only the snapshot should reach the driver');
  });

  test('marks mutating command timeouts as unknown outcome and non-retryable', async () => {
    const fake = new FakeRunner();
    const open = toolByName(createBrowserCatTools({ runner: fake }), 'browser_open');
    fake.errors.push(new AgentBrowserDriverError('BROWSER_DRIVER_TIMEOUT', 'open timed out'));

    const output = asOutput(await open.execute({ url: 'https://example.com/' }, toolContext()));
    assert.strictEqual(output.status, 'timeout');
    assert.strictEqual(output.error_code, 'BROWSER_ACTION_OUTCOME_UNKNOWN');
    assert.strictEqual(output.retryable, false);
    assert.match(String(output.toolContent), /outcome is unknown/i);
  });

  test('treats scroll timeouts as unknown outcomes because the page may already have moved', async () => {
    const fake = new FakeRunner();
    const scroll = toolByName(createBrowserCatTools({ runner: fake }), 'browser_scroll');
    fake.errors.push(new AgentBrowserDriverError('BROWSER_DRIVER_TIMEOUT', 'scroll timed out'));

    const output = asOutput(await scroll.execute({ direction: 'down', pixels: 700 }, toolContext()));
    assert.strictEqual(output.status, 'timeout');
    assert.strictEqual(output.error_code, 'BROWSER_ACTION_OUTCOME_UNKNOWN');
    assert.strictEqual(output.retryable, false);
  });

  test('maps select, scroll, wait, tab, open and close without arbitrary arguments', async () => {
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const context = toolContext();
    const open = toolByName(tools, 'browser_open');
    const snapshot = toolByName(tools, 'browser_snapshot');
    const select = toolByName(tools, 'browser_select');
    const scroll = toolByName(tools, 'browser_scroll');
    const wait = toolByName(tools, 'browser_wait');
    const tab = toolByName(tools, 'browser_tab');
    const close = toolByName(tools, 'browser_close');

    await open.execute({ url: 'https://example.com/path?q=one', headed: true }, context);
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['open', 'https://example.com/path?q=one']);
    assert.strictEqual(fake.calls.at(-1)?.options.headed, true);

    fake.responses.push({ success: true, data: { snapshot: '- combobox "Country" [ref=e5]' } });
    await snapshot.execute({}, context);
    await select.execute({ ref: '@e5', value: 'CN' }, context);
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['select', '@e5', 'CN']);

    await scroll.execute({ direction: 'down', pixels: 900 }, context);
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['scroll', 'down', '900']);

    await wait.execute({ kind: 'text', value: 'Loaded' }, context);
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['wait', '--text', 'Loaded']);

    await tab.execute({ action: 'new', label: 'docs', url: 'https://example.com/docs' }, context);
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['tab', 'new', '--label', 'docs', 'https://example.com/docs']);
    await tab.execute({ action: 'switch', tab_id: 't2' }, context);
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['tab', 't2']);
    await close.execute({}, context);
    assert.deepStrictEqual(fake.calls.at(-1)?.command, ['close']);
  });

  test('writes screenshots only under output/browser-cat and exposes tool-owned artifact evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-browser-cat-'));
    temporaryRoots.push(root);
    const fake = new FakeRunner();
    const tools = createBrowserCatTools({ runner: fake });
    const screenshot = toolByName(tools, 'browser_screenshot') as BrowserScreenshotTool;
    const context = toolContext('cli', root);

    const output = asOutput(await screenshot.execute({ full: true, annotate: true }, context));
    assert.strictEqual(output.status, 'success');
    const payload = JSON.parse(String(output.toolContent));
    assert.match(payload.artifact_path, /^output\/browser-cat\/xb-browser-[a-f0-9]{20}\/shot-/);
    const command = fake.calls.at(-1)?.command || [];
    assert.strictEqual(command[0], 'screenshot');
    assert.ok(path.resolve(command[1]).startsWith(path.resolve(root, 'output', 'browser-cat') + path.sep));
    assert.deepStrictEqual(command.slice(2), ['--full', '--annotate']);

    const manifest = screenshot.getArtifactManifest?.({}, output, context) || [];
    assert.deepStrictEqual(manifest.map(item => item.path), [payload.artifact_path]);
    assert.strictEqual(manifest[0].metadata?.source, 'tool_owned');
  });

  test('reports pinned fake driver status without exposing its absolute binary path', async () => {
    const fake = new FakeRunner();
    const status = toolByName(createBrowserCatTools({ runner: fake }), 'browser_driver_status');
    const output = asOutput(await status.execute({}, toolContext()));
    const payload = JSON.parse(String(output.toolContent));

    assert.strictEqual(payload.ready, true);
    assert.strictEqual(payload.version, AGENT_BROWSER_VERSION);
    assert.strictEqual(payload.binaryPath, undefined);
    assert.deepStrictEqual(payload.doctor_summary, { pass: 5, fail: 0, warn: 0 });
  });
});

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find(candidate => candidate.definition.name === name);
  assert.ok(tool, `Missing BrowserCat tool ${name}`);
  return tool;
}

function toolContext(
  surface: ToolExecutionContext['surface'] = 'cli',
  workingDirectory = process.cwd(),
): ToolExecutionContext {
  return {
    workingDirectory,
    conversationHistory: [],
    sessionId: 'parent-session-1',
    roleName: 'browser-cat',
    surface,
  };
}

function asOutput(value: unknown): ToolExecutionOutput {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && 'toolContent' in value);
  return value as ToolExecutionOutput;
}
