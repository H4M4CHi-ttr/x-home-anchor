import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// CDP supplies sustained trusted input unavailable in the MCP click interface.
// Every network request is fulfilled locally or aborted; no live X is contacted.
const root = new URL('../', import.meta.url);
const evidencePrefix = 'refresh-viewport';
const fixture = await readFile(new URL('tests/fixtures/repost.html', root), 'utf8');
let activeFixture = fixture;
const content = await readFile(new URL('dist/content.js', root), 'utf8');
const profile = await mkdtemp(join(tmpdir(), 'x-home-anchor-browser-'));
const browser = spawn(process.env.CHROME_BIN ?? '/opt/google/chrome/chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-extensions', '--remote-debugging-pipe',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let sequence = 0;
let buffer = '';
const waiting = new Map();
const callbacks = new Map();
const errors = [];
let ended = false;
const exited = new Promise(resolve => {
  const finish = error => {
    ended = true;
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear(); resolve();
  };
  browser.once('error', error => finish(error));
  browser.once('exit', (code, signal) => finish(new Error(`Chrome exited (${signal ?? code})`)));
});
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  for (let end; (end = buffer.indexOf('\0')) !== -1;) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id) {
      const pending = waiting.get(message.id); waiting.delete(message.id);
      if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
      else pending?.resolve(message.result);
    } else callbacks.get(message.method)?.(message);
  }
});
function send(method, params = {}, sessionId) {
  if (ended) return Promise.reject(new Error('Chrome has already exited'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
const deadline = setTimeout(() => browser.kill('SIGKILL'), 90000);
let session;
const command = (method, params) => send(method, params, session);
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const reports = {};
try {
  const version = await send('Browser.getVersion');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await send('Target.attachToTarget', { targetId, flatten: true }));
  callbacks.set('Runtime.exceptionThrown', message => errors.push(message.params.exceptionDetails));
  callbacks.set('Fetch.requestPaused', message => {
    const { requestId, request, resourceType } = message.params;
    void (resourceType === 'Document' && request.url.startsWith('https://x.com/')
      ? command('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(activeFixture).toString('base64') })
      : command('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })).catch(error => errors.push(String(error)));
  });
  await command('Page.enable'); await command('Runtime.enable');
  await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await command('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  async function reset(path = '/home') {
    await command('Page.navigate', { url: 'https://x.com' + path });
    for (let i = 0; i < 100; i++) {
      if (await evaluate('document.readyState === "complete" && !!window.events')) break;
      await delay(20);
    }
    await evaluate(content);
  }
  const read = () => evaluate('({events, menuClicks, navigations, url:location.href, scrollY, result:document.querySelector("#result").textContent})');
  const point = () => evaluate('(()=>{const r=document.querySelector("button[data-testid=retweet], button[data-testid=unretweet]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  async function mouse(type, point, button = 'left') {
    await command('Input.dispatchMouseEvent', { type, ...point, button, buttons: type === 'mouseReleased' ? 0 : button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: 1 });
  }
  async function press(point) { await mouse('mouseMoved', point); await mouse('mousePressed', point); }
  await reset();
  let p = await point();
  await press(p); await delay(100); await mouse('mouseReleased', p);
  let result = await read();
  assert.equal(result.menuClicks, 1); assert.equal(result.navigations.length, 0);
  reports.shortClick = result;

  await reset(); await evaluate(content); p = await point(); await press(p); await delay(400);
  assert.equal((await read()).navigations.length, 0);
  await delay(290); result = await read();
  assert.deepEqual(result.navigations, ['https://x.com/outer/status/111/quotes']);
  assert.equal(result.menuClicks, 0);
  assert.equal(result.events.some(event => event.type === 'pointerup'), false);
  const elapsed = result.events.find(event => event.type === 'quotes').at - result.events.find(event => event.type === 'pointerdown').at;
  assert.ok(elapsed >= 595 && elapsed < 800, `navigation onset ${elapsed}ms`);
  assert.ok(result.events.some(event => event.type === 'quotes-frame' && event.text.includes('/outer/status/111/quotes')));
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL(`verification/${evidencePrefix}-hold.png`, root), Buffer.from(screenshot.data, 'base64'));
  await mouse('mouseReleased', p); assert.equal((await read()).menuClicks, 0);
  await press(p); await delay(40); await mouse('mouseReleased', p);
  assert.equal((await read()).menuClicks, 1);
  reports.mouseHold = { beforeRelease: result, elapsedMs: elapsed, afterNextClick: await read() };

  for (const kind of ['move', 'leave', 'scroll', 'replacement', 'route', 'dispose']) {
    await reset(); p = await point(); await press(p); await delay(180);
    if (kind === 'move') await mouse('mouseMoved', { x: p.x + 15, y: p.y });
    if (kind === 'leave') await mouse('mouseMoved', { x: p.x + 100, y: p.y });
    if (kind === 'scroll') await evaluate('scrollBy(0, 50)');
    if (kind === 'replacement') await evaluate('(()=>{const b=document.querySelector("button[data-testid=retweet]");b.replaceWith(b.cloneNode(true))})()');
    if (kind === 'route') await evaluate('history.pushState({}, "", "/explore"); history.pushState({}, "", "/home")');
    if (kind === 'dispose') await evaluate('globalThis[Symbol.for("x-home-anchor.instance")]()');
    await delay(500); result = await read(); assert.equal(result.navigations.length, 0, kind);
    await mouse('mouseReleased', p); reports[kind] = result;
  }

  await reset('/outer/status/111');
  await command('Emulation.setTouchEmulationEnabled', { enabled: true });
  p = await point();
  const touch = type => command('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ ...p, id: 0, radiusX: 2, radiusY: 2 }] });
  await touch('touchStart'); await delay(100); await touch('touchEnd');
  assert.equal((await read()).menuClicks, 1);
  await evaluate('document.querySelector("#menu")?.remove(); menuClicks=0; events=[]; navigations=[]; document.querySelector("button[data-testid=retweet]").dataset.testid="unretweet"');
  await touch('touchStart'); await delay(400); assert.equal((await read()).navigations.length, 0);
  await delay(300); result = await read(); assert.equal(result.navigations.length, 1); assert.equal(result.menuClicks, 0);
  await touch('touchEnd'); await delay(60); assert.equal((await read()).menuClicks, 0);
  reports.touchHoldOnDetailPage = { beforeRelease: result, afterRelease: await read() };

  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await reset(); p = await point();
  for (const button of ['right', 'middle']) {
    await mouse('mouseMoved', p, button); await mouse('mousePressed', p, button);
    await delay(650); await mouse('mouseReleased', p, button);
  }
  assert.equal((await read()).navigations.length, 0);
  reports.otherMouseInputs = await read();
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await reset();
  await evaluate('document.querySelector("button[data-testid=retweet]").focus()');
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : '' });
  assert.equal((await read()).menuClicks, 1);
  reports.otherInputs = await read();
  activeFixture = await readFile(new URL('tests/fixtures/refresh.html', root), 'utf8');
  async function beginRefresh(scenario = 'virtualized') {
    await reset();
    await evaluate(`window.scenario=${JSON.stringify(scenario)};scrollTo(0,1050)`); await delay(1000);
    const before = await evaluate('readViewport()');
    p = await evaluate('(()=>{const r=document.querySelector("#refresh").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await press(p); await mouse('mouseReleased', p);
    return before;
  }
  const beforeRefresh = await beginRefresh();
  await delay(300);
  assert.deepEqual(await evaluate('Array.from(document.querySelector("#x-home-refresh-cover canvas").getContext("2d").getImageData(0,0,1,1).data)'), [220, 80, 140, 255]);
  const coverShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL(`verification/${evidencePrefix}-refresh-cover.png`, root), Buffer.from(coverShot.data, 'base64'));
  await delay(3300);
  const refreshed = await evaluate('({frames, final:readViewport(), counter:document.querySelector("#x-home-new-post-total").getAttribute("aria-label")})');
  assert.ok(refreshed.frames.some(frame => frame.covered), 'refresh must retain the old viewport while the virtualized list is replaced');
  assert.ok(refreshed.frames.every(frame => frame.post?.id === beforeRefresh.post.id && Math.abs(frame.post.top - beforeRefresh.post.top) < 1), 'no intermediate frame may reveal the reset or a different post');
  assert.equal(refreshed.final.covered, false);
  assert.equal(refreshed.final.post.id, beforeRefresh.post.id);
  assert.ok(Math.abs(refreshed.final.post.top - beforeRefresh.post.top) < 1);
  assert.equal(refreshed.final.y, 1050 + 35 * 195, 'recover the exact anchor after the document-growth estimate');
  assert.match(refreshed.counter, /35$/);
  reports.refresh = { before: beforeRefresh, after: refreshed.final, checkedFrames: refreshed.frames.length, coveredFrames: refreshed.frames.filter(frame => frame.covered).length };
  const refreshShot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL(`verification/${evidencePrefix}-refresh.png`, root), Buffer.from(refreshShot.data, 'base64'));
  await beginRefresh(); await delay(300);
  const coveredAction = await evaluate('(()=>{const r=document.querySelector("#underlying-action").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await press(coveredAction); await mouse('mouseReleased', coveredAction);
  assert.equal(await evaluate('badClicks'), 0, 'a click on the frozen viewport must not activate a different underlying post');
  assert.equal(await evaluate('readViewport().covered'), false);
  await press(coveredAction); await mouse('mouseReleased', coveredAction);
  assert.equal(await evaluate('badClicks'), 1, 'the next intentional click must work normally');
  reports.refreshClickCancellation = true;

  for (const action of ['wheel', 'resize', 'tab', 'dispose']) {
    await beginRefresh(); await delay(300);
    if (action === 'wheel') await command('Input.dispatchMouseEvent', { type:'mouseWheel', x:400, y:400, deltaX:0, deltaY:240 });
    if (action === 'resize') await command('Emulation.setDeviceMetricsOverride', { width:810, height:900, deviceScaleFactor:1, mobile:false });
    if (action === 'tab') await evaluate('document.querySelector("[role=tab]").textContent="Following";document.querySelector("[role=tab]").setAttribute("aria-selected","true")');
    if (action === 'dispose') await evaluate('globalThis[Symbol.for("x-home-anchor.instance")]()');
    await delay(100);
    assert.equal(await evaluate('readViewport().covered'), false, action);
    const cancelledY = await evaluate('scrollY');
    await delay(1000);
    assert.equal(await evaluate('scrollY'), cancelledY, `${action} must not resume the cancelled estimate`);
    reports[`refreshCancel_${action}`] = true;
    if (action === 'resize') await command('Emulation.setDeviceMetricsOverride', { width:800, height:900, deviceScaleFactor:1, mobile:false });
  }
  for (const scenario of ['replacement', 'late-page-scroll', 'imprecise-height']) {
    const beforeReplacement = await beginRefresh(scenario); await delay(3600);
    const replacementResult = await evaluate('({frames,final:readViewport()})');
    assert.ok(replacementResult.frames.every(frame => frame.post?.id === beforeReplacement.post.id && Math.abs(frame.post.top - beforeReplacement.post.top) < 1), 'a replaced timeline must retain the original viewport copy');
    assert.equal(replacementResult.final.covered, false);
    assert.equal(replacementResult.final.post.id, beforeReplacement.post.id);
    reports[`refresh_${scenario}`] = { before:beforeReplacement, after:replacementResult.final, checkedFrames:replacementResult.frames.length };
  }

  await reset(); await evaluate('window.scenario="no-update";document.querySelector("#refresh").textContent="Show new posts";scrollTo(0,1050)'); await delay(1000);
  p = await evaluate('(()=>{const r=document.querySelector("#refresh").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await press(p); await mouse('mouseReleased', p); await delay(3300);
  assert.equal(await evaluate('readViewport().covered'), false, 'an unchanged timeline must not stay frozen');
  assert.equal(await evaluate('scrollY'), 1050);
  reports.refreshNoUpdate = true;
  assert.deepEqual(errors, []);
  const output = { date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }),
    browser: version.product, method: 'Headless Chrome CDP trusted input; unchanged dist/content.js; synthetic HTTPS documents; runtime messaging stub; same-document quotes navigation intercepted by fixture; all requests fulfilled or blocked', reports, errors };
  await writeFile(new URL(`verification/${evidencePrefix}-browser.json`, root), JSON.stringify(output, null, 2) + '\n');
  console.log(`Browser verification passed (${version.product}); mouse hold navigation ${elapsed.toFixed(1)} ms`);
} finally {
  if (!ended) void send('Browser.close').catch(() => {});
  const forced = setTimeout(() => browser.kill('SIGKILL'), 3000);
  await exited; clearTimeout(forced); clearTimeout(deadline);
  await rm(profile, { recursive: true, force: true });
}
