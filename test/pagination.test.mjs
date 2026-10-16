import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const root = new URL('..', import.meta.url);

function row(id, amount = 1) {
  return `<div id="articleRow${id}" class="article-row"><a class="col-seller" href="/Products/Singles/X/Card-${id}">Card ${id}</a><span class="item-count">${amount}</span></div>`;
}

function links(n) {
  return Array.from({ length: n }, (_, i) => `<a href="?idExpansion=1&amp;site=${i + 1}">${i + 1}</a>`).join('');
}

function page(ids, maxSite) {
  const select = `<select name="idExpansion">
    <option value="0">Alle</option>
    <option value="100">Dominaria (161)</option>
    <option value="200">Game Day Promos (4)</option>
    <option value="300">Phantom Promos (2)</option>
  </select>`;
  return `<!DOCTYPE html><html><body>${select}${links(maxSite)}<div class="table-body">${ids.map(id => row(id)).join('')}</div></body></html>`;
}

function range(from, to) {
  const ids = [];
  for (let i = from; i <= to; i++) ids.push(i);
  return ids;
}

function loadPopup() {
  const html = fs.readFileSync(new URL('popup.html', root), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(html, {
    url: 'https://extension.invalid/popup.html',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '2.4.3' }),
      getURL: (p) => p,
      onMessage: { addListener() {} },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    i18n: { getUILanguage: () => 'de', getMessage: (key) => key },
    tabs: { query: async () => [], get: async () => null },
    scripting: { executeScript: async () => [{ result: null }] },
    downloads: { download: async () => {} },
  };
  window.eval(fs.readFileSync(new URL('i18n.js', root), 'utf8'));
  window.eval(fs.readFileSync(new URL('popup.js', root), 'utf8'));
  return window;
}

test('Dominaria keeps the short last page, and an empty first page is not an empty expansion', async () => {
  const window = loadPopup();
  const calls = [];
  let fetches = 0;

  window.fetch = async (url) => {
    if (++fetches > 250) throw new Error(`fetch storm at ${url}`);
    const u = new URL(url, 'https://www.cardmarket.com');
    const id = u.searchParams.get('idExpansion');
    const site = parseInt(u.searchParams.get('site') || '1', 10);
    const sort = u.searchParams.get('sortBy');
    const key = `${id || ''}|${site}|${sort || ''}`;
    const attempt = calls.filter(c => c.key === key).length + 1;
    calls.push({ key, id, site, sort, attempt, url: String(url) });

    let html;
    if (!id) {
      html = page([], 1);
    } else if (id === '100') {
      if (sort) throw new Error(`Dominaria fell through to sort=${sort} at site=${site}`);
      if (site >= 1 && site <= 8) html = page(range((site - 1) * 20 + 1, site * 20), 9);
      else if (site === 9 && attempt === 1) html = page(range(141, 160), 9);
      else if (site === 9) html = page([161], 9);
      else html = page([], 9);
    } else if (id === '200') {
      if (sort) throw new Error(`Game Day Promos fell through to sort=${sort}`);
      // First page is empty, including the one retry. The pager still points at page 2.
      if (site === 1) html = page([], 2);
      else if (site === 2) html = page([1001, 1002, 1003, 1004], 2);
      else html = page([], 2);
    } else if (id === '300') {
      html = page([], 0);
    } else {
      throw new Error(`unexpected url ${url}`);
    }

    return { status: 200, ok: true, text: async () => html };
  };

  window.__cmExportStop = false;
  const warns = [];
  const origWarn = window.console.warn.bind(window.console);
  window.console.warn = (...args) => {
    warns.push(args.map(String).join(' '));
    origWarn(...args);
  };

  const result = await window.injectedScrapeAll({
    maxPages: 0,
    delay: 0,
    retryMs: 0,
    basePath: 'https://www.cardmarket.com/de/Magic/Stock',
    useSortBy: false,
    perExpansion: true,
    cardLangIds: null,
    selectedExpansionIds: null,
    splitParams: null,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.aborted, false);

  const ids = Array.from(result.rows, r => String(r.articleId));
  const dominaria = ids.filter(id => Number(id) >= 1 && Number(id) <= 161);
  assert.equal(dominaria.length, 161, `Dominaria yielded ${dominaria.length} articles`);
  assert.ok(ids.includes('161'), 'the single listing on the last page is missing');

  const gameDay = ids.filter(id => Number(id) >= 1000).sort();
  assert.deepEqual(gameDay, ['1001', '1002', '1003', '1004']);
  assert.ok(calls.some(c => c.id === '200' && c.site === 1 && c.attempt === 2));
  assert.ok(calls.some(c => c.id === '200' && c.site === 2));

  const dominariaPage9 = calls.filter(c => c.id === '100' && c.site === 9 && !c.sort);
  assert.equal(dominariaPage9.length, 2, 'the duplicate last page has to be read again');

  const phantom = Array.from(result.completeness.shortfalls, s => ({
    name: String(s.name),
    expected: s.expected,
    observed: s.observed,
    emptyFirstPage: !!s.emptyFirstPage,
  })).find(s => s.name === 'Phantom Promos');
  assert.ok(phantom, 'an expansion with a menu count and an empty first page must stay incomplete');
  assert.equal(phantom.expected, 2);
  assert.equal(phantom.observed, 0);
  assert.equal(phantom.emptyFirstPage, true);
  assert.ok(result.completeness.missingTotal > 0);
  assert.equal(window.stockExportMarkedPartial(result), true);
  assert.equal(window.stockExportMarkedPartial({
    aborted: false,
    completeness: { ...result.completeness, missingTotal: 0, shortfalls: [] },
  }), false);

  assert.ok(!Array.from(result.completeness.shortfalls).some(s => String(s.name) === 'Dominaria'));
  assert.ok(!Array.from(result.completeness.shortfalls).some(s => String(s.name) === 'Game Day Promos'));
  assert.ok(warns.some(w => w.includes('Phantom Promos') && w.includes('erwartet 2') && w.includes('gesehen 0')));
  assert.ok(!warns.some(w => w.includes('Dominaria') && w.includes('gesehen')));
});

test('meeting the menu count above 300 does not start the language cascade', async () => {
  const window = loadPopup();
  const TARGET = 302;
  const maxSite = Math.ceil(TARGET / 20);
  const calls = [];

  window.fetch = async (url) => {
    const u = new URL(url, 'https://www.cardmarket.com');
    const id = u.searchParams.get('idExpansion');
    const site = parseInt(u.searchParams.get('site') || '1', 10);
    const lang = u.searchParams.get('idLanguage');
    calls.push({ id, site, lang, sort: u.searchParams.get('sortBy') });
    if (lang) throw new Error(`language cascade started after menu count was met (lang=${lang})`);

    const select = `<select name="idExpansion">
      <option value="0">Alle</option>
      <option value="400">Amonkhet (${TARGET})</option>
    </select>`;
    let ids = [];
    if (id === '400') {
      const from = (site - 1) * 20 + 1;
      const to = Math.min(site * 20, TARGET);
      if (from <= TARGET) ids = range(from, to);
    }
    const html = `<!DOCTYPE html><html><body>${select}${links(maxSite)}<div class="table-body">${ids.map(x => row(x)).join('')}</div></body></html>`;
    return { status: 200, ok: true, text: async () => html };
  };

  window.__cmExportStop = false;
  const result = await window.injectedScrapeAll({
    maxPages: 0,
    delay: 0,
    retryMs: 0,
    basePath: 'https://www.cardmarket.com/de/Magic/Stock',
    useSortBy: false,
    perExpansion: true,
    cardLangIds: null,
    selectedExpansionIds: ['400'],
    splitParams: null,
  });

  assert.equal(result.rows.length, TARGET);
  assert.equal(result.completeness.missingTotal, 0);
  assert.ok(!calls.some(c => c.lang));
  assert.ok(!calls.some(c => c.sort === 'price_desc'));
});

test('short of the menu count never invents pages beyond the closed plan', async () => {
  const window = loadPopup();
  const TARGET = 80;
  const maxSite = 3; // Cardmarket pager stops at 3 (60 rows); menu claims 80
  const sites = [];

  window.fetch = async (url) => {
    const u = new URL(url, 'https://www.cardmarket.com');
    const id = u.searchParams.get('idExpansion');
    const site = parseInt(u.searchParams.get('site') || '1', 10);
    if (id === '500') sites.push(site);
    if (site > 4) throw new Error(`ran past closed plan to site=${site}`);

    const select = `<select name="idExpansion">
      <option value="0">Alle</option>
      <option value="500">Capped Set (${TARGET})</option>
    </select>`;
    let ids = [];
    if (id === '500' && site >= 1 && site <= maxSite) {
      ids = range((site - 1) * 20 + 1, site * 20);
    }
    const html = `<!DOCTYPE html><html><body>${select}${links(maxSite)}<div class="table-body">${ids.map(x => row(x)).join('')}</div></body></html>`;
    return { status: 200, ok: true, text: async () => html };
  };

  window.__cmExportStop = false;
  const result = await window.injectedScrapeAll({
    maxPages: 0,
    delay: 0,
    retryMs: 0,
    basePath: 'https://www.cardmarket.com/de/Magic/Stock',
    useSortBy: false,
    perExpansion: true,
    cardLangIds: null,
    selectedExpansionIds: ['500'],
    splitParams: null,
  });

  assert.equal(Math.max(...sites), 4, 'menu count plans page 4; must not go further');
  assert.ok(result.rows.length <= 60);
  assert.ok(result.completeness.missingTotal > 0);
});
