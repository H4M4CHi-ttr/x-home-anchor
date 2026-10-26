// Scroll events precede animation callbacks. A page can scroll in a later rAF,
// so an event-only correction can miss that paint. This refresh-only size probe
// schedules a ResizeObserver checkpoint after rAF without replacing page APIs.
export class RefreshPaintGuard {
  private frame = 0;
  private host: HTMLElement | null = null;
  private cover: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  constructor(private doc: Document, private win: Window, private check: () => void, private active: () => boolean) {}
  start(root: HTMLElement, viewportTop: number) {
    if (this.host) return;
    this.stop();
    this.cover = this.snapshot(root, viewportTop);
    const host = this.doc.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;overflow:hidden!important;visibility:hidden!important;pointer-events:none!important;contain:strict!important;';
    const probe = this.doc.createElement('div');
    probe.style.cssText = 'width:1px;height:1px';
    host.attachShadow({ mode: 'closed' }).append(probe);
    this.host = host; this.doc.documentElement.append(host);
    this.observer = new ResizeObserver(() => {
      this.check();
      if (!this.active()) this.finish();
    });
    this.observer.observe(probe);
    let width = 1;
    const pulse = () => {
      if (!this.active()) { this.finish(); return; }
      probe.style.width = `${width = 3 - width}px`;
      this.frame = this.win.requestAnimationFrame(pulse);
    };
    this.frame = this.win.requestAnimationFrame(pulse);
  }
  private snapshot(root: HTMLElement, viewportTop: number) {
    const rect = root.getBoundingClientRect();
    const top = Math.max(viewportTop, rect.top, 0);
    const bottom = Math.min(this.win.innerHeight, rect.bottom);
    if (rect.width <= 0 || bottom <= top) return null;
    const cover = this.doc.createElement('div');
    cover.id = 'x-home-refresh-cover';
    cover.setAttribute('aria-hidden', 'true');
    let background = 'Canvas';
    for (let node: HTMLElement | null = root; node; node = node.parentElement) {
      const color = this.win.getComputedStyle(node).backgroundColor;
      if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break; }
    }
    const style = this.win.getComputedStyle(root);
    cover.style.cssText = `all:initial!important;position:fixed!important;left:${rect.left}px!important;top:${top}px!important;width:${rect.width}px!important;height:${bottom - top}px!important;overflow:hidden!important;pointer-events:auto!important;z-index:2147483646!important;contain:strict!important;background:${background}!important;font:${style.font}!important;color:${style.color}!important;`;
    const copy = root.cloneNode(true) as HTMLElement;
    copy.inert = true;
    copy.removeAttribute('id');
    for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');
    for (const node of copy.querySelectorAll('script, style, link, iframe, object, embed')) node.remove();
    copy.style.setProperty('position', 'absolute', 'important');
    copy.style.setProperty('top', `${rect.top - top}px`, 'important');
    copy.style.setProperty('left', '0', 'important');
    copy.style.setProperty('width', `${rect.width}px`, 'important');
    copy.style.setProperty('margin', '0', 'important');
    // cloneNode does not copy canvas pixels or the current video frame.
    const sources = root.querySelectorAll<HTMLVideoElement | HTMLCanvasElement>('video, canvas');
    const targets = copy.querySelectorAll<HTMLVideoElement | HTMLCanvasElement>('video, canvas');
    sources.forEach((source, index) => {
      const box = source.getBoundingClientRect();
      const frame = this.doc.createElement('canvas');
      frame.className = source.className; frame.style.cssText = source.style.cssText;
      frame.width = Math.max(1, Math.ceil(box.width)); frame.height = Math.max(1, Math.ceil(box.height));
      frame.style.width = `${box.width}px`; frame.style.height = `${box.height}px`;
      try { frame.getContext('2d')?.drawImage(source, 0, 0, frame.width, frame.height); } catch { /* Media may not have a decoded frame yet. */ }
      targets[index]?.replaceWith(frame);
    });
    cover.append(copy); this.doc.documentElement.append(cover);
    return cover;
  }
  finish() {
    if (!this.host) return;
    const cover = this.cover; this.cover = null;
    this.stop(); this.cover = cover;
    // Let the virtualizer mount the destination range before revealing it.
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = this.win.requestAnimationFrame(() => {
        this.cover?.remove(); this.cover = null; this.frame = 0;
      });
    });
  }
  stop() {
    this.win.cancelAnimationFrame(this.frame); this.frame = 0;
    this.observer?.disconnect(); this.observer = null;
    this.host?.remove(); this.host = null;
    this.cover?.remove(); this.cover = null;
  }
  contains(target: EventTarget | null) { return target instanceof Node && !!this.cover?.contains(target); }
  get running() { return this.host !== null; }
}
