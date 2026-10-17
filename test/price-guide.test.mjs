import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const root = new URL('..', import.meta.url);

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
      getManifest: () => ({ version: '2.5.0' }),
      getURL: (p) => p,
    },
    storage: {
      local: {
        _data: {},
        async get(keys) {
          if (keys == null) return { ...this._data };
          if (typeof keys === 'string') return { [keys]: this._data[keys] };
          const out = {};
          for (const k of keys) out[k] = this._data[k];
          return out;
        },
        async set(obj) { Object.assign(this._data, obj); },
        async remove(keys) {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete this._data[k];
        },
      },
    },
    i18n: { getUILanguage: () => 'de', getMessage: (key) => key },
    tabs: { query: async () => [], get: async () => null },
    scripting: { executeScript: async () => [{ result: null }] },
    downloads: { download: async () => {} },
  };
  window.eval(fs.readFileSync(new URL('i18n.js', root), 'utf8'));
  window.eval(fs.readFileSync(new URL('popup.js', root), 'utf8'));
  return window;
}

const fixture = JSON.parse(
  fs.readFileSync(new URL('fixtures/price_guide_sample.json', import.meta.url), 'utf8')
);

test('priceGuideUrl covers every game in the popup dropdown', () => {
  const window = loadPopup();
  const games = [...window.document.querySelectorAll('#game option')].map(o => o.value);
  for (const g of games) {
    const url = window.priceGuideUrl(g);
    assert.equal(typeof url, 'string', `missing guide url for ${g}`);
    assert.match(url, /price_guide_\d+\.json$/);
  }
});

function assertTrend(actual, trend, avg1, avg7, avg30) {
  assert.ok(actual, 'expected trend object');
  assert.equal(actual.trend, trend);
  assert.equal(actual.avg1, avg1);
  assert.equal(actual.avg7, avg7);
  assert.equal(actual.avg30, avg30);
}

test('trendFromGuideEntry picks foil / holo / reverse / fallback', () => {
  const window = loadPopup();
  const byId = window.indexPriceGuides(fixture.priceGuides);

  const magic = byId.get('1001');
  assertTrend(window.trendFromGuideEntry(magic, { foil: false }), '1,50', '1,40', '1,45', '1,60');
  assertTrend(window.trendFromGuideEntry(magic, { foil: true }), '9,99', '9,50', '9,70', '10,10');

  const poke = byId.get('2002');
  assertTrend(window.trendFromGuideEntry(poke, { foil: true }), '3,93', '3,50', '3,70', '4,00');

  const withRev = byId.get('3003');
  assertTrend(window.trendFromGuideEntry(withRev, { reverse: true }), '5,50', '5,00', '5,20', '5,80');

  const noRev = byId.get('4004');
  assertTrend(window.trendFromGuideEntry(noRev, { reverse: true }), '0,80', '0,75', '0,78', '0,85');
});

test('applyPriceGuideToRows joins by idProduct and fills CSV trend cells', () => {
  const window = loadPopup();
  const byId = window.indexPriceGuides(fixture.priceGuides);
  const rows = [
    { idProduct: '1001', foil: false, reverse: false, price: '2,00', amountDisplay: '1' },
    { idProduct: '1001', foil: true, reverse: false, price: '8,00', amountDisplay: '1' },
    { idProduct: '2002', foil: true, reverse: false, price: '4,00', amountDisplay: '2' },
    { idProduct: '', foil: false, reverse: false, price: '1,00', amountDisplay: '1' },
    { idProduct: '999999', foil: false, reverse: false, price: '1,00', amountDisplay: '1' },
  ];
  const stats = window.applyPriceGuideToRows(rows, byId);
  assert.equal(stats.matched, 3);
  assert.equal(stats.skippedNoId, 1);
  assert.equal(stats.missingInGuide, 1);
  assert.equal(rows[0].trend.trend, '1,50');
  assert.equal(rows[1].trend.trend, '9,99');
  assert.equal(rows[2].trend.avg30, '4,00');
  assert.equal(rows[3].trend, undefined);

  const csv = window.buildCsv(rows);
  assert.match(csv, /TrendPrice_EUR;Avg1_EUR;Avg7_EUR;Avg30_EUR;PriceVsTrend_Pct/);
  assert.match(csv, /"1,50";"1,40";"1,45";"1,60"/);
  assert.match(csv, /"9,99";"9,50";"9,70";"10,10"/);
});
