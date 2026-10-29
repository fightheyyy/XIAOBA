import { A2UIModel, getData, setData, resolveValue } from '../../../src/surfaces/dashboard/a2ui.ts';

const el = (tag, className, text) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text ?? ''); return node;
};
export class A2UIView {
  model = new A2UIModel();
  elements = new Map();
  constructor({ mount, submit, language }) { this.mount = mount; this.submit = submit; this.language = language; }
  apply(messages, owner) {
    this.model.apply(messages);
    this.render(owner);
  }
  snapshot(surfaces, owners) {
    const changed = surfaces.some(surface => this.model.surfaces.get(surface.surfaceId)?.revision !== surface.revision);
    this.model.surfaces = new Map(surfaces.map(surface => [surface.surfaceId, surface]));
    if (changed || surfaces.some(surface => !this.elements.has(surface.surfaceId))) this.render(undefined, owners);
  }
  render(owner, owners = {}) {
    for (const [id, item] of this.elements) if (!this.model.surfaces.has(id)) { item.element.remove(); this.elements.delete(id); }
    for (const surface of this.model.surfaces.values()) {
      let item = this.elements.get(surface.surfaceId);
      if (!item) {
        const element = el('section', 'chat-ui-surface'); element.dataset.surfaceId = surface.surfaceId;
        item = { element, owner: owners[surface.surfaceId] || owner };
        this.elements.set(surface.surfaceId, item); this.mount(item.owner).append(element);
      }
      const revision = String(surface.revision);
      if (item.element.dataset.revision === revision) continue;
      item.element.dataset.revision = revision;
      item.element.replaceChildren(this.component(surface, 'root', new Set()));
    }
  }
  component(surface, id, ancestors) {
    if (ancestors.has(id) || ancestors.size > 20) return el('span', '', '');
    const item = surface.components[id]; if (!item) return el('span', 'chat-ui-placeholder');
    const next = new Set([...ancestors, id]);
    const value = name => resolveValue(item[name], surface.data);
    const children = node => { for (const child of item.children || (item.child ? [item.child] : [])) node.append(this.component(surface, child, next)); return node; };
    switch (item.component) {
      case 'Column': return children(el('div', 'chat-ui-column'));
      case 'Row': return children(el('div', 'chat-ui-row'));
      case 'Card': {
        const card = el('section', 'chat-ui-card'); if (item.title) card.append(el('h3', '', item.title)); return children(card);
      }
      case 'Text': return el(['h1', 'h2', 'h3'].includes(item.variant) ? 'h3' : 'p', item.variant === 'caption' ? 'chat-muted' : 'chat-ui-text', value('text'));
      case 'Divider': return el('hr', 'chat-ui-divider');
      case 'TextField': case 'ChoicePicker': case 'CheckBox': {
        const label = el('label', `chat-ui-field ${item.component === 'CheckBox' ? 'chat-ui-checkbox' : ''}`);
        label.append(el('span', '', value('label')));
        let input;
        if (item.component === 'ChoicePicker') {
          input = el('select');
          for (const option of item.options) { const node = el('option', '', option.label); node.value = option.value; input.append(node); }
        } else {
          input = el('input'); input.type = item.component === 'CheckBox' ? 'checkbox' : item.variant === 'number' ? 'number' : 'text';
          input.maxLength = 8000;
        }
        input.setAttribute('aria-label', String(value('label') || id));
        const path = item.value?.path;
        if (input.type === 'checkbox') input.checked = value('value') === true;
        else input.value = value('value') ?? '';
        if (item.required) input.required = true;
        input.addEventListener(item.component === 'TextField' ? 'input' : 'change', () => {
          if (path) setData(surface.data, path, input.type === 'checkbox' ? input.checked : input.value);
        });
        label.append(input); return label;
      }
      case 'Button': {
        const button = el('button', `chat-ui-button btn ${item.variant === 'secondary' ? 'secondary' : 'btn-primary'}`);
        button.type = 'button';
        if (item.child) button.append(this.component(surface, item.child, next)); else button.textContent = item.text || item.action.event.name;
        button.addEventListener('click', async () => {
          button.disabled = true;
          const values = Object.fromEntries(Object.values(surface.components).filter(field => ['TextField', 'ChoicePicker', 'CheckBox'].includes(field.component) && field.value?.path).map(field => [field.value.path, getData(surface.data, field.value.path)]));
          try {
            this.model.action({ surfaceId: surface.surfaceId, sourceComponentId: id, name: item.action.event.name, revision: surface.revision, values });
            await this.submit({ surfaceId: surface.surfaceId, sourceComponentId: id, name: item.action.event.name, revision: surface.revision, values, timestamp: new Date().toISOString() });
            const status = el('span', 'chat-ui-submitted', this.language() === 'zh' ? '已提交' : 'Submitted'); button.after(status);
          } catch (error) {
            let alert = button.parentElement.querySelector('.chat-ui-error');
            if (!alert) { alert = el('p', 'chat-ui-error'); alert.setAttribute('role', 'alert'); button.after(alert); }
            alert.textContent = error.message;
          } finally { button.disabled = false; }
        });
        return button;
      }
      case 'Metric': {
        const node = el('div', 'chat-ui-metric'); node.append(el('span', 'chat-muted', value('label')), el('strong', '', value('value')));
        if (item.description) node.append(el('small', 'chat-muted', value('description'))); return node;
      }
      case 'BarChart': {
        const node = el('figure', 'chat-ui-chart'); if (item.title) node.append(el('figcaption', '', item.title));
        for (const datum of item.items) {
          const row = el('div', 'chat-ui-bar-row'), track = el('div', 'chat-ui-bar-track'), bar = el('div', 'chat-ui-bar');
          bar.style.width = `${datum.value}%`; track.append(bar); row.append(el('span', '', datum.label), track, el('small', '', `${datum.value}%`)); node.append(row);
        } return node;
      }
      default: return el('span', 'chat-ui-error', 'Unsupported UI component');
    }
  }
  destroy() { for (const item of this.elements.values()) item.element.remove(); this.elements.clear(); this.model = new A2UIModel(); }
}
