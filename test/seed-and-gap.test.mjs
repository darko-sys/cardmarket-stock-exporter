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
      getManifest: () => ({ version: '2.4.3' }),
      getURL: (p) => p,
      onMessage: { addListener() {} },
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

test('stockCsvToSeedRows keeps ArticleIDs and expansion names', () => {
  const window = loadPopup();
  const csv = [
    'ArticleID;idProduct;Name;ExpansionCode;SetCode;CollectorNumber;Expansion;Rarity;Language;Condition;ConditionFull;ReverseHolo;Foil;FirstEd;Signed;Altered;Playset;FullArt;UberRare;WithDie;Comments;_OriginalComments;Price_EUR;_OriginalPrice_EUR;Amount;Total_EUR;ProductUrl;ImageUrl;delete',
    '"=""11""";"=""22""";"Card A";"DOM";"DOM";"";"Dominaria";"Common";"Deutsch";"EX";"Excellent";"N";"N";"N";"N";"N";"N";"N";"N";"N";"";"";"0,10";"0,10";"2";"0,20";"";"";"N"',
    '"=""12""";"=""23""";"Card B";"GDP";"";"";"Game Day Promos";"Rare";"Englisch";"NM";"Near Mint";"N";"Y";"N";"N";"N";"N";"N";"N";"N";"";"";"1,00";"1,00";"1";"1,00";"";"";"N"',
  ].join('\r\n');
  const seed = window.stockCsvToSeedRows(csv);
  assert.equal(seed.length, 2);
  assert.equal(seed[0].articleId, '11');
  assert.equal(seed[0].expansion, 'Dominaria');
  assert.equal(seed[0].amountDisplay, '2');
  assert.equal(seed[1].foil, true);
  const byExp = window.countSeedArticlesByExpansion(seed);
  assert.equal(byExp.get('dominaria'), 1);
  assert.equal(byExp.get('game day promos'), 1);
});

test('gap-fill scrape loads seed and only fetches short expansions thoroughly', async () => {
  const window = loadPopup();
  const calls = [];

  await window.chrome.storage.local.set({
    cmExportSeed: [
      ...Array.from({ length: 161 }, (_, i) => ({
        articleId: String(1000 + i),
        expansion: 'Dominaria',
        name: `D${i}`,
        amountDisplay: '1',
      })),
      {
        articleId: '2001',
        expansion: 'Game Day Promos',
        name: 'Only one',
        amountDisplay: '1',
      },
    ],
  });

  function pageHtml(selectExtra, ids, maxSite) {
    const select = `<select name="idExpansion">
      <option value="0">Alle</option>
      <option value="100">Dominaria (161)</option>
      <option value="200">Game Day Promos (4)</option>
      ${selectExtra || ''}
    </select>`;
    const links = Array.from({ length: maxSite }, (_, i) => `<a href="?site=${i + 1}">${i + 1}</a>`).join('');
    const rows = ids.map(id => `<div id="articleRow${id}" class="article-row"><a class="col-seller" href="/x">C${id}</a><span class="item-count">1</span></div>`).join('');
    return `<!DOCTYPE html><html><body>${select}${links}<div class="table-body">${rows}</div></body></html>`;
  }

  window.fetch = async (url) => {
    const u = new URL(url, 'https://www.cardmarket.com');
    const id = u.searchParams.get('idExpansion');
    const site = parseInt(u.searchParams.get('site') || '1', 10);
    calls.push({ id, site, sort: u.searchParams.get('sortBy') });
    let html;
    if (!id) html = pageHtml('', [], 1);
    else if (id === '100') {
      throw new Error('Dominaria must be skipped — seed already complete');
    } else if (id === '200') {
      if (site === 1) html = pageHtml('', [2001, 2002, 2003, 2004], 1);
      else html = pageHtml('', [], 1);
    } else html = pageHtml('', [], 1);
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
    selectedExpansionIds: null,
    splitParams: null,
    fastThenFill: true,
    gapFillOnly: true,
    useSeed: true,
  });

  assert.equal(result.error, undefined);
  assert.ok(!calls.some(c => c.id === '100'), 'complete Dominaria must not be re-fetched');
  assert.ok(calls.some(c => c.id === '200'), 'Game Day Promos shortfall must be fetched');
  const gameDay = result.rows.filter(r => String(r.expansion) === 'Game Day Promos' || String(r.articleId).startsWith('200'));
  assert.ok(gameDay.length >= 4);
  assert.ok(!result.completeness || result.completeness.missingTotal === 0
    || !result.completeness.shortfalls.some(s => String(s.name) === 'Dominaria'));
});
