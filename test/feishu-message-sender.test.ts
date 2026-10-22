import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { MessageSender } from '../src/surfaces/feishu/message-sender';

class FakeFeishuClient {
  readonly calls: any[] = [];

  constructor(private readonly behavior: 'success' | 'failure') {}

  im = {
    v1: {
      message: {
        create: async (payload: any): Promise<any> => {
          this.calls.push(payload);
          if (this.behavior === 'failure') {
            throw new Error('feishu unavailable');
          }
          return { data: { message_id: `om_${this.calls.length}` } };
        },
      },
      file: {
        create: async (): Promise<any> => ({ file_key: 'file-key' }),
      },
      messageResource: {
        get: async (): Promise<any> => ({ writeFile: async () => {} }),
      },
    },
  };
}

describe('Feishu MessageSender', () => {
  test('returns delivery receipts for successful text replies', async () => {
    const client = new FakeFeishuClient('success');
    const sender = new MessageSender(client as any);

    const receipts = await sender.reply('oc_chat', 'hello');

    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'delivered');
    assert.equal(receipts[0].receipt_type, 'message');
    assert.equal(receipts[0].platform_message_id, 'om_1');
  });

  test('rejects text reply failures instead of returning empty delivery receipts', async () => {
    const client = new FakeFeishuClient('failure');
    const sender = new MessageSender(client as any);

    await assert.rejects(
      () => sender.reply('oc_chat', 'hello'),
      /feishu unavailable/,
    );
  });
});
