import { HomeController } from './controller.ts';

const singleton = Symbol.for('x-home-anchor.instance');
const scope = globalThis as typeof globalThis & { [singleton]?: () => void };
scope[singleton]?.();
function install() {
  const controller = new HomeController(document, window);
  const runtime = globalThis.chrome?.runtime;
  const onMessage = (message: unknown, sender: chrome.runtime.MessageSender, respond: (response: unknown) => void) => {
    if (!runtime?.id || sender.id !== runtime.id || typeof message !== 'object' || message === null) return;
    const command = (message as { command?: string }).command;
    if (command === 'status') respond(controller.status());
  };
  runtime?.onMessage?.addListener(onMessage);
  return () => {
    controller.dispose(); runtime?.onMessage?.removeListener(onMessage);
  };
}
let uninstall = install();
const onHide = () => uninstall();
const onShow = (event: PageTransitionEvent) => { if (event.persisted) { uninstall(); uninstall = install(); } };
window.addEventListener('pagehide', onHide);
window.addEventListener('pageshow', onShow);
scope[singleton] = () => {
  uninstall(); window.removeEventListener('pagehide', onHide); window.removeEventListener('pageshow', onShow);
};
