export interface GuiElementSnapshot {
  id: string;
  role?: string;
  label?: string;
  title?: string;
  description?: string;
  value?: string;
  app?: string;
  bundleId?: string;
  enabled?: boolean;
  bounds?: unknown;
}

export type GuiRisk = 'safe' | 'confirmation_required' | 'forbidden';

export interface GuiRiskDecision {
  risk: GuiRisk;
  reason?: string;
}

const TERMINAL_APP_PATTERN = /(^|\b)(terminal|iterm2?|warp|alacritty|kitty|wezterm|hyper)(\b|$)/i;
const TERMINAL_SURFACE_PATTERN = /(?:^|\b)(?:integrated\s+)?terminal(?:\b|$)|(?:^|\b)(?:shell|console|command\s+prompt|powershell)(?:\b|$)|终端|控制台|命令提示符/i;
const SECURE_FIELD_PATTERN = /password|passcode|one[ -]?time|verification code|otp|2fa|pin\b|密码|口令|验证码|动态码/i;
const SECURE_ROLE_PATTERN = /secure.*text|axsecuretextfield/i;
const FORBIDDEN_ACTION_PATTERN = /touch\s*id|keychain|privacy\s*&\s*security|screen recording|accessibility permission|event synthesizing|wire transfer|bank transfer|payment|pay now|checkout|purchase|buy now|转账|付款|支付|购买|结账|钥匙串|触控 id|隐私与安全/i;
const CONSEQUENT_ACTION_PATTERN = /delete|remove|erase|trash|send|submit|publish|post|save|overwrite|replace|install|uninstall|allow|grant|authorize|approve|confirm|quit|close|discard|open anyway|删除|移除|清空|抹掉|废纸篓|发送|提交|发布|保存|覆盖|替换|安装|卸载|允许|授权|批准|确认|退出|关闭|不保存/i;
const DANGEROUS_COMMAND_TEXT = /(^|[;&|]\s*)(sudo\s+|rm\s+-[^\n]*r[^\n]*f|mkfs\b|diskutil\s+erase|shutdown\b|reboot\b|poweroff\b|format\s+[a-z]:|del\s+\/s|powershell\b|cmd(?:\.exe)?\s+\/c)/i;

export function isTerminalApplication(app?: string): boolean {
  return Boolean(app && TERMINAL_APP_PATTERN.test(app));
}

export function isSecureElement(element: GuiElementSnapshot): boolean {
  const role = element.role || '';
  const text = elementText(element);
  return SECURE_ROLE_PATTERN.test(role) || SECURE_FIELD_PATTERN.test(text);
}

export function isTerminalElement(element: GuiElementSnapshot): boolean {
  return TERMINAL_SURFACE_PATTERN.test(elementText(element));
}

export function classifyElementAction(element: GuiElementSnapshot): GuiRiskDecision {
  const text = elementText(element);
  if (FORBIDDEN_ACTION_PATTERN.test(text)) {
    return { risk: 'forbidden', reason: 'The target is outside GuiCat v1 safety scope.' };
  }
  if (CONSEQUENT_ACTION_PATTERN.test(text)) {
    return { risk: 'confirmation_required', reason: 'The target may create a consequential external side effect.' };
  }
  return { risk: 'safe' };
}

export function validateGuiInput(element: GuiElementSnapshot, text: string, requestedApp?: string): GuiRiskDecision {
  const appCandidates = [requestedApp, element.app, element.bundleId];
  if (appCandidates.some(app => isTerminalApplication(app)) || isTerminalElement(element)) {
    return { risk: 'forbidden', reason: 'GuiCat never types into terminals; route Shell work to EngineerCat.' };
  }
  if (isSecureElement(element)) {
    return { risk: 'forbidden', reason: 'Password, OTP, PIN, and secure fields are outside GuiCat v1.' };
  }
  if (DANGEROUS_COMMAND_TEXT.test(text)) {
    return { risk: 'forbidden', reason: 'Text resembles a dangerous system command and cannot be injected through GUI automation.' };
  }
  if (FORBIDDEN_ACTION_PATTERN.test(elementText(element))) {
    return { risk: 'forbidden', reason: 'This field is associated with a forbidden financial, credential, or permission workflow.' };
  }
  return { risk: 'safe' };
}

export function classifyDescription(text: string): GuiRiskDecision {
  if (FORBIDDEN_ACTION_PATTERN.test(text)) {
    return { risk: 'forbidden', reason: 'The requested action is outside GuiCat v1 safety scope.' };
  }
  if (CONSEQUENT_ACTION_PATTERN.test(text)) {
    return { risk: 'confirmation_required' };
  }
  return { risk: 'safe' };
}

export function isHighRiskSubagentContext(context: { surface?: unknown; sessionId?: unknown }): boolean {
  const surface = String(context.surface || '').toLowerCase();
  const sessionId = String(context.sessionId || '').toLowerCase();
  return surface === 'agent' || sessionId.startsWith('subagent:') || sessionId.startsWith('sub-');
}

export function elementText(element: GuiElementSnapshot): string {
  return [element.label, element.title, element.description, element.role]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ');
}
