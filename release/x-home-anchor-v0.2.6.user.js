// ==UserScript==
// @name         X ホームの閲覧位置
// @namespace    https://github.com/H4M4CHi-ttr/x-home-anchor
// @version      0.2.6
// @description  Xホームの閲覧位置を保ち、操作した新着表示件数を累計します。
// @author       akiweb8528
// @homepageURL  https://github.com/H4M4CHi-ttr/x-home-anchor
// @license      MIT
// @match        https://x.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 akiweb8528

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

"use strict";
(() => {
  // src/adapter.ts
  var MAX_DOM_POSTS = 500;
  var articleSelector = 'article[data-testid="tweet"]';
  var primarySelector = '[data-testid="primaryColumn"]';
  function isHome(url) {
    return url.pathname.replace(/\/$/, "") === "/home";
  }
  function timelineKind(doc) {
    const primary = doc.querySelector(primarySelector);
    const selected = primary?.querySelector('[role="tab"][aria-selected="true"]');
    const text = selected?.textContent?.replace(/\s+/g, " ").trim().toLowerCase();
    if (text === "\u304A\u3059\u3059\u3081" || text === "for you") return "for-you";
    if (text === "\u30D5\u30A9\u30ED\u30FC\u4E2D" || text === "following") return "following";
    return null;
  }
  function timelineRoot(doc) {
    const primary = doc.querySelector(primarySelector);
    if (!primary) return null;
    for (const region of primary.querySelectorAll("[aria-label]")) {
      const label = region.getAttribute("aria-label") ?? "";
      if (/^(Timeline:|タイムライン[:：])/.test(label)) return region;
    }
    return null;
  }
  var excludedContent = '[data-testid="quoteTweet"], [data-testid="card.wrapper"], [data-testid="tweetText"]';
  function insideExcludedContent(element, article, timestamp) {
    for (let node = element; node && node !== article; node = node.parentElement) {
      if (node.matches(excludedContent) || node.matches('[role="link"]') && node !== timestamp) return true;
    }
    return element.closest(articleSelector) !== article;
  }
  function postId(article) {
    const header = [...article.querySelectorAll('[data-testid="User-Name"]')].find((el) => !insideExcludedContent(el, article));
    if (!header) return null;
    const ids = /* @__PURE__ */ new Set();
    for (const time of header.querySelectorAll("time")) {
      const link = time.closest("a[href]");
      if (insideExcludedContent(time, article, link ?? void 0)) continue;
      if (!link || !header.contains(link)) continue;
      let url;
      try {
        url = new URL(link.getAttribute("href") ?? "", "https://x.com");
      } catch {
        continue;
      }
      if (url.hostname !== "x.com" || url.protocol !== "https:") continue;
      const match = url.pathname.match(/^\/[^/]+\/status\/(\d{1,30})(?:\/)?$/);
      if (match) ids.add(match[1]);
    }
    return ids.size === 1 ? [...ids][0] : null;
  }
  function readPosts(root) {
    const elements = [...root.querySelectorAll(articleSelector)].filter((el) => !el.parentElement?.closest(articleSelector));
    const posts = [];
    const boxes = [];
    for (const element of elements.slice(0, MAX_DOM_POSTS)) {
      const id = postId(element);
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const box = { element, top: rect.top, bottom: rect.bottom };
      boxes.push(box);
      if (id !== null) posts.push({ ...box, id });
    }
    return { posts, boxes, overLimit: elements.length > MAX_DOM_POSTS };
  }
  function parseRefreshLabel(label) {
    const normalized = label.normalize("NFKC").replace(/\s+/g, " ").trim();
    const english = normalized.match(/^Show (?:(\d+(?:,\d{3})*) (?:new )?|new )(?:posts?|Tweets?)$/i);
    const compact = normalized.replace(/\s/g, "");
    const japanese = compact.match(/^(?:(\d+(?:,\d{3})*)件の(?:新しい|新着)?|新しい|新着)(?:ポスト|ツイート)を表示$/) ?? compact.match(/^(?:新しい|新着)(?:ポスト|ツイート)を(\d+(?:,\d{3})*)件表示$/);
    const match = english ?? japanese;
    if (!match) return null;
    if (!match[1]) return {};
    const displayedCount = Number(match[1].replace(/,/g, ""));
    return Number.isSafeInteger(displayedCount) && displayedCount > 0 ? { displayedCount } : {};
  }
  function refreshDetails(target) {
    if (!(target instanceof Element)) return null;
    const control = target.closest('a, button, [role="button"], [role="tab"]');
    if (!control) return null;
    return parseRefreshLabel(control.textContent ?? "") ?? parseRefreshLabel(control.getAttribute("aria-label") ?? "");
  }
  function countedRefreshDetails(target, doc) {
    if (!(target instanceof Element)) return null;
    const control = target.closest('a, button, [role="button"], [role="tab"]');
    if (!control || !doc.querySelector(primarySelector)?.contains(control) || control.closest(`article, ${excludedContent}`)) return null;
    return refreshDetails(control);
  }
  function clickIntent(target) {
    if (!(target instanceof Element)) return null;
    const control = target.closest('a, button, [role="button"], [role="tab"]');
    if (!control) return null;
    if (refreshDetails(target)) return "refresh";
    return "navigate";
  }

  // src/refresh-paint-guard.ts
  var RefreshPaintGuard = class {
    constructor(doc, win, check, active) {
      this.doc = doc;
      this.win = win;
      this.check = check;
      this.active = active;
    }
    doc;
    win;
    check;
    active;
    frame = 0;
    host = null;
    observer = null;
    start() {
      if (this.host) return;
      const host = this.doc.createElement("div");
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "all:initial!important;position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;overflow:hidden!important;visibility:hidden!important;pointer-events:none!important;contain:strict!important;";
      const probe = this.doc.createElement("div");
      probe.style.cssText = "width:1px;height:1px";
      host.attachShadow({ mode: "closed" }).append(probe);
      this.host = host;
      this.doc.documentElement.append(host);
      this.observer = new ResizeObserver(() => {
        this.check();
        if (!this.active()) this.stop();
      });
      this.observer.observe(probe);
      let width = 1;
      const pulse = () => {
        if (!this.active()) {
          this.stop();
          return;
        }
        probe.style.width = `${width = 3 - width}px`;
        this.frame = this.win.requestAnimationFrame(pulse);
      };
      this.frame = this.win.requestAnimationFrame(pulse);
    }
    stop() {
      this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.observer?.disconnect();
      this.observer = null;
      this.host?.remove();
      this.host = null;
    }
    get running() {
      return this.host !== null;
    }
  };

  // src/refresh-total.ts
  var memoryKey = /* @__PURE__ */ Symbol.for("x-home-anchor.refresh-total");
  var RefreshTotal = class {
    constructor(doc) {
      this.doc = doc;
      this.memory = doc[memoryKey] ??= { total: 0n };
      this.host = doc.createElement("div");
      this.host.id = "x-home-new-post-total";
      this.host.setAttribute("role", "status");
      this.host.setAttribute("aria-live", "off");
      const shadow = this.host.attachShadow({ mode: "closed" });
      const style = doc.createElement("style");
      style.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        top: 8px !important;
        left: 8px !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        user-select: none !important;
        display: block !important;
        width: max-content !important;
        font: 0.8rem/1.4 system-ui, sans-serif !important;
      }
      :host([hidden]) { display: none !important; }
      span {
        display: block;
        padding: 2px 6px;
        border-radius: 3px;
        background: #303030;
        color: #f5f5f5;
        font: 0.8rem/1.4 system-ui, sans-serif;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        pointer-events: none;
      }
    `;
      this.value = doc.createElement("span");
      shadow.append(style, this.value);
      this.render();
    }
    doc;
    memory;
    host;
    value;
    render() {
      const total = this.memory.total.toString();
      this.value.textContent = total;
      this.host.setAttribute("aria-label", `\u64CD\u4F5C\u3057\u305F\u65B0\u7740\u8868\u793A\u30DC\u30BF\u30F3\u306E\u4EF6\u6570\u306E\u7D2F\u8A08: ${total}`);
    }
    show(home) {
      this.host.hidden = !home;
      if (!this.host.isConnected) this.doc.documentElement.append(this.host);
    }
    activate(event, url) {
      if (!event.isTrusted || !isHome(url)) return;
      const count = countedRefreshDetails(event.target, this.doc)?.displayedCount;
      if (count === void 0) return;
      this.memory.total += BigInt(count);
      this.render();
      this.show(true);
    }
    dispose() {
      this.host.remove();
    }
  };

  // src/position.ts
  var CORRECTION_MS = 1800;
  var INPUT_QUIET_MS = 700;
  function chooseAnchors(posts, viewportHeight) {
    const counts = /* @__PURE__ */ new Map();
    for (const post of posts) counts.set(post.id, (counts.get(post.id) ?? 0) + 1);
    const visible = posts.filter((p) => p.bottom > 80 && p.top < viewportHeight && counts.get(p.id) === 1);
    const first = visible.find((p) => p.top >= 80) ?? visible[0];
    if (!first) return [];
    const index = posts.indexOf(first);
    return [first, ...[...posts.slice(index + 1, index + 5), ...posts.slice(Math.max(0, index - 2), index).reverse()].filter((p) => counts.get(p.id) === 1)].slice(0, 7).map((p) => ({ id: p.id, top: p.top }));
  }
  function resolveAnchor(anchors, posts) {
    for (const anchor of anchors) {
      const matches = posts.filter((p) => p.id === anchor.id);
      if (matches.length === 1) return { delta: matches[0].top - anchor.top };
    }
    return null;
  }
  var REFRESH_WAIT_MS = 3e3;
  var REFRESH_MAX_MS = 5e3;
  var REFRESH_SETTLE_MS = 1e3;
  var APPROXIMATE_WAIT_MS = 650;
  function median(values) {
    if (!values.length) return void 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
  }
  function representativeHeight(boxes, viewportHeight) {
    const local = boxes.map((box, index) => ({ box, index })).sort((a, b) => Math.abs(a.box.top - viewportHeight / 2) - Math.abs(b.box.top - viewportHeight / 2)).slice(0, 9).sort((a, b) => a.index - b.index);
    const height = median(local.map(({ box }) => box.bottom - box.top).filter((n) => n > 0));
    if (height === void 0 || local.length < 3) return void 0;
    const pitches = local.slice(1).map(({ box, index }, i) => index === local[i].index + 1 ? box.top - local[i].box.top : 0).filter((n) => n > 0 && n <= height * 3);
    return pitches.length >= 2 ? median(pitches) : height;
  }
  var PositionKeeper = class {
    anchors = [];
    until = 0;
    quietUntil = 0;
    needsIdle = false;
    retired = false;
    retireUntil = 0;
    refreshStart = null;
    lastActivity = 0;
    sawUpdate = false;
    resetUsed = false;
    missing = false;
    knownY;
    measurement = null;
    precisionRestored = false;
    geometryAvailable = false;
    win;
    constructor(win) {
      this.win = win;
      this.knownY = win.scrollY;
    }
    get refreshing() {
      return this.refreshStart !== null;
    }
    get remainingMs() {
      let end = this.completionDeadline();
      const fallbackAt = this.approximationAt();
      if (this.geometryAvailable && fallbackAt !== null) end = Math.min(end, fallbackAt);
      return Math.max(0, end - performance.now());
    }
    get correcting() {
      return this.until > performance.now();
    }
    capture(posts) {
      if (this.until || this.retired || this.needsIdle || performance.now() < this.quietUntil) return;
      this.anchors = chooseAnchors(posts, this.win.innerHeight);
      this.knownY = this.win.scrollY;
    }
    interrupt() {
      if (this.refreshing) {
        this.retired = true;
        this.retireUntil = this.until;
      }
      this.until = 0;
      this.refreshStart = null;
      this.anchors = [];
      this.missing = false;
      this.measurement = null;
      this.knownY = this.win.scrollY;
      this.quietUntil = performance.now() + INPUT_QUIET_MS;
      this.needsIdle = true;
    }
    input() {
      if (this.retired && performance.now() >= this.retireUntil) this.retired = false;
      this.interrupt();
    }
    refresh(posts, context) {
      this.until = 0;
      this.refreshStart = null;
      this.anchors = [];
      this.retired = false;
      this.needsIdle = false;
      this.quietUntil = 0;
      this.capture(posts);
      const boxes = context?.boxes ?? posts;
      this.geometryAvailable = boxes.length > 0;
      if (!this.anchors.length && !boxes.length) {
        this.measurement = null;
        return;
      }
      const displayedCount = context?.displayedCount;
      this.measurement = {
        y: this.win.scrollY,
        boxes: boxes.map((box) => ({ element: box.element, y: box.top + this.win.scrollY })),
        ids: posts.map((post) => post.id),
        documentHeight: this.win.document.documentElement.scrollHeight,
        representativeHeight: representativeHeight(boxes, this.win.innerHeight),
        ...displayedCount !== void 0 && displayedCount > 0 && Number.isSafeInteger(displayedCount) ? { displayedCount } : {}
      };
      this.refreshStart = performance.now();
      this.until = this.refreshStart + REFRESH_MAX_MS;
      this.lastActivity = this.refreshStart;
      this.sawUpdate = false;
      this.resetUsed = false;
      this.missing = false;
      this.precisionRestored = false;
    }
    completionDeadline() {
      if (this.refreshStart === null) return this.until;
      if (!this.precisionRestored && this.approximationTarget()) return this.until;
      if (!this.sawUpdate) return this.refreshStart + REFRESH_WAIT_MS;
      return this.missing ? this.until : Math.min(this.until, Math.max(this.refreshStart + REFRESH_WAIT_MS, this.lastActivity + REFRESH_SETTLE_MS));
    }
    checkDeadline() {
      if (!this.until || performance.now() < this.completionDeadline()) return false;
      this.interrupt();
      return true;
    }
    acceptScroll() {
      const y = this.win.scrollY;
      if (Math.abs(y - this.knownY) < 1) return true;
      if (this.refreshing && !this.resetUsed && y <= 1 && this.knownY > 1) {
        this.resetUsed = true;
        this.lastActivity = performance.now();
        return true;
      }
      this.interrupt();
      return false;
    }
    measureUpdate(posts, boxes) {
      const baseline = this.measurement;
      if (!baseline || !boxes.length) return;
      const before = new Set(baseline.boxes.map((box) => box.element));
      const first = baseline.boxes[0];
      const firstIndex = boxes.findIndex((box) => box.element === first?.element);
      let addedHeight;
      if (firstIndex >= 0) {
        const added = boxes[firstIndex].top + this.win.scrollY - first.y;
        const prefixInserted = firstIndex > 0 && boxes.slice(0, firstIndex).some((box) => !before.has(box.element));
        const commonShift = baseline.boxes.slice(0, 3).filter((old) => boxes.some((box) => box.element === old.element && Math.abs(box.top + this.win.scrollY - old.y - added) <= 1)).length >= 3;
        if (added > 1 && (prefixInserted || commonShift)) addedHeight = (baseline.restoredY ?? baseline.y) - baseline.y + added;
      }
      const newNodes = boxes.some((box) => !before.has(box.element));
      const newIds = posts.some((post) => !baseline.ids.includes(post.id));
      const upperPlacementChanged = first && boxes[0].top + this.win.scrollY > first.y + 1;
      const sameKnownIds = baseline.ids.length > 0 && posts.length === baseline.ids.length && posts.every((post, i) => post.id === baseline.ids[i]);
      if (this.precisionRestored) {
        const resetOnly = Math.abs((baseline.restoredY ?? baseline.y) - baseline.y) < 1;
        const documentGrew = this.win.document.documentElement.scrollHeight > baseline.documentHeight + 1;
        const replacement = !sameKnownIds && ((newNodes || newIds) && documentGrew || newNodes && resetOnly && (newIds || upperPlacementChanged));
        if (addedHeight === void 0 && !replacement) return;
        this.precisionRestored = false;
        baseline.addedHeight = addedHeight;
        baseline.updateAt = performance.now();
        this.sawUpdate = true;
        this.lastActivity = baseline.updateAt;
        return;
      }
      if (addedHeight !== void 0) baseline.addedHeight = addedHeight;
      if ((baseline.addedHeight !== void 0 || newIds || newNodes && upperPlacementChanged && !sameKnownIds) && baseline.updateAt === void 0) {
        baseline.updateAt = performance.now();
        this.sawUpdate = true;
        this.lastActivity = baseline.updateAt;
      }
    }
    rememberRestoration(posts, boxes, sampledY) {
      const baseline = this.measurement;
      if (!baseline) return;
      this.precisionRestored = true;
      baseline.boxes = boxes.map((box) => ({ element: box.element, y: box.top + sampledY }));
      baseline.ids = posts.map((post) => post.id);
      baseline.documentHeight = this.win.document.documentElement.scrollHeight;
      baseline.restoredY = this.win.scrollY;
    }
    approximationTarget() {
      const m = this.measurement;
      if (!m) return null;
      const addedHeight = m.addedHeight ?? (m.displayedCount && m.representativeHeight ? m.displayedCount * m.representativeHeight : void 0);
      return addedHeight === void 0 ? null : { y: m.y + addedHeight, addedHeight, estimated: m.addedHeight === void 0 };
    }
    approximationAt() {
      if (this.refreshStart === null || this.precisionRestored || !this.approximationTarget()) return null;
      return this.measurement?.updateAt === void 0 ? this.refreshStart + REFRESH_WAIT_MS : this.measurement.updateAt + APPROXIMATE_WAIT_MS;
    }
    approximate() {
      const m = this.measurement;
      if (!m || !this.geometryAvailable || this.precisionRestored || this.refreshStart === null) return;
      const readyAt = m.updateAt === void 0 ? this.refreshStart + REFRESH_WAIT_MS : m.updateAt + APPROXIMATE_WAIT_MS;
      if (performance.now() < readyAt) return;
      const target = this.approximationTarget();
      if (!target) {
        if (m.updateAt !== void 0 && this.missing) this.interrupt();
        return;
      }
      if (target.addedHeight > 5e4) {
        this.interrupt();
        return;
      }
      const maxY = Math.max(0, this.win.document.documentElement.scrollHeight - this.win.innerHeight);
      const plannedY = Math.max(0, Math.min(maxY, target.y));
      const before = this.win.scrollY;
      if (plannedY > before) this.win.scrollTo({ top: plannedY, behavior: "instant" });
      this.knownY = this.win.scrollY;
      this.interrupt();
    }
    changed(posts, context) {
      const boxes = context?.boxes ?? posts;
      const sampledY = this.win.scrollY;
      this.geometryAvailable = boxes.length > 0;
      if (this.checkDeadline() || !this.anchors.length && !this.refreshing || this.retired || performance.now() < this.quietUntil) return;
      const now = performance.now();
      if (this.refreshing) this.measureUpdate(posts, boxes);
      const moved = this.knownY - this.win.scrollY;
      const match = resolveAnchor(this.anchors, posts);
      const target = !match ? this.approximationTarget() : null;
      const maxY = Math.max(0, this.win.document.documentElement.scrollHeight - this.win.innerHeight);
      const nativeTolerance = target?.estimated ? Math.min(target.addedHeight * 0.15, (this.measurement?.representativeHeight ?? 0) * 2) : 1;
      const alreadyAnchored = target && this.win.scrollY > 1 && Math.abs(this.win.scrollY - Math.min(maxY, target.y)) <= nativeTolerance;
      if (moved && (!match || Math.abs(match.delta) >= 1) && !alreadyAnchored && !this.acceptScroll()) return;
      this.knownY = this.win.scrollY;
      if (!match) {
        if (this.refreshing && this.anchors.length && !this.missing) {
          this.sawUpdate = true;
          this.lastActivity = now;
        }
        this.missing = true;
        if (this.refreshing) this.approximate();
        else this.interrupt();
        return;
      }
      if (this.refreshing && (this.missing || Math.abs(match.delta - moved) >= 1)) {
        this.sawUpdate = true;
        this.lastActivity = now;
      }
      this.missing = false;
      if (this.refreshing && Math.abs(moved) >= 1 && Math.abs(match.delta) < 1) this.rememberRestoration(posts, boxes, sampledY);
      if (!this.until && Math.abs(match.delta) < 1) {
        this.capture(posts);
        return;
      }
      if (!this.until) this.until = now + CORRECTION_MS;
      if (Math.abs(match.delta) > 5e4) {
        this.interrupt();
        return;
      }
      if (Math.abs(match.delta) >= 1) {
        const before = this.win.scrollY;
        this.win.scrollBy({ top: match.delta, behavior: "instant" });
        this.knownY = this.win.scrollY;
        const actual = this.win.scrollY - before;
        if (Math.abs(actual - match.delta) > 1) this.interrupt();
        else if (this.refreshing && Math.abs(actual) >= 1) this.rememberRestoration(posts, boxes, sampledY);
      }
      if (this.refreshing) this.approximate();
    }
    scrolled(read, context) {
      if (this.checkDeadline()) return;
      const fallbackAt = this.approximationAt();
      if (Math.abs(this.win.scrollY - this.knownY) < 1 && !(this.geometryAvailable && fallbackAt !== null && performance.now() >= fallbackAt)) return;
      if (this.refreshing) {
        const posts = read();
        this.changed(posts, context?.());
      } else this.interrupt();
    }
    tick(posts, context) {
      if (this.checkDeadline()) return;
      if (this.refreshing) this.changed(posts, context);
      if (performance.now() >= this.quietUntil) this.needsIdle = false;
      this.capture(posts);
    }
  };

  // src/controller.ts
  var HomeController = class {
    constructor(doc, win) {
      this.doc = doc;
      this.win = win;
      this.keeper = new PositionKeeper(win);
      this.paintGuard = new RefreshPaintGuard(doc, win, () => this.checkScroll(), () => this.keeper.refreshing);
      this.refreshTotal = new RefreshTotal(doc);
      this.rootObserver = new MutationObserver(() => {
        this.reconcile();
        this.flush();
      });
      this.resizeObserver = new ResizeObserver(() => {
        if (this.root && this.isCurrent()) this.flush();
      });
      this.pageObserver = new MutationObserver((records) => {
        if (this.root && !this.root.isConnected) {
          this.reconcile();
          return;
        }
        if (this.root?.isConnected && this.lastPath === win.location.pathname && records.every((r) => this.root.contains(r.target))) return;
        this.schedule();
      });
      this.pageObserver.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "aria-label"] });
      const signal = this.lifecycle.signal;
      win.addEventListener("click", (event) => this.refreshTotal.activate(event, new URL(win.location.href)), { signal, capture: true });
      win.addEventListener("popstate", () => this.reconcile(), { signal });
      doc.addEventListener("visibilitychange", () => {
        if (doc.hidden) this.keeper.interrupt();
        this.reconcile();
      }, { signal });
      this.poll = win.setInterval(() => {
        if (this.lastPath !== win.location.pathname || !this.root?.isConnected) this.reconcile();
      }, 500);
      this.reconcile();
    }
    doc;
    win;
    kind = null;
    root = null;
    keeper;
    paintGuard;
    refreshTotal;
    state = "outside";
    overLimit = false;
    frame = 0;
    settleTimer = 0;
    expiryTimer = 0;
    poll = 0;
    disposed = false;
    lifecycle = new AbortController();
    inputs = null;
    rootObserver;
    resizeObserver;
    pageObserver;
    measured = /* @__PURE__ */ new Set();
    lastPath = "";
    lastKind = null;
    isCurrent() {
      return isHome(new URL(this.win.location.href)) && timelineKind(this.doc) === this.kind && !this.doc.hidden;
    }
    currentSample() {
      if (!this.root?.isConnected || timelineRoot(this.doc) !== this.root) return null;
      return readPosts(this.root);
    }
    schedule() {
      if (this.frame || this.disposed) return;
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        this.reconcile();
      });
    }
    detach() {
      this.rootObserver.disconnect();
      this.resizeObserver.disconnect();
      this.measured.clear();
      this.inputs?.abort();
      this.inputs = null;
      this.win.clearTimeout(this.settleTimer);
      this.win.clearTimeout(this.expiryTimer);
      this.root = null;
      this.paintGuard.stop();
    }
    settle() {
      this.win.clearTimeout(this.settleTimer);
      this.settleTimer = this.win.setTimeout(() => {
        if (!this.root || !this.isCurrent()) return;
        const sample = this.currentSample();
        if (sample?.overLimit) {
          this.keeper.interrupt();
          this.paintGuard.stop();
          return;
        }
        if (!sample) this.keeper.changed([], { boxes: [] });
        this.keeper.tick(sample?.posts ?? [], { boxes: sample?.boxes ?? [] });
      }, INPUT_QUIET_MS + 100);
    }
    expireCorrection() {
      this.win.clearTimeout(this.expiryTimer);
      if (this.keeper.correcting) this.expiryTimer = this.win.setTimeout(() => {
        if (this.isCurrent()) {
          const sample = this.currentSample();
          if (sample?.overLimit) {
            this.keeper.interrupt();
            this.paintGuard.stop();
            return;
          }
          if (!sample) this.keeper.changed([], { boxes: [] });
          this.keeper.tick(sample?.posts ?? [], { boxes: sample?.boxes ?? [] });
          this.expireCorrection();
          this.settle();
        }
      }, this.keeper.remainingMs + 1);
    }
    attach(root) {
      this.root = root;
      this.rootObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "data-testid", "role"] });
      this.inputs = new AbortController();
      const signal = this.inputs.signal;
      const interrupt = () => {
        this.keeper.input();
        this.paintGuard.stop();
        this.settle();
      };
      for (const type of ["wheel", "touchstart", "touchmove", "pointerdown"]) this.win.addEventListener(type, interrupt, { signal, passive: true, capture: true });
      this.win.addEventListener("keydown", (event) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "j", "k"].includes(event.key)) interrupt();
      }, { signal, capture: true });
      this.win.addEventListener("click", (event) => {
        const intent = clickIntent(event.target);
        if (intent === "refresh" && event.isTrusted && this.root && this.isCurrent() && this.state === "active") {
          const sample = this.currentSample();
          if (!sample || sample.overLimit) {
            this.keeper.interrupt();
            this.paintGuard.stop();
            return;
          }
          this.keeper.refresh(sample.posts, { boxes: sample.boxes, ...refreshDetails(event.target) });
          this.expireCorrection();
          if (this.keeper.refreshing) this.paintGuard.start();
        } else if (intent === "navigate") {
          this.keeper.interrupt();
          this.paintGuard.stop();
        }
        this.settle();
      }, { signal, capture: true });
      this.win.addEventListener("scroll", () => {
        this.checkScroll();
        this.settle();
      }, { signal, passive: true });
      this.flush();
    }
    checkScroll() {
      if (!this.isCurrent()) {
        this.keeper.interrupt();
        this.paintGuard.stop();
        return;
      }
      let sample = null;
      const current = () => {
        if (!sample && this.root) {
          sample = this.currentSample();
        }
        if (sample?.overLimit) {
          this.keeper.interrupt();
          return null;
        }
        return sample;
      };
      this.keeper.scrolled(() => current()?.posts ?? [], () => ({ boxes: current()?.boxes ?? [] }));
      if (!this.keeper.refreshing) this.paintGuard.stop();
    }
    reconcile() {
      if (this.disposed) return;
      this.lastPath = this.win.location.pathname;
      const home = isHome(new URL(this.win.location.href));
      this.refreshTotal.show(home);
      const kind = home ? timelineKind(this.doc) : null;
      const root = home ? timelineRoot(this.doc) : null;
      if (kind !== this.lastKind || !home) {
        this.keeper.interrupt();
        this.detach();
      }
      this.kind = kind;
      this.lastKind = kind;
      this.state = !home ? "outside" : !kind || !root || this.overLimit ? "unrecognized" : "active";
      const needsTimeline = home && kind && root && !this.doc.hidden;
      if (!needsTimeline) {
        if (home && kind && !root && !this.doc.hidden && this.keeper.refreshing) {
          this.rootObserver.disconnect();
          this.resizeObserver.disconnect();
          this.measured.clear();
          this.root = null;
          this.keeper.changed([], { boxes: [] });
          return;
        }
        this.keeper.interrupt();
        this.detach();
        this.overLimit = false;
        return;
      }
      if (root !== this.root) {
        this.detach();
        this.attach(root);
        if (this.keeper.refreshing) this.paintGuard.start();
      }
    }
    flush() {
      if (!this.root || !this.isCurrent()) return;
      const sample = this.currentSample();
      if (!sample) {
        this.keeper.changed([], { boxes: [] });
        return;
      }
      this.overLimit = sample.overLimit;
      this.state = sample.overLimit ? "unrecognized" : "active";
      const nodes = new Set(sample.boxes.map((p) => p.element));
      for (const element of this.measured) if (!nodes.has(element)) this.resizeObserver.unobserve(element);
      for (const element of nodes) if (!this.measured.has(element)) this.resizeObserver.observe(element);
      this.measured = nodes;
      if (this.state === "active") {
        this.keeper.changed(sample.posts, { boxes: sample.boxes });
        this.keeper.capture(sample.posts);
        this.expireCorrection();
      } else this.keeper.interrupt();
      this.settle();
    }
    status() {
      this.reconcile();
      return { state: this.state };
    }
    dispose() {
      this.disposed = true;
      this.keeper.interrupt();
      this.detach();
      this.lifecycle.abort();
      this.pageObserver.disconnect();
      this.refreshTotal.dispose();
      this.win.cancelAnimationFrame(this.frame);
      this.win.clearInterval(this.poll);
    }
  };

  // src/content.ts
  var singleton = /* @__PURE__ */ Symbol.for("x-home-anchor.instance");
  var scope = globalThis;
  scope[singleton]?.();
  function install() {
    const controller = new HomeController(document, window);
    const runtime = globalThis.chrome?.runtime;
    const onMessage = (message, sender, respond) => {
      if (!runtime?.id || sender.id !== runtime.id || typeof message !== "object" || message === null) return;
      const command = message.command;
      if (command === "status") respond(controller.status());
    };
    runtime?.onMessage?.addListener(onMessage);
    return () => {
      controller.dispose();
      runtime?.onMessage?.removeListener(onMessage);
    };
  }
  var uninstall = install();
  var onHide = () => uninstall();
  var onShow = (event) => {
    if (event.persisted) {
      uninstall();
      uninstall = install();
    }
  };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  scope[singleton] = () => {
    uninstall();
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
  };
})();
