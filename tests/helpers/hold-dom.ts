import type { TestContext } from 'node:test';

// Only the DOM contracts used by the adapter/gesture are modeled here. Browser
// hit testing and trusted input are covered separately by runtime verification.
export class Clock {
  now = 100;
  private next = 1;
  private tasks = new Map<number, { due: number; callback: () => void; interval: number }>();
  setTimeout = (callback: () => void, delay = 0) => {
    const id = this.next++;
    this.tasks.set(id, { due: this.now + delay, callback, interval: 0 });
    return id;
  };
  clearTimeout = (id: number) => { this.tasks.delete(id); };
  setInterval = (callback: () => void, delay: number) => {
    const id = this.setTimeout(callback, delay);
    this.tasks.get(id)!.interval = delay;
    return id;
  };
  clearInterval = this.clearTimeout;
  advance(ms: number) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.tasks].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next || next[1].due > end) break;
      this.now = next[1].due;
      if (next[1].interval) next[1].due += next[1].interval;
      else this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

type Listener = { callback: (event: Input) => void; capture: boolean; once: boolean };
class Events {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, callback: (event: Input) => void, options: any = {}) {
    if (options.signal?.aborted) return;
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    const listener = { callback, capture, once: !!options.once };
    const list = this.listeners.get(type) ?? [];
    if (list.some(item => item.callback === callback && item.capture === capture)) return;
    list.push(listener); this.listeners.set(type, list);
    options.signal?.addEventListener('abort', () => this.removeEventListener(type, callback, options));
  }
  removeEventListener(type: string, callback: (event: Input) => void, options: any = {}) {
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item.callback !== callback || item.capture !== capture));
  }
  dispatch(event: Input, capture: boolean) {
    event.currentTarget = this;
    for (const listener of [...this.listeners.get(event.type) ?? []]) {
      if (listener.capture !== capture) continue;
      listener.callback(event);
      if (listener.once) this.removeEventListener(event.type, listener.callback, capture);
      if (event.immediateStopped) break;
    }
  }
}

export class Input {
  type: string;
  target: any;
  currentTarget: any;
  relatedTarget: any = null;
  pointerId = 1;
  pointerType = 'mouse';
  isPrimary = true;
  button = 0;
  buttons = 1;
  clientX = 40;
  clientY = 40;
  detail = 1;
  isTrusted = true;
  cancelable = true;
  defaultPrevented = false;
  propagationStopped = false;
  immediateStopped = false;
  timeStamp = 0;
  constructor(type: string, target: any, values: Record<string, unknown> = {}) {
    this.type = type; this.target = target; Object.assign(this, values);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.immediateStopped = true; this.stopPropagation(); }
  composedPath() {
    const path: any[] = [];
    for (let node = this.target; node; node = node.parentElement) path.push(node);
    return path;
  }
}

export class Element extends Events {
  parentElement: Element | null = null;
  children: Element[] = [];
  attrs = new Map<string, string>();
  ownerDocument: Doc;
  textContent = '';
  style = {};
  rect = { left: 20, top: 20, right: 80, bottom: 80, x: 20, y: 20, width: 60, height: 60 };
  tagName: string;
  constructor(doc: Doc, tagName = 'DIV', attrs: Record<string, string> = {}) {
    super(); this.ownerDocument = doc; this.tagName = tagName;
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
  }
  get nodeName() { return this.tagName; }
  get disabled() { return this.hasAttribute('disabled'); }
  get isConnected(): boolean { return this === this.ownerDocument.documentElement || !!this.parentElement?.isConnected; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value)); this.ownerDocument.changed(this, 'attributes', name);
  }
  removeAttribute(name: string) { this.attrs.delete(name); this.ownerDocument.changed(this, 'attributes', name); }
  append(...nodes: Element[]) {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
    this.ownerDocument.changed(this, 'childList', undefined, [], nodes);
  }
  appendChild(node: Element) { this.append(node); return node; }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter(child => child !== this); this.parentElement = null;
    this.ownerDocument.changed(parent, 'childList', undefined, [this]);
  }
  replaceWith(node: Element) {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this); node.remove();
    parent.children[index] = node; node.parentElement = parent; this.parentElement = null;
    this.ownerDocument.changed(parent, 'childList', undefined, [this], [node]);
  }
  contains(node: any): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const text = part.trim();
      const tag = text.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const attrs = [...text.matchAll(/\[([^=\]\s]+)(?:=["']?([^\]"']+)["']?)?\]/g)];
      if (!tag && !attrs.length) return false;
      return attrs.every(([, name, value]) => value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value);
    });
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return this.rect; }
}

class Observer {
  private target: Element | Doc | null = null;
  private options: any;
  private records: any[] = [];
  private scheduled = false;
  private callback: (records: any[]) => void;
  constructor(callback: (records: any[]) => void) { this.callback = callback; }
  observe(target: Element | Doc, options: any) { this.target = target; this.options = options; docFor(target).observers.add(this); }
  disconnect() { if (this.target) docFor(this.target).observers.delete(this); this.target = null; this.records = []; }
  takeRecords() { const records = this.records; this.records = []; return records; }
  changed(target: Element, type: string, attributeName?: string, removedNodes: Element[] = [], addedNodes: Element[] = []) {
    if (!this.target || !(this.target === target || this.options.subtree && this.target.contains(target))) return;
    if (type === 'attributes' && (!this.options.attributes || this.options.attributeFilter && !this.options.attributeFilter.includes(attributeName))) return;
    if (type === 'childList' && !this.options.childList) return;
    this.records.push({ target, type, attributeName, removedNodes, addedNodes });
    if (this.scheduled) return;
    this.scheduled = true;
    docFor(this.target).clock.setTimeout(() => { this.scheduled = false; const records = this.takeRecords(); if (records.length) this.callback(records); }, 0);
  }
}
function docFor(node: Element | Doc) { return node instanceof Doc ? node : node.ownerDocument; }

export class Doc extends Events {
  hidden = false;
  observers = new Set<Observer>();
  documentElement = new Element(this, 'HTML');
  body = new Element(this, 'BODY');
  targetAtPoint: Element | null = null;
  defaultView: Win | null = null;
  clock: Clock;
  constructor(clock: Clock) { super(); this.clock = clock; this.documentElement.append(this.body); }
  get visibilityState() { return this.hidden ? 'hidden' : 'visible'; }
  contains(node: Element) { return this.documentElement.contains(node); }
  querySelector(selector: string) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
  elementFromPoint(x: number, y: number) {
    const node = this.targetAtPoint;
    if (!node?.isConnected) return null;
    const rect = node.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? node : this.body;
  }
  changed(target: Element, type: string, attributeName?: string, removedNodes: Element[] = [], addedNodes: Element[] = []) { for (const observer of this.observers) observer.changed(target, type, attributeName, removedNodes, addedNodes); }
}
class Win extends Events {
  location = { href: 'https://x.com/home', pathname: '/home' };
  navigation = new Events();
  performance: { now: () => number };
  setTimeout: Clock['setTimeout']; clearTimeout: Clock['clearTimeout'];
  setInterval: Clock['setInterval']; clearInterval: Clock['clearInterval'];
  MutationObserver = Observer;
  document: Doc;
  constructor(document: Doc, clock: Clock) {
    super(); this.document = document; this.performance = { now: () => clock.now };
    this.setTimeout = clock.setTimeout; this.clearTimeout = clock.clearTimeout;
    this.setInterval = clock.setInterval; this.clearInterval = clock.clearInterval;
  }
}

export function environment(t: TestContext) {
  const clock = new Clock(); const doc = new Doc(clock); const win = new Win(doc, clock); doc.defaultView = win;
  for (const [key, value] of Object.entries({ Element, Node: Element, HTMLElement: Element, HTMLButtonElement: Element, MutationObserver: Observer, PointerEvent: Input, MouseEvent: Input })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.method(performance, 'now', () => clock.now);
  t.mock.method(Date, 'now', () => clock.now);
  const element = (tag: string, attrs: Record<string, string> = {}) => new Element(doc, tag.toUpperCase(), attrs);
  const emit = (type: string, target: any = doc, values: Record<string, unknown> = {}) => {
    const event = new Input(type, target, { timeStamp: clock.now, ...values });
    if ('pointerId' in values && values.pointerId === undefined) Reflect.deleteProperty(event, 'pointerId');
    if (target === win.navigation) {
      target.dispatch(event, true); if (!event.propagationStopped) target.dispatch(event, false);
      return event;
    }
    const path: Events[] = [];
    for (let node = target; node instanceof Element; node = node.parentElement) path.unshift(node);
    path.unshift(doc); path.unshift(win);
    for (const current of path) { current.dispatch(event, true); if (event.propagationStopped) return event; }
    for (const current of path.reverse()) { current.dispatch(event, false); if (event.propagationStopped) break; }
    return event;
  };
  const post = (id = '2114176286763675701', user = '1oveWolfgirl') => {
    const article = element('article', { 'data-testid': 'tweet' });
    const header = element('div', { 'data-testid': 'User-Name' });
    const link = element('a', { href: `/${user}/status/${id}`, role: 'link' });
    const time = element('time'); link.append(time); header.append(link);
    const analytics = element('a', { href: `/${user}/status/${id}/analytics` });
    const button = element('button', { 'data-testid': 'retweet', 'aria-haspopup': 'menu' });
    const div = element('div'); const svg = element('svg'); const path = element('path'); svg.append(path); div.append(svg); button.append(div);
    const quote = element('div', { 'data-testid': 'quoteTweet', role: 'link' });
    const quoteHeader = element('div', { 'data-testid': 'User-Name' });
    const quoteLink = element('a', { href: '/quoted/status/123' }); quoteLink.append(element('time')); quoteHeader.append(quoteLink); quote.append(quoteHeader);
    article.append(header, quote, analytics, button); doc.body.append(article); doc.targetAtPoint = path;
    return { article, header, link, time, analytics, button, div, svg, path, quote, quoteHeader, quoteLink };
  };
  return { clock, doc, win, element, emit, post };
}
