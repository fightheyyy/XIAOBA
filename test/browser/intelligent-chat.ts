import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { createChatFixture, until } from '../helpers/intelligent-chat-fixture';
import { SkillManager } from '../../src/capabilities/skills/skill-manager';

test('one work indicator survives intervening chat and reload until Main handles the result', { timeout: 60_000 }, async () => {
  const output = path.resolve('output/test/work-indicator'); fs.mkdirSync(output, { recursive: true });
  const fixture = await createChatFixture();
  let releaseChild!: (response: any) => void, releaseFeedback!: () => void;
  const child = new Promise<any>(resolve => { releaseChild = resolve; });
  const feedback = new Promise<void>(resolve => { releaseFeedback = resolve; });
  fixture.toolManager.setContextDefaults({ subAgentServiceFactory: () => ({
    aiService: { chatStream: async () => child, chat: async () => child } as any,
    skillManager: new SkillManager('base'),
  }) });
  const original = fixture.ai.chatStream.bind(fixture.ai);
  let other = 0;
  fixture.ai.chatStream = async (messages: any[], tools: any[]) => {
    const text = String([...messages].reverse().find(message => message.role === 'user' && !message.__subagentState)?.content || '');
    if (text.startsWith('[子智能体')) await feedback;
    if (text === '另一个问题') return ++other === 1 ? { content: null, toolCalls: [{ id: randomUUID(), type: 'function', function: { name: 'send_text', arguments: JSON.stringify({ text: '当然可以，我们继续聊。' }) } }] } : { content: '' };
    return original(messages, tools);
  };
  const browser = await chromium.launch({ ...(process.env.XIAOBA_BROWSER_EXECUTABLE ? { executablePath: process.env.XIAOBA_BROWSER_EXECUTABLE } : {}), headless: true, args: ['--no-proxy-server'] });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('xiaoba.dashboard.lang.v2', 'zh'); });
    await page.goto(fixture.url + '/?page=pet'); await page.locator('#chat-connection.connected').waitFor();
    const send = async (text: string) => { await page.locator('#chat-input').fill(text); await page.locator('#chat-send').click(); };
    await send('分析本周项目进展');
    await page.getByText('当前进展已整理好，后台核验仍在继续。你可以调整范围，或继续告诉我下一步。', { exact: true }).waitFor();
    await until(() => page.locator('#chat-stop').isHidden());
    await page.locator('#chat-work-label').filter({ hasText: '核对项目进展' }).waitFor();
    assert.ok(await page.locator('#chat-send').isEnabled());
    await send('另一个问题'); await page.getByText('当然可以，我们继续聊。', { exact: true }).waitFor();
    await until(() => page.locator('#chat-stop').isHidden());
    assert.ok(await page.locator('#chat-work').isVisible());
    await page.reload(); await page.locator('#chat-connection.connected').waitFor();
    await page.locator('#chat-work-label').filter({ hasText: '核对项目进展' }).waitFor();
    await page.locator('#chat-scroll').evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(output, 'working-desktop.png'), fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.chat-work-orbit span').evaluate(element => getComputedStyle(element).animationName), 'none');
    for (const width of [390, 844]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 390 });
      assert.ok(await page.locator('#chat-work').isVisible());
      const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bottom: document.querySelector('#chat-form')!.getBoundingClientRect().bottom, height: innerHeight }));
      assert.ok(layout.documentWidth <= layout.width); assert.ok(layout.bottom <= layout.height);
      await page.screenshot({ path: path.join(output, `working-${width}.png`), fullPage: true });
    }
    releaseChild({ content: '核验完成，资料一致。' });
    await page.locator('#chat-work-label').filter({ hasText: '正在整理结果' }).waitFor();
    assert.equal(await page.locator('.chat-tools, .chat-tool, .chat-subagent-progress').count(), 0);
    releaseFeedback();
    await page.getByText('检查已经完成，关键结论已核对。', { exact: true }).waitFor();
    await until(() => page.locator('#chat-work').isHidden());
    assert.deepEqual(errors, []);
  } finally { releaseChild({ content: 'done' }); releaseFeedback(); await browser.close(); await fixture.close(); }
});

test('busy Main replies follow the steering message, and failed UI delivery stays visible', { timeout: 45_000 }, async () => {
  const fixture = await createChatFixture();
  const browser = await chromium.launch({ ...(process.env.XIAOBA_BROWSER_EXECUTABLE ? { executablePath: process.env.XIAOBA_BROWSER_EXECUTABLE } : {}), headless: true, args: ['--no-proxy-server'] });
  let release!: (response: any) => void;
  const held = new Promise<any>(resolve => { release = resolve; });
  let calls = 0;
  const tool = (name: string, args: any) => ({ content: null, toolCalls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  fixture.ai.chatStream = async () => {
    calls++;
    if (calls === 1) return tool('send_text', { text: '已开始，可以继续补充。' });
    if (calls === 2) return held;
    if (calls === 3) return tool('send_text', { text: '收到，预算改为300。' });
    if (calls === 5) return tool('send_ui', { messages: [{ version: 'v0.9.1', createSurface: { surfaceId: 'bad', catalogId: 'unsupported' } }] });
    return { content: '' };
  };
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('xiaoba.dashboard.lang.v2', 'zh'));
    await page.goto(fixture.url + '/?page=pet');
    await page.locator('#chat-connection.connected').waitFor();
    const send = async (text: string) => { await page.locator('#chat-input').fill(text); await page.locator('#chat-send').click(); };
    await send('审查发布计划');
    await page.getByText('已开始，可以继续补充。', { exact: true }).waitFor();
    await until(() => calls === 2);
    await send('预算改为300');
    await page.getByText('预算改为300', { exact: true }).waitFor();
    release({ content: '过时的1000元草稿' });
    await page.getByText('收到，预算改为300。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => {
      const user = [...document.querySelectorAll('.chat-user-message')].find(node => node.textContent === '预算改为300')!;
      const reply = [...document.querySelectorAll('.chat-text')].find(node => node.textContent === '收到，预算改为300。')!;
      return Boolean(user.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true);
    assert.equal(await page.getByText('过时的1000元草稿', { exact: true }).count(), 0);
    await until(() => page.locator('#chat-stop').isHidden());
    await send('渲染无效卡片');
    await page.locator('.chat-notice').filter({ hasText: '这次没能显示内容' }).waitFor();
    await page.reload();
    await page.locator('.chat-notice').filter({ hasText: '这次没能显示内容' }).waitFor();
  } finally { release({ content: '' }); await browser.close(); await fixture.close(); }
});

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
    await page.getByText('检查已经完成，关键结论已核对。', { exact: true }).waitFor();
    assert.equal(await page.locator('.chat-tools, .chat-tool, .chat-subagent-progress').count(), 0);
    assert.equal(await page.locator('.chat-turn').filter({ has: page.locator('.chat-turn-body:empty') }).count(), 0);
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
    assert.equal(await page.locator('.chat-tools, .chat-tool, .chat-subagent-progress').count(), 0);
    await page.getByText('已提交：更新分析', { exact: true }).waitFor();
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
