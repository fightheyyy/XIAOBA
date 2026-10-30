import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { OpenAIProvider } from '../src/runtime/harness/models/openai-provider';
import axios from 'axios';
import { Readable } from 'node:stream';

test('stream preserves Chinese text and tool arguments when UTF-8 characters span chunks', async () => {
  const original = axios.post;
  const text = '别急，我们先把一小时用好。🐈';
  const args = JSON.stringify({ text: '按一小时准备项目。' });
  const wire = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: text, tool_calls: [{ index: 0, id: 'reply', function: { name: 'send_text', arguments: args } }] } }] }) + '\n\ndata: [DONE]\n\n');
  (axios as any).post = async () => ({ data: Readable.from([...wire].map(byte => Buffer.from([byte]))) });
  try {
    const provider = new OpenAIProvider({ apiUrl: 'http://localhost/v1', apiKey: 'test' });
    const deltas: string[] = [];
    const response = await provider.chatStream([{ role: 'user', content: '有点慌' }], undefined, { onText: delta => deltas.push(delta) });
    assert.strictEqual(response.content, text);
    assert.strictEqual(deltas.join(''), text);
    assert.strictEqual(response.toolCalls?.[0].function.arguments, args);
  } finally { axios.post = original; }
});

describe('OpenAIProvider endpoint normalization', () => {
  test('runtime state markers remain local while the model receives their content', () => {
    const provider = new OpenAIProvider({ apiUrl: 'http://localhost/v1', apiKey: 'test' });
    const message = { role: 'user', content: '[subagent_state] []', __injected: true, __subagentState: true };
    const body = (provider as any).buildRequestBody([message]);
    assert.deepStrictEqual(body.messages, [{ role: 'user', content: '[subagent_state] []' }]);
    assert.strictEqual(message.__injected, true);
  });
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
