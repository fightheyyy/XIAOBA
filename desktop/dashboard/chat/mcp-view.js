import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

export class McpAppView {
  constructor({ reference, threadId, mount, request, language }) {
    this.reference = reference; this.threadId = threadId; this.request = request; this.language = language;
    this.closed = false;
    this.element = document.createElement('section'); this.element.className = 'chat-app-card'; this.element.dataset.appId = reference.appId;
    const header = document.createElement('header'), title = document.createElement('h3'); title.textContent = reference.title;
    const retry = document.createElement('button'); retry.textContent = language() === 'zh' ? '重新打开' : 'Reload'; retry.type = 'button';
    retry.addEventListener('click', () => this.open()); header.append(title, retry);
    this.status = document.createElement('p'); this.status.className = 'chat-muted';
    this.frameContainer = document.createElement('div'); this.element.append(header, this.status, this.frameContainer); mount.append(this.element);
    this.open();
  }
  rpc(method, params) { return this.request(`/apps/${encodeURIComponent(this.reference.appId)}/rpc`, { threadId: this.threadId, method, params }); }
  async open() {
    if (this.closed) return;
    const generation = this.generation = (this.generation || 0) + 1;
    if (this.bridge) { try { await this.bridge.close(); } catch {} }
    this.status.textContent = this.language() === 'zh' ? '正在打开应用…' : 'Opening app…'; this.status.hidden = false;
    const iframe = document.createElement('iframe'); iframe.title = this.reference.title; iframe.setAttribute('sandbox', 'allow-scripts'); iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
    this.frameContainer.replaceChildren(iframe);
    const style = getComputedStyle(document.documentElement);
    const variables = Object.fromEntries(Object.entries({
      '--color-background-primary': '--surface', '--color-background-secondary': '--surface-muted',
      '--color-text-primary': '--text', '--color-text-secondary': '--text2', '--color-text-tertiary': '--text3',
      '--color-text-info': '--accent',
      '--color-border-primary': '--border', '--color-border-secondary': '--border-light',
      '--border-radius-sm': '--radius-xs', '--border-radius-md': '--radius-sm',
    }).map(([name, source]) => [name, style.getPropertyValue(source).trim()]));
    variables['--font-sans'] = getComputedStyle(document.body).fontFamily;
    const bridge = this.bridge = new AppBridge(null, { name: 'XiaoBa', version: '0.2.2' }, { serverTools: {}, logging: {}, updateModelContext: { text: {}, structuredContent: {} }, message: { text: {} } }, { hostContext: { theme: 'light', displayMode: 'inline', styles: { variables } } });
    bridge.oncalltool = params => this.rpc('tools/call', params);
    bridge.onmessage = params => this.rpc('ui/message', params);
    bridge.onupdatemodelcontext = params => this.rpc('ui/update-model-context', params);
    bridge.onsizechange = ({ height }) => { if (Number.isFinite(height)) iframe.style.height = `${Math.max(160, Math.min(900, height))}px`; };
    bridge.oninitialized = async () => {
      try {
        const initial = await this.rpc('initial', {});
        if (this.closed || generation !== this.generation) return;
        await bridge.sendToolInput({ arguments: initial.arguments }); await bridge.sendToolResult(initial.result);
        this.status.hidden = true;
      } catch { this.fail(); }
    };
    bridge.onerror = () => this.fail();
    try {
      await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
      iframe.src = `/api/chat/apps/${encodeURIComponent(this.reference.appId)}/document?threadId=${encodeURIComponent(this.threadId)}`;
      clearTimeout(this.timer); this.timer = setTimeout(() => { if (!this.status.hidden) this.fail(); }, 15_000);
    } catch { this.fail(); }
  }
  fail() { if (!this.closed) { this.status.hidden = false; this.status.textContent = this.language() === 'zh' ? '应用未能打开，可重新尝试。' : 'Unable to open app. Try reloading.'; } }
  async destroy() {
    this.closed = true; this.generation++; clearTimeout(this.timer);
    try { await this.bridge?.teardownResource({}, { timeout: 1000 }); } catch {}
    try { await this.bridge?.close(); } catch {}
    this.frameContainer.replaceChildren();
  }
}
