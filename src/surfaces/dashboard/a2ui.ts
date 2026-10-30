/** Shared protocol model for the server validator and the browser renderer. */
export const CATALOG_ID = 'xiaoba://ui/basic-v1';
export const A2UI_VERSION = 'v0.9.1';
export type UIObject = Record<string, any>;
export interface UISurface {
  surfaceId: string;
  catalogId: string;
  revision: number;
  sendDataModel: boolean;
  components: Record<string, UIObject>;
  data: UIObject;
}
const COMPONENT_FIELDS: Record<string, string[]> = {
  Column: ['children'], Row: ['children'], Card: ['child', 'title'],
  Text: ['text', 'variant'], TextField: ['label', 'value', 'variant', 'required'],
  ChoicePicker: ['label', 'value', 'options'], CheckBox: ['label', 'value'],
  Button: ['child', 'text', 'variant', 'action'], Divider: [],
  Metric: ['label', 'value', 'description'], BarChart: ['title', 'items'],
};
const badKeys = new Set(['__proto__', 'constructor', 'prototype']);
export function plainObject(value: any): value is UIObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
export function safeJSON(value: any, depth = 0): void {
  if (depth > 20) throw new Error('UI nesting limit exceeded');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid UI number');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (badKeys.has(key)) throw new Error('Unsafe UI key');
    safeJSON(child, depth + 1);
  }
}
export function pointerParts(pointer: any): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 512) throw new Error('Invalid UI data path');
  const parts = pointer === '/' ? [] : pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some(part => badKeys.has(part) || !part)) throw new Error('Unsafe UI data path');
  return parts;
}
export function getData(data: UIObject, pointer: string): any {
  return pointerParts(pointer).reduce((value, key) => value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined, data as any);
}
export function setData(data: UIObject, pointer: string, value: any): UIObject {
  const parts = pointerParts(pointer);
  if (!parts.length) {
    if (!plainObject(value)) throw new Error('UI root data must be an object');
    return value;
  }
  let current = data;
  for (const part of parts.slice(0, -1)) {
    if (!plainObject(current[part]) && !Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  if (value === undefined) delete current[parts[parts.length - 1]];
  else current[parts[parts.length - 1]] = value;
  return data;
}
export function resolveValue(value: any, data: UIObject): any {
  if (plainObject(value) && Object.keys(value).length === 1 && typeof value.path === 'string') return getData(data, value.path);
  if (Array.isArray(value)) return value.map(item => resolveValue(item, data));
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, data)]));
  return value;
}
function identifier(value: any): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) || badKeys.has(value)) throw new Error('Invalid UI identifier');
  return value;
}
function validateComponent(component: any): void {
  if (!plainObject(component)) throw new Error('Invalid UI component');
  identifier(component.id);
  if (typeof component.component !== 'string') throw new Error('A2UI v0.9.1 requires a flat component: {"id":"title","component":"Text","text":"Hello"}. Do not use component:{"Text":{...}}.');
  const fields = COMPONENT_FIELDS[component.component];
  if (!fields || Object.keys(component).some(key => !['id', 'component', ...fields].includes(key))) throw new Error('Unsupported component or property');
  for (const field of ['value', 'text', 'label']) if (plainObject(component[field])) pointerParts(component[field].path);
  if (component.children !== undefined && (!Array.isArray(component.children) || component.children.length > 100)) throw new Error('Invalid children');
  component.children?.forEach(identifier);
  if (component.child !== undefined) identifier(component.child);
  if (component.component === 'Button') {
    const action = component.action?.event;
    if (!plainObject(action) || component.action.functionCall || Object.keys(component.action).some(key => key !== 'event')) throw new Error('Only server actions are supported');
    identifier(action.name);
    if (action.context !== undefined && !plainObject(action.context)) throw new Error('Invalid action context');
  }
  if (component.component === 'ChoicePicker' && (!Array.isArray(component.options) || component.options.length > 100
    || component.options.some((option: any) => !plainObject(option) || typeof option.label !== 'string' || typeof option.value !== 'string'))) throw new Error('Invalid choices');
  if (component.component === 'BarChart' && (!Array.isArray(component.items) || component.items.length > 50
    || component.items.some((item: any) => !plainObject(item) || typeof item.label !== 'string' || typeof item.value !== 'number' || item.value < 0 || item.value > 100))) throw new Error('Invalid chart items');
}

export class A2UIModel {
  surfaces = new Map<string, UISurface>();

  apply(messages: any[]): void {
    if (!Array.isArray(messages) || !messages.length || messages.length > 100 || JSON.stringify(messages).length > 64_000) throw new Error('Invalid UI message batch');
    safeJSON(messages);
    const staged = new Map([...this.surfaces].map(([key, surface]) => [key, JSON.parse(JSON.stringify(surface)) as UISurface]));
    for (const message of messages) {
      if (!plainObject(message) || message.version !== A2UI_VERSION) throw new Error(`Expected A2UI ${A2UI_VERSION}`);
      const kinds = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].filter(key => Object.prototype.hasOwnProperty.call(message, key));
      if (kinds.length !== 1 || Object.keys(message).some(key => !['version', kinds[0]].includes(key))) throw new Error('Invalid A2UI envelope');
      const kind = kinds[0], body = message[kind];
      if (!plainObject(body)) throw new Error('Invalid A2UI body');
      const id = identifier(body.surfaceId);
      if (kind === 'createSurface') {
        if (staged.has(id) || staged.size >= 24 || body.catalogId !== CATALOG_ID) throw new Error('Duplicate surface, surface limit, or unsupported catalog');
        staged.set(id, { surfaceId: id, catalogId: CATALOG_ID, revision: 0, sendDataModel: body.sendDataModel === true, components: {}, data: {} });
        continue;
      }
      const surface = staged.get(id);
      if (!surface) throw new Error('UI surface does not exist in this session');
      if (kind === 'deleteSurface') { staged.delete(id); continue; }
      if (kind === 'updateComponents') {
        if (!Array.isArray(body.components) || body.components.length > 200) throw new Error('Component limit exceeded');
        for (const component of body.components) {
          validateComponent(component);
          surface.components[component.id] = component;
        }
        if (Object.keys(surface.components).length > 200) throw new Error('Component limit exceeded');
        const walk = (id: string, ancestors: Set<string>) => {
          if (ancestors.has(id) || ancestors.size > 20) throw new Error('Cyclic or deeply nested UI');
          const component = surface.components[id];
          if (!component) return; // Progressive rendering permits forward references.
          for (const child of component.children || (component.child ? [component.child] : [])) walk(child, new Set([...ancestors, id]));
        };
        for (const id of Object.keys(surface.components)) walk(id, new Set());
      } else {
        if ('data' in body || 'contents' in body) throw new Error('updateDataModel uses {surfaceId,path:"/",value:{...}}, not data or contents.');
        surface.data = setData(surface.data, body.path || '/', body.value);
      }
      surface.revision++;
    }
    this.surfaces = staged;
  }

  /** Accept edits only to declared inputs, then derive context from the server-owned action. */
  action(input: any): { action: UIObject; data: UIObject } {
    if (!plainObject(input) || JSON.stringify(input).length > 32_000) throw new Error('Invalid UI action');
    safeJSON(input);
    const surface = this.surfaces.get(input.surfaceId), component = surface?.components[input.sourceComponentId];
    if (!surface || !component || component.component !== 'Button' || surface.revision !== input.revision) throw new Error('UI action is stale or does not belong to this session');
    const event = component.action?.event;
    if (!event || event.name !== input.name) throw new Error('UI action was not offered');
    const values = plainObject(input.values) ? input.values : {};
    const data = JSON.parse(JSON.stringify(surface.data));
    const allowed = new Map(Object.values(surface.components).filter(item => ['TextField', 'ChoicePicker', 'CheckBox'].includes(item.component) && typeof item.value?.path === 'string').map(item => [item.value.path, item]));
    for (const [pointer, value] of Object.entries(values)) {
      const field = allowed.get(pointer);
      if (!field) throw new Error('UI action contains an undeclared input');
      if (field.component === 'CheckBox' ? typeof value !== 'boolean' : typeof value !== 'string' || value.length > 8000) throw new Error('Invalid input value');
      if (field.component === 'ChoicePicker' && !field.options.some((option: UIObject) => option.value === value)) throw new Error('Invalid selected choice');
      setData(data, pointer, value);
    }
    for (const [pointer, field] of allowed) if (field.required && !getData(data, pointer)) throw new Error('Required field is empty');
    if (input.timestamp !== undefined && (typeof input.timestamp !== 'string' || !Number.isFinite(Date.parse(input.timestamp)))) throw new Error('Invalid action timestamp');
    return { action: { name: event.name, surfaceId: surface.surfaceId, sourceComponentId: component.id, ...(input.timestamp ? { timestamp: input.timestamp } : {}), context: resolveValue(event.context || {}, data), ...(surface.sendDataModel ? { metadata: { dataModel: data } } : {}) }, data };
  }
}

export const CATALOG_PROMPT = `富 UI 可用时用 send_ui 交付 A2UI ${A2UI_VERSION}。每个消息包含 version:"${A2UI_VERSION}"。catalogId:"${CATALOG_ID}"。支持 Column/Row(children:ID[])、Card(child:ID,title?)、Text(text,variant?)、TextField(label,value:{path:"/field"},required?)、ChoicePicker(label,value:{path},options:[{label,value}])、CheckBox(label,value:{path})、Button(text 或 child,action:{event:{name,context}})、Divider、Metric(label,value,description?)、BarChart(title,items:[{label,value:0..100}])。组件必须是扁平对象，例如 {"id":"title","component":"Text","text":"标题"}，不要使用旧版 component:{"Text":{...}}。updateDataModel 使用 value 而非 data。完整最小示例：{"messages":[{"version":"v0.9.1","createSurface":{"surfaceId":"form","catalogId":"xiaoba://ui/basic-v1"}},{"version":"v0.9.1","updateComponents":{"surfaceId":"form","components":[{"id":"root","component":"Column","children":["budget","submit"]},{"id":"budget","component":"TextField","label":"预算","value":{"path":"/budget"}},{"id":"submit","component":"Button","text":"提交","action":{"event":{"name":"update","context":{"budget":{"path":"/budget"}}}}}]}},{"version":"v0.9.1","updateDataModel":{"surfaceId":"form","path":"/","value":{"budget":"1000"}}}]}。先 createSurface，再 updateComponents（必须提供 root），再 updateDataModel；更新同一 surface 不重复 createSurface。只使用实际数据。ChoicePicker、TextField 和 CheckBox 只收集本地输入，不会自动提交或切换其他内容。表单必须配一个带 action.event 的 Button；切换资料优先使用“论文”“项目”等 Button 事件，Main 收到后用 updateComponents/updateDataModel 更新原 surface，并只呈现当前类别。不要生成没有实际提交路径的假切换控件。用户点击 Button 才提交；action 不是写操作授权。需要复杂现成应用时先 mcp_list，再调用 MCP 工具，系统自动嵌入它声明的 UI。`;
