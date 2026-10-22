import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { OpenAIProvider } from '../src/runtime/harness/models/openai-provider';

describe('OpenAIProvider endpoint normalization', () => {
  test('accepts an OpenAI-compatible /v1 base URL', () => {
    const provider = new OpenAIProvider({
      apiUrl: 'http://127.0.0.1:8317/v1',
      apiKey: 'test-key',
      model: 'gpt-test',
      provider: 'openai',
    });

    assert.strictEqual(
      (provider as any).apiUrl,
      'http://127.0.0.1:8317/v1/chat/completions',
    );
  });

  test('keeps a complete chat completions endpoint unchanged', () => {
    const provider = new OpenAIProvider({
      apiUrl: 'https://api.openai.com/v1/chat/completions/',
      apiKey: 'test-key',
      model: 'gpt-test',
      provider: 'openai',
    });

    assert.strictEqual(
      (provider as any).apiUrl,
      'https://api.openai.com/v1/chat/completions',
    );
  });
});
