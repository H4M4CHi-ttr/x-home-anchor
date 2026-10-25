import { repostTarget, type RepostTarget } from './adapter.ts';

export function openQuotes(target: RepostTarget, signal: AbortSignal): void {
  const { article, url } = target;
  const doc = article.ownerDocument;
  const win = doc.defaultView;
  const more = [...article.querySelectorAll<HTMLButtonElement>('button[data-testid="caret"]')]
    .find(button => button.closest('article[data-testid="tweet"]') === article
      && !button.closest('[data-testid="quoteTweet"], [data-testid="card.wrapper"], [data-testid="tweetText"]'));
  if (!win || signal.aborted || !more) return;
  const page = win.location.href;
  const listeners = new AbortController();
  let finished = false;
  const finish = (link?: HTMLAnchorElement) => {
    if (finished) return;
    finished = true; observer.disconnect(); win.clearTimeout(timer); listeners.abort();
    link?.click();
  };
  const check = () => {
    if (finished) return;
    const current = repostTarget(target.button);
    if (!article.isConnected || win.location.href !== page || current?.article !== article || current.url !== url) { finish(); return; }
    const link = [...doc.querySelectorAll<HTMLAnchorElement>('[role="menu"] a[role="menuitem"][href]')]
      .find(link => link.href === url);
    if (link) finish(link);
  };
  // X creates the menu asynchronously; activate its own link to keep SPA routing.
  const observer = new MutationObserver(check);
  const timer = win.setTimeout(() => finish(), 1000);
  const cancel = () => finish();
  const options = { signal: listeners.signal, capture: true, passive: true };
  for (const type of ['pointerdown', 'wheel', 'keydown', 'popstate', 'pagehide']) win.addEventListener(type, cancel, options);
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) cancel(); }, options);
  signal.addEventListener('abort', cancel, options);
  const navigation = (win as Window & { navigation?: EventTarget }).navigation;
  for (const type of ['navigate', 'currententrychange']) navigation?.addEventListener(type, cancel, options);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'role'] });
  check();
  if (!finished) { more.click(); check(); }
}
