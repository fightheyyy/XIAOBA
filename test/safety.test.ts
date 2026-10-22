import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { isBashCommandAllowed } from '../src/runtime/sandbox/safety';
import { ShellTool } from '../src/capabilities/tools/bash-tool';

const ORIGINAL_OVERRIDE = process.env.XIAOBA_BASH_ALLOW_DANGEROUS;

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.XIAOBA_BASH_ALLOW_DANGEROUS;
  } else {
    process.env.XIAOBA_BASH_ALLOW_DANGEROUS = ORIGINAL_OVERRIDE;
  }
});

describe('dangerous shell command guard', () => {
  test('blocks recursive force deletion regardless of flag spelling or target', () => {
    for (const command of [
      'rm -rf /',
      'rm -fr ./build-cache',
      'rm -r -f "$HOME/Documents"',
      'rm --recursive --force ./workspace',
      'rm --force --recursive /tmp/example',
    ]) {
      const decision = isBashCommandAllowed(command);
      assert.equal(decision.allowed, false, command);
      assert.match(decision.reason || '', /recursive \+ force|rm/i);
    }
  });

  test('does not block ordinary remove commands and keeps the explicit break-glass override', () => {
    assert.equal(isBashCommandAllowed('rm ./single-file.txt').allowed, true);
    assert.equal(isBashCommandAllowed('rm -r ./generated-docs').allowed, true);

    process.env.XIAOBA_BASH_ALLOW_DANGEROUS = 'true';
    assert.equal(isBashCommandAllowed('rm -rf ./workspace').allowed, true);
  });

  test('execute_shell returns a structured blocked result before spawning a shell', async () => {
    const result = await new ShellTool().execute({ command: 'rm -rf ./workspace' }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
      surface: 'cli',
    });

    assert.equal(result.status, 'blocked');
    assert.equal(result.error_code, 'COMMAND_BLOCKED');
    assert.equal(result.retryable, false);
  });
});
