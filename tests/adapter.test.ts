import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { timelineKind } from '../src/adapter.ts';
import { environment } from './helpers/hold-dom.ts';

function fixture(t: TestContext, labels = ['おすすめ', 'フォロー中', 'AI', 'ソフトウェア', 'おすすめ']) {
  const f = environment(t);
  const primary = f.element('main', { 'data-testid': 'primaryColumn' });
  const list = f.element('div', { role: 'tablist' });
  const tabs = labels.map(text => { const tab = f.element('div', { role: 'tab' }); tab.textContent = text; return tab; });
  list.append(...tabs); primary.append(list); f.doc.body.append(primary);
  const select = (index: number) => {
    tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String(i === index)));
    return timelineKind(f.doc as unknown as Document);
  };
  return { ...f, primary, tabs, select };
}

test('home recognizes distinct custom timelines as well as the built-in tabs', t => {
  const f = fixture(t);
  const keys = [0, 1, 2, 3].map(f.select);
  assert.ok(keys.every(key => key !== null));
  assert.equal(new Set(keys).size, 4);
});

test('a custom timeline named like a built-in tab has a separate identity', t => {
  const f = fixture(t);
  assert.notEqual(f.select(0), f.select(4));
});

test('missing selection, blank labels and selected tabs inside posts are not home timelines', t => {
  const f = fixture(t);
  assert.equal(f.select(-1), null);
  f.tabs[2].textContent = '  ';
  assert.equal(f.select(2), null);
  f.select(-1);
  const postTab = f.element('div', { role: 'tab', 'aria-selected': 'true' }); postTab.textContent = 'For you';
  const article = f.element('article', { 'data-testid': 'tweet' }); article.append(postTab); f.primary.append(article);
  assert.equal(timelineKind(f.doc as unknown as Document), null);
});
