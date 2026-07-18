import { SESSION_STATE } from './session-state.js';

export const UI_MESSAGES = Object.freeze({
  READY: '请选择本地 .wcv 文件并输入密码。',
  FILE_REQUIRED: '请选择有效的本地 .wcv 文件。',
  PASSWORD_REQUIRED: '请输入包密码。',
  IMPORTING: '正在当前页面内存中验证本地加密包…',
  CLEARING: '正在锁定并清除当前页面会话…',
  FAILURE: '无法验证此本地包。请重新选择文件并输入密码。',
  AUTH_FAILURE: '密码错误，请重新输入。',
});

const TRANSIENT_SELECTORS = Object.freeze([
  '#search-panel',
  '#date-panel',
  '#image-overlay',
  '#video-overlay',
]);

export class UiRenderer {
  constructor(doc = document) {
    this.doc = doc;
    this.status = requireElement(doc, '#status');
    this.fileInput = requireElement(doc, '#package-file');
    this.passwordInput = requireElement(doc, '#package-password');
    this.unlockButton = requireElement(doc, '#unlock-button');
    this.cancelButton = requireElement(doc, '#cancel-button');
    this.lockedView = optionalElement(doc, '#locked-view');
    this.appView = optionalElement(doc, '#app-view');
    this.transientSurfaces = TRANSIENT_SELECTORS
      .map((sel) => optionalElement(doc, sel))
      .filter(Boolean);
  }

  render(state, message) {
    switch (state) {
      case SESSION_STATE.LOCKED:
        this.status.textContent = safeMessage(message, UI_MESSAGES.READY);
        this.setImportControls(false);
        this.applySurfaces(true, false);
        break;
      case SESSION_STATE.IMPORTING:
        this.status.textContent = UI_MESSAGES.IMPORTING;
        this.setImportControls(true);
        this.applySurfaces(true, false);
        break;
      case SESSION_STATE.UNLOCKED:
        this.setImportControls(false);
        this.applySurfaces(false, true);
        break;
      case SESSION_STATE.CLEARING:
        this.status.textContent = UI_MESSAGES.CLEARING;
        this.setImportControls(true);
        this.applySurfaces(true, false);
        break;
      default:
        throw new Error('UI_STATE_INVALID');
    }
  }

  clearInputs() {
    this.fileInput.value = '';
    this.passwordInput.value = '';
  }

  setImportControls(busy) {
    this.fileInput.disabled = busy;
    this.passwordInput.disabled = busy;
    this.unlockButton.disabled = busy;
    this.cancelButton.hidden = !busy;
    this.cancelButton.disabled = false;
  }

  applySurfaces(showLocked, showApp) {
    if (this.lockedView) this.lockedView.hidden = !showLocked;
    if (this.appView) this.appView.hidden = !showApp;
    for (const el of this.transientSurfaces) {
      el.hidden = true;
    }
  }
}

function requireElement(doc, selector) {
  const element = doc.querySelector(selector);
  if (!element) throw new Error('UI_ELEMENT_MISSING');
  return element;
}

function optionalElement(doc, selector) {
  return doc.querySelector(selector);
}

function safeMessage(message, fallback) {
  return Object.values(UI_MESSAGES).includes(message) ? message : fallback;
}
