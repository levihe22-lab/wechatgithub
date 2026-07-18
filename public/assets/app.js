import { SessionController } from './session-controller.js';
import { UI_MESSAGES, UiRenderer } from './ui-renderer.js';
import { createSession } from './wcv3-session-factory.js';
import { bindLifecycle } from './lifecycle-events.js';
import { initViewer, destroyViewer } from './viewer.js';

export function createApp(doc = document, options = {}) {
  const renderer = new UiRenderer(doc);

  const controller = new SessionController(renderer, {
    createSession: options.createSession || createSession,
    onTransition: (from, to) => {
      if (to === 'unlocked') {
        const viewerInit = options.initViewer || initViewer;
        viewerInit(controller.session).catch(() => {
          controller.clear('viewer-init-failure', UI_MESSAGES.FAILURE);
        });
      }
      if (to === 'locked' || to === 'clearing') {
        const viewerDestroy = options.destroyViewer || destroyViewer;
        viewerDestroy();
      }
    },
  });

  const fileInput = doc.querySelector('#package-file');
  const passwordInput = doc.querySelector('#package-password');

  doc.querySelector('#unlock-button').addEventListener('click', async () => {
    try {
      await controller.beginImport(fileInput.files?.[0], passwordInput.value);
    } finally {
      passwordInput.value = '';
    }
  });

  doc.querySelector('#cancel-button').addEventListener('click', () => {
    controller.cancelImport();
  });

  doc.querySelector('#lock-button').addEventListener('click', () => {
    controller.lock();
  });

  bindLifecycle(controller, options.lifecycleTarget);

  return Object.freeze({ controller, renderer });
}

if (typeof document !== 'undefined') {
  createApp(document);
}
