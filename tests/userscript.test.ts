import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('userscript contains install metadata, the MIT license and only the content bundle', async () => {
  const script = await read('dist-userscript/x-home-anchor.user.js');
  const manifest = JSON.parse(await read('manifest.json'));
  const header = script.slice(0, script.indexOf('// ==/UserScript=='));
  assert.ok(script.startsWith('// ==UserScript==\n'));
  assert.ok(header.includes(`// @name         ${manifest.name}\n`));
  assert.ok(header.includes(`// @version      ${manifest.version}\n`));
  assert.ok(header.includes('// @namespace    https://github.com/H4M4CHi-ttr/x-home-anchor\n'));
  assert.deepEqual([...header.matchAll(/^\/\/ @match\s+(.*)$/gm)].map(match => match[1]), manifest.content_scripts[0].matches);
  assert.match(header, /^\/\/ @run-at\s+document-idle$/m);
  assert.match(header, /^\/\/ @noframes$/m);
  assert.match(header, /^\/\/ @grant\s+none$/m);
  assert.match(header, /^\/\/ @license\s+MIT$/m);
  assert.doesNotMatch(header, /@require|@resource|@connect/);
  const license = (await read('LICENSE')).trim();
  const content = await read('dist/content.js');
  assert.equal(script.slice(header.length), `// ==/UserScript==\n\n/*\n${license}\n*/\n\n${content}`);
});

for (const environment of ['no chrome', 'chrome without runtime', 'runtime without messaging', 'extension']) {
  test(`content starts, resumes and cleans up in ${environment}`, async () => {
    const hosts = new Set<object>();
    const intervals = new Set<number>();
    const listeners = new Set<Function>();
    const doc = Object.assign(new EventTarget(), {
      body: {}, hidden: false, querySelector: () => null,
      documentElement: { append(host: { isConnected: boolean }) { host.isConnected = true; hosts.add(host); } },
      createElement: () => ({
        isConnected: false,
        setAttribute() {},
        attachShadow: () => ({ append() {} }),
        remove() { this.isConnected = false; hosts.delete(this); },
      }),
    });
    const win = Object.assign(new EventTarget(), {
      location: new URL('https://x.com/home'),
      setInterval() { intervals.add(1); return 1; },
      clearInterval(id: number) { intervals.delete(id); },
      clearTimeout() {}, cancelAnimationFrame() {},
    });
    class Observer { observe() {} disconnect() {} }
    const context = createContext({
      document: doc, window: win, URL, AbortController, performance,
      MutationObserver: Observer, ResizeObserver: Observer,
    });
    if (environment !== 'no chrome') context.chrome = {};
    if (environment === 'runtime without messaging') context.chrome.runtime = {};
    if (environment === 'extension') context.chrome.runtime = {
      id: 'test-extension',
      onMessage: {
        addListener(listener: Function) { listeners.add(listener); },
        removeListener(listener: Function) { listeners.delete(listener); },
      },
    };
    // Exercise the delivered bundle with a minimal DOM; this is not a live-X test.
    const script = await read(environment === 'extension' ? 'dist/content.js' : 'dist-userscript/x-home-anchor.user.js');
    runInContext(script, context);
    assert.equal(hosts.size, 1);
    assert.equal(intervals.size, 1);
    assert.equal(listeners.size, environment === 'extension' ? 1 : 0);
    if (environment === 'extension') {
      const listener = [...listeners][0];
      let response: unknown;
      const respond = (value: unknown) => { response = value; };
      listener({ command: 'status' }, { id: 'another-extension' }, respond);
      listener(null, { id: 'test-extension' }, respond);
      listener({ command: 'unknown' }, { id: 'test-extension' }, respond);
      assert.equal(response, undefined);
      listener({ command: 'status' }, { id: 'test-extension' }, respond);
      assert.equal((response as { state: string }).state, 'unrecognized');
    }
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(hosts.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal(listeners.size, 0);
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    assert.equal(hosts.size, 1);
    runInContext(script, context);
    assert.equal(hosts.size, 1);
    assert.equal(intervals.size, 1);
    assert.equal(listeners.size, environment === 'extension' ? 1 : 0);
    runInContext('globalThis[Symbol.for("x-home-anchor.instance")]()', context);
    assert.equal(hosts.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal(listeners.size, 0);
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    assert.equal(hosts.size, 0);
  });
}
