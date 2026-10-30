import { A2UIView } from './a2ui-view.js';
import { McpAppView } from './mcp-view.js';

const node = (tag, cls, text) => {
  const result = document.createElement(tag); if (cls) result.className = cls;
  if (text !== undefined) result.textContent = String(text ?? ''); return result;
};
const translations = {
  zh: { working: '正在处理你的消息', background: '正在处理', gathering: '正在整理结果', confirming: '正在确认细节', paused: '还没处理完，可以让我继续', continueChat: '你可以继续聊', moreWork: '另有 {count} 件事处理中', submitted: '已提交：', submittedChoice: '已提交选择', deliveryFailed: '这次没能显示内容，请再试一次。', welcome: '今天想一起做点什么？', introduction: '告诉 XiaoBa 你的目标，进展和结果都会留在这段对话里。', placeholder: '告诉 XiaoBa 你接下来想做什么…', footer: '由 XiaoBa 统一处理 · Enter 发送，Shift + Enter 换行', send: '发送', stop: '停止当前回复', online: '已连接', offline: '正在重连…', missing: '请求失败，请重试', suggestion1: '整理本周项目进展', suggestion2: '帮我分析一份资料', suggestion3: '把想法变成可执行的计划' },
  en: { working: 'Working on your message', background: 'Working on', gathering: 'Putting the results together', confirming: 'Checking a few details', paused: 'There’s more to do. Ask me to continue.', continueChat: 'You can keep chatting', moreWork: '{count} more in progress', submitted: 'Submitted: ', submittedChoice: 'Selection submitted', deliveryFailed: 'I couldn’t display that. Please try again.', welcome: 'What shall we work on?', introduction: 'Tell XiaoBa your goal. Progress and results stay in this conversation.', placeholder: 'Tell XiaoBa what you want to do next…', footer: 'Handled by XiaoBa · Enter to send, Shift + Enter for a new line', send: 'Send', stop: 'Stop current response', online: 'Connected', offline: 'Reconnecting…', missing: 'Request failed. Try again.', suggestion1: 'Review this week’s project progress', suggestion2: 'Help me analyze a document', suggestion3: 'Turn an idea into an actionable plan' },
};
class IntelligentChat {
  turns = new Map(); messages = new Map(); apps = new Map(); seen = new Set(); runs = new Set(); work = new Map();
  language = () => document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  t = key => translations[this.language()][key] || key;
  async request(path, body) {
    const response = await fetch(`/api/chat${path}`, { ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaoba-Chat': '1' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || this.t('missing')); return result;
  }
  init() {
    if (this.initialized) { this.connect(); return; }
    this.initialized = true;
    this.timeline = document.getElementById('chat-timeline'); this.input = document.getElementById('chat-input');
    this.viewport = document.getElementById('chat-scroll'); this.connection = document.getElementById('chat-connection');
    document.getElementById('chat-form').addEventListener('submit', event => { event.preventDefault(); this.send(); });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.compositionEnded = Date.now(); });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !this.composing && event.keyCode !== 229 && Date.now() - (this.compositionEnded || 0) > 80) { event.preventDefault(); this.send(); }
    });
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`; });
    document.getElementById('chat-stop').addEventListener('click', async () => { try { await this.request('/stop', { threadId: this.threadId }); } catch (error) { this.notice(error.message); } });
    window.addEventListener('beforeunload', () => { this.source?.close(); for (const app of this.apps.values()) app.destroy(); });
    this.connect();
    this.setLanguage();
  }
  setLanguage() {
    if (!this.initialized) return;
    for (const element of document.querySelectorAll('[data-chat-label]')) element.textContent = this.t(element.dataset.chatLabel);
    this.input.placeholder = this.t('placeholder');
    this.connection.textContent = this.t(this.connected ? 'online' : 'offline');
    if (!this.timeline.children.length) this.empty();
    this.updateWork();
  }
  async connect() {
    if (this.connecting || this.source) return;
    this.connecting = true;
    document.getElementById('chat-send').disabled = true;
    try {
      const { threadId } = await this.request('/config');
      this.subscribe(threadId);
    } catch (error) { this.notice(error.message); }
    finally { this.connecting = false; document.getElementById('chat-send').disabled = !this.threadId; }
  }
  subscribe(threadId) {
    this.threadId = threadId;
    this.timeline.replaceChildren(); this.empty();
    this.ui = new A2UIView({ mount: owner => this.turn(owner, true).body, submit: action => this.request('/action', { threadId: this.threadId, eventId: crypto.randomUUID(), action }), language: this.language });
    this.runs.clear(); this.work.clear();
    this.connected = false; this.updateBusy();
    const source = this.source = new EventSource(`/api/chat/events?threadId=${encodeURIComponent(threadId)}`);
    source.onopen = () => { if (source !== this.source) return; this.connected = true; this.connection.textContent = this.t('online'); this.connection.classList.add('connected'); this.updateWork(); };
    source.onerror = () => { if (source !== this.source) return; this.connected = false; this.connection.textContent = this.t('offline'); this.connection.classList.remove('connected'); this.updateWork(); };
    source.onmessage = message => {
      if (source !== this.source) return;
      try {
        const event = JSON.parse(message.data); if (event.sessionKey !== this.threadId || this.seen.has(event.id)) return;
        this.seen.add(event.id); this.event(event);
      } catch (error) { this.notice(error.message); }
    };
  }
  avatar() {
    const canvas = node('canvas', 'chat-avatar'); canvas.width = 96; canvas.height = 104;
    try { const player = new window.XiaoBaPetRuntime.PetPlayer(canvas); player.load({ renderer: 'grok-cat-v1', roleThemes: window.XiaoBaPetRuntime.defaultRoleThemes }, { role: 'base', autoplay: false }); }
    catch { canvas.setAttribute('aria-label', 'XiaoBa'); }
    return canvas;
  }
  empty() {
    if (this.timeline.children.length) return;
    const welcome = node('section', 'chat-empty'); welcome.id = 'chat-empty';
    const title = node('h2', '', this.t('welcome')); title.dataset.chatLabel = 'welcome';
    const introduction = node('p', '', this.t('introduction')); introduction.dataset.chatLabel = 'introduction';
    const prompts = node('div', 'chat-suggestions');
    for (const key of ['suggestion1', 'suggestion2', 'suggestion3']) {
      const button = node('button', '', this.t(key)); button.type = 'button'; button.dataset.chatLabel = key;
      button.addEventListener('click', () => { this.input.value = this.t(key); this.input.focus(); }); prompts.append(button);
    }
    welcome.append(this.avatar(), title, introduction, prompts); this.timeline.append(welcome);
  }
  clearEmpty() { document.getElementById('chat-empty')?.remove(); }
  turn(id, chronological = false) {
    id ||= 'restored';
    let turn = this.turns.get(id);
    if (!turn || chronological && turn.element !== this.timeline.lastElementChild) {
      this.clearEmpty();
      const element = node('article', 'chat-turn'); element.dataset.responseId = id;
      const heading = node('header', 'chat-turn-heading'); heading.append(this.avatar(), node('strong', '', 'XiaoBa'));
      const body = node('div', 'chat-turn-body'); element.append(heading, body); this.timeline.append(element);
      turn = { element, body }; this.turns.set(id, turn);
    }
    return turn;
  }
  async send() {
    const text = this.input.value.trim(); if (!text || this.sending || !this.threadId) return;
    const threadId = this.threadId;
    this.sending = true; document.getElementById('chat-send').disabled = true;
    try {
      await this.request('/message', { threadId, text, eventId: crypto.randomUUID() });
      if (threadId === this.threadId && this.input.value.trim() === text) { this.input.value = ''; this.input.style.height = 'auto'; }
    } catch (error) { this.notice(error.message); }
    finally { this.sending = false; document.getElementById('chat-send').disabled = false; this.input.focus(); }
  }
  updateBusy() {
    document.getElementById('chat-stop').hidden = this.runs.size === 0;
    this.updateWork();
  }
  updateWork() {
    const status = document.getElementById('chat-work');
    if (!status) return;
    const tasks = [...this.work.values()];
    status.hidden = !this.runs.size && !tasks.length;
    if (status.hidden) return;
    const task = tasks.find(item => item.status === 'running') || tasks[0];
    const paused = !this.connected || this.runFailed && !this.runs.size && !tasks.some(item => item.status === 'running');
    let label = this.t('working');
    if (!this.connected) label = this.t('offline');
    else if (paused) label = this.t('paused');
    else if (task) {
      const phase = task.resultPending ? 'gathering' : task.status === 'waiting_for_input' ? 'confirming' : 'background';
      label = this.t(phase) + (task.description ? ` · ${task.description.slice(0, 64)}` : '');
    }
    status.dataset.paused = String(Boolean(paused));
    document.getElementById('chat-work-label').textContent = label;
    const hint = tasks.length > 1 ? this.t('moreWork').replace('{count}', tasks.length - 1) : this.t('continueChat');
    document.getElementById('chat-work-hint').textContent = hint;
  }
  notice(message, owner) {
    const alert = node('p', 'chat-notice', message); alert.setAttribute('role', 'status');
    (owner ? this.turn(owner, true).body : this.timeline).append(alert);
  }
  event(event) {
    const nearBottom = this.viewport.scrollHeight - this.viewport.scrollTop - this.viewport.clientHeight < 120;
    const owner = event.metadata?.responseId || 'restored';
    if (event.type === 'CUSTOM') {
      if (event.name === 'xiaoba.user.message') {
        let text = event.value.text;
        if (event.value.action) {
          const action = event.value.action, surface = this.ui.model.surfaces.get(action.surfaceId);
          const button = surface?.components[action.sourceComponentId];
          const label = button?.text || surface?.components[button?.child]?.text;
          text = typeof label === 'string' ? `${this.t('submitted')}${label}` : this.t('submittedChoice');
        }
        this.clearEmpty(); const message = node('div', 'chat-user-message', text); message.dataset.eventId = event.value.eventId; this.timeline.append(message);
      } else if (event.name === 'a2ui') {
        try { this.ui.apply(event.value.messages, owner); } catch { /* A following snapshot restores a truncated history window. */ }
      } else if (event.name === 'xiaoba.ui.snapshot') this.ui.snapshot(event.value.surfaces, event.value.owners);
      else if (event.name === 'xiaoba.mcp.app' && !this.apps.has(event.value.appId)) {
        this.apps.set(event.value.appId, new McpAppView({ reference: event.value, threadId: this.threadId, mount: this.turn(owner, true).body, request: this.request.bind(this), language: this.language }));
      } else if (event.name === 'xiaoba.file') {
        const link = node('a', 'chat-file', `↗ ${event.value.fileName}`);
        if (event.value.fileId) link.href = `/api/chat/files/${encodeURIComponent(event.value.fileId)}?threadId=${encodeURIComponent(this.threadId)}`;
        link.download = event.value.fileName; this.turn(owner, true).body.append(link);
      }
    } else if (event.type === 'RUN_STARTED') { this.runFailed = false; this.runs.add(event.runId); this.updateBusy(); }
    else if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
      this.runFailed = event.type === 'RUN_ERROR';
      this.runs.delete(event.runId || owner); this.updateBusy();
      if (event.type === 'RUN_ERROR') this.notice(event.message, owner);
    } else if (event.type === 'TEXT_MESSAGE_START') {
      const paragraph = node('div', 'chat-text'); this.turn(owner, true).body.append(paragraph); this.messages.set(event.messageId, paragraph);
    } else if (event.type === 'TEXT_MESSAGE_CONTENT') {
      let paragraph = this.messages.get(event.messageId);
      if (!paragraph) { paragraph = node('div', 'chat-text'); this.turn(owner, true).body.append(paragraph); this.messages.set(event.messageId, paragraph); }
      paragraph.textContent += event.delta;
    } else if (event.type === 'ACTIVITY_SNAPSHOT' && event.activityType === 'SUBAGENT') {
      const activity = event.content;
      if (['running', 'waiting_for_input'].includes(activity.status) || activity.resultPending) this.work.set(activity.subagentRunId, activity);
      else this.work.delete(activity.subagentRunId);
      this.updateWork();
    } else if (event.type === 'TOOL_CALL_RESULT') {
      let result; try { result = JSON.parse(event.content); } catch { return; }
      if (['send_text', 'send_ui'].includes(result.name) && result.status !== 'success') this.notice(this.t('deliveryFailed'), owner);
    }

    if (nearBottom) this.viewport.scrollTop = this.viewport.scrollHeight;
  }
}
window.XiaoBaChat = new IntelligentChat();
