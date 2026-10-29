import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { createChatFixture, until } from '../helpers/intelligent-chat-fixture';

test('desktop/mobile Chat: real AppBridge, form action, live child, persistent Main conversation and reload', { timeout: 90_000 }, async () => {
  const repository = process.cwd(), output = path.join(repository, 'output/test/intelligent-chat');
  fs.mkdirSync(output, { recursive: true });
  const fixture = await createChatFixture();
  const browser = await chromium.launch({ ...(process.env.XIAOBA_BROWSER_EXECUTABLE ? { executablePath: process.env.XIAOBA_BROWSER_EXECUTABLE } : {}), headless: true, args: ['--no-proxy-server'] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('xiaoba.dashboard.lang.v2', 'zh'); });
    await page.goto(fixture.url + '/?page=pet', { waitUntil: 'domcontentloaded' });
    await page.locator('#chat-connection.connected').waitFor();
    assert.equal(await page.locator('#page-pet textarea').count(), 1);
    await page.locator('#chat-input').fill('分析本周项目进展');
    await page.locator('#chat-send').click();
    await page.getByRole('button', { name: '更新分析', exact: true }).waitFor();
    await page.locator('.chat-tool[data-status="completed"]').waitFor();
    const app = page.frameLocator('.chat-app-card iframe');
    await app.locator('#data').filter({ hasText: '项目进度' }).waitFor();
    await until(async () => (await page.locator('.chat-app-card > .chat-muted').getAttribute('hidden')) !== null);
    assert.equal(await app.locator('html').getAttribute('data-host-theme'), 'light');
    assert.equal(await app.locator('html').evaluate(element => element.style.getPropertyValue('--color-text-primary')), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text').trim()));
    assert.equal(fixture.counters.reads, 1);
    await page.locator('#chat-scroll').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(output, 'conversation-desktop.png'), fullPage: true });
    const beforeContext = fixture.ai.requests.length;
    const contextResponse = page.waitForResponse(response => response.url().endsWith('/rpc') && response.request().postDataJSON()?.method === 'ui/update-model-context');
    await app.getByRole('button', { name: '选择 Surface', exact: true }).click();
    assert.equal((await contextResponse).status(), 200);
    assert.equal(fixture.ai.requests.length, beforeContext);
    await page.getByLabel('项目', { exact: true }).fill('another-project');
    await page.getByLabel('时间', { exact: true }).selectOption('month');
    await page.getByRole('button', { name: '更新分析', exact: true }).click();
    await page.getByText('范围已更新，我会按你提交的项目与时间继续分析。', { exact: true }).waitFor();
    assert.ok(fixture.ai.requests.some(request => request.messages.some((message: any) => message.role === 'system' && String(message.content).includes('selectedModule'))));
    await app.getByRole('button', { name: '刷新数据', exact: true }).click();
    await until(() => fixture.counters.reads === 2);
    await app.getByRole('button', { name: '写入测试', exact: true }).click();
    await app.getByText('写操作已被阻止', { exact: true }).waitFor();
    assert.equal(fixture.counters.writes, 0);
    const requests = fixture.ai.requests.length, reads = fixture.counters.reads;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '更新分析', exact: true }).waitFor();
    await until(async () => await page.getByLabel('项目', { exact: true }).inputValue() === 'another-project');
    assert.equal(await page.getByLabel('时间', { exact: true }).inputValue(), 'month');
    await page.frameLocator('.chat-app-card iframe').locator('#data').waitFor();
    assert.equal(fixture.ai.requests.length, requests);
    assert.equal(fixture.counters.reads, reads);
    assert.equal(await page.locator('#chat-new, #chat-new-mobile, .chat-session, .chat-history-menu').count(), 0);
    const freshContext = await browser.newContext();
    try {
      await freshContext.addInitScript(() => {
        if (window === window.top) {
          localStorage.setItem('xiaoba.dashboard.lang.v2', 'zh');
          localStorage.setItem('xiaoba.chat.thread.v1', 'chat:obsolete-browser-selection');
        }
      });
      const freshPage = await freshContext.newPage();
      freshPage.on('pageerror', error => errors.push(error.message));
      await freshPage.goto(fixture.url + '/?page=pet', { waitUntil: 'domcontentloaded' });
      await freshPage.locator('#chat-connection.connected').waitFor();
      await freshPage.getByText('分析本周项目进展', { exact: true }).waitFor();
      await until(async () => await freshPage.getByLabel('项目', { exact: true }).inputValue() === 'another-project');
      assert.equal(await freshPage.evaluate(() => (window as any).XiaoBaChat.threadId), await page.evaluate(() => (window as any).XiaoBaChat.threadId));
      assert.equal(await freshPage.locator('#chat-new, #chat-new-mobile, .chat-session, .chat-history-menu').count(), 0);
      assert.equal(fixture.ai.requests.length, requests);
      assert.equal(fixture.counters.reads, reads);
    } finally { await freshContext.close(); }
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const composer = document.querySelector('#chat-form')!.getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, composer: { top: composer.top, bottom: composer.bottom, right: composer.right } };
      });
      await page.screenshot({ path: path.join(output, `conversation-${viewport.width}.png`), fullPage: true });
      assert.ok(layout.documentWidth <= layout.width, `Horizontal overflow: ${JSON.stringify(layout)}`);
      assert.ok(layout.composer.bottom <= layout.height && layout.composer.top >= 0, `Composer outside viewport: ${JSON.stringify(layout)}`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await fixture.close(); }
});
