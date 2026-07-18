import { canTransition, SESSION_STATE } from './session-state.js';
import { UI_MESSAGES } from './ui-renderer.js';

const unavailableSessionFactory = async () => {
  throw new Error('SESSION_IMPORT_UNAVAILABLE');
};

export class SessionController {
  #state = SESSION_STATE.LOCKED;
  #attempt = null;
  #session = null;
  #createSession;
  #onTransition;

  constructor(renderer, { createSession = unavailableSessionFactory, onTransition } = {}) {
    if (!renderer || typeof renderer.render !== 'function') {
      throw new TypeError('SESSION_RENDERER_REQUIRED');
    }
    if (typeof createSession !== 'function') {
      throw new TypeError('SESSION_FACTORY_INVALID');
    }

    this.renderer = renderer;
    this.#createSession = createSession;
    this.#onTransition = typeof onTransition === 'function' ? onTransition : null;
    this.renderer.render(SESSION_STATE.LOCKED, UI_MESSAGES.READY);
  }

  get state() {
    return this.#state;
  }

  get session() {
    return this.#session;
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      hasFile: Boolean(this.#attempt?.file || this.#session?.file),
      hasSessionKey: Boolean(this.#session?.sessionKey),
      hasManifest: Boolean(this.#session?.manifest),
      decryptedResourceCount: this.#session?.decryptedResources.size ?? 0,
      temporaryUrlCount: this.#session?.temporaryUrls.size ?? 0,
    });
  }

  async beginImport(file, password) {
    if (this.#state !== SESSION_STATE.LOCKED) {
      this.clear('new-import');
    }

    if (!isWcvFile(file)) {
      this.renderer.render(SESSION_STATE.LOCKED, UI_MESSAGES.FILE_REQUIRED);
      return false;
    }
    if (typeof password !== 'string' || password.length === 0) {
      this.renderer.render(SESSION_STATE.LOCKED, UI_MESSAGES.PASSWORD_REQUIRED);
      return false;
    }

    const token = Object.freeze({});
    this.#attempt = { token, file, header: null };
    this.#moveTo(SESSION_STATE.IMPORTING);
    this.renderer.render(SESSION_STATE.IMPORTING);

    let candidate;
    try {
      candidate = await this.#createSession(file, password);
      if (!isAuthenticatedSession(candidate)) throw new Error('SESSION_RESULT_INVALID');
    } catch (err) {
      if (this.#attempt?.token === token) {
        this.clear('import-failure', err?.message === 'E_AUTH' ? UI_MESSAGES.AUTH_FAILURE : UI_MESSAGES.FAILURE);
      }
      return false;
    }

    if (this.#attempt?.token !== token || this.#state !== SESSION_STATE.IMPORTING) {
      releaseCandidate(candidate);
      return false;
    }

    this.#session = {
      file,
      reader: candidate.reader,
      sessionKey: candidate.sessionKey,
      header: candidate.header,
      manifest: candidate.manifest,
      planner: candidate.planner,
      _wcv2PackageId: candidate._wcv2PackageId || null,
      _wcv2RecordById: candidate._wcv2RecordById || null,
      decryptedResources: candidate.decryptedResources instanceof Map
        ? candidate.decryptedResources
        : new Map(),
      temporaryUrls: candidate.temporaryUrls instanceof Set
        ? candidate.temporaryUrls
        : new Set(),
    };
    this.#attempt = null;
    this.#moveTo(SESSION_STATE.UNLOCKED);
    this.renderer.render(SESSION_STATE.UNLOCKED);
    return true;
  }

  cancelImport() {
    if (this.#state !== SESSION_STATE.IMPORTING) return false;
    this.clear('cancel-import');
    return true;
  }

  lock() {
    this.clear('user-lock');
  }

  clear(reason = 'clear', lockedMessage = UI_MESSAGES.READY) {
    void reason;
    if (this.#state === SESSION_STATE.LOCKED) {
      this.#releaseReferences();
      this.renderer.clearInputs?.();
      this.renderer.render(SESSION_STATE.LOCKED, lockedMessage);
      return;
    }

    if (this.#state !== SESSION_STATE.CLEARING) {
      this.#moveTo(SESSION_STATE.CLEARING);
    }
    this.renderer.render(SESSION_STATE.CLEARING);
    this.#releaseReferences();
    this.renderer.clearInputs?.();
    this.#moveTo(SESSION_STATE.LOCKED);
    this.renderer.render(SESSION_STATE.LOCKED, lockedMessage);
  }

  #moveTo(nextState) {
    if (!canTransition(this.#state, nextState)) {
      throw new Error('SESSION_TRANSITION_INVALID');
    }
    const previousState = this.#state;
    this.#state = nextState;
    this.#onTransition?.(previousState, nextState);
  }

  #releaseReferences() {
    if (this.#session) {
      this.#session.reader?.clear?.();
      this.#session.reader = null;
      this.#session.header = null;
      this.#session.planner = null;
      this.#session._wcv2PackageId = null;
      this.#session._wcv2RecordById = null;
      this.#session.decryptedResources.clear();
      this.#session.temporaryUrls.clear();
      this.#session.file = null;
      this.#session.sessionKey = null;
      this.#session.manifest = null;
    }
    if (this.#attempt) {
      this.#attempt.file = null;
      this.#attempt.header = null;
    }
    this.#session = null;
    this.#attempt = null;
  }
}

function isWcvFile(file) {
  return Boolean(
    file
    && typeof file.name === 'string'
    && file.name.toLocaleLowerCase().endsWith('.wcv'),
  );
}

function isAuthenticatedSession(candidate) {
  return Boolean(
    candidate
    && typeof candidate === 'object'
    && candidate.sessionKey
    && candidate.manifest
    && typeof candidate.manifest === 'object',
  );
}

function releaseCandidate(candidate) {
  candidate?.decryptedResources?.clear?.();
  candidate?.temporaryUrls?.clear?.();
  if (candidate && typeof candidate === 'object') {
    candidate.sessionKey = null;
    candidate.manifest = null;
  }
}
