#!/usr/bin/env node
/* =============================================================
 * Recruit FR — スモークテスト
 * 「全ページが壊れてないか」「データ移行が壊れてないか」を
 *  30秒で機械チェックする健康診断。
 *
 *  使い方:
 *    npm i jsdom         (初回のみ・開発用)
 *    node smoke-test.js  (index.html を直したあと毎回)
 *
 *  落ちたページ/失敗した検査だけを赤で出し、終了コードで成否を返す。
 * ============================================================= */
const fs = require('fs');
const path = require('path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.error('jsdom が無いよ。 `npm i jsdom` を実行してね（開発用の依存・本番には含めない）');
  process.exit(2);
}

const FILE = path.join(__dirname, 'index.html');
if (!fs.existsSync(FILE)) { console.error('index.html が見つからない:', FILE); process.exit(2); }
const html = fs.readFileSync(FILE, 'utf-8');

const RED = s => '\x1b[31m' + s + '\x1b[0m';
const GRN = s => '\x1b[32m' + s + '\x1b[0m';
const DIM = s => '\x1b[2m' + s + '\x1b[0m';

const fails = [];
const oks = [];
function check(name, fn) {
  try { fn(); oks.push(name); }
  catch (e) { fails.push({ name, err: (e && e.stack) || String(e) }); }
}

let dom;
try {
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.org/recruit-report/'
    // resources は読み込まない → Firebase等のCDNは取りに行かず「ローカルモード」で起動
  });
} catch (e) {
  console.error(RED('FATAL: index.html の読み込み/スクリプト実行で例外'));
  console.error((e && e.stack) || e);
  process.exit(1);
}

const win = dom.window;
const ev = expr => win.eval(expr); // const宣言の実体（PAGE_RENDERERS等）に到達するため

// ---- 1. 基本グローバルが存在するか ----
check('globals exist', () => {
  if (typeof ev('typeof PAGE_RENDERERS') !== 'string' || ev('typeof PAGE_RENDERERS') !== 'object')
    throw new Error('PAGE_RENDERERS が object でない: ' + ev('typeof PAGE_RENDERERS'));
  ['NAV', 'DEFAULT_LC_DATA', 'migrateLcData', 'CURRENT_SCHEMA_VERSION', 'REMOVED_PAGES'].forEach(g => {
    if (ev('typeof ' + g) === 'undefined') throw new Error(g + ' が未定義');
  });
});

// ---- 2. NAV ↔ PAGE_RENDERERS 整合性 ----
const NAV = ev('NAV');
const PR = ev('PAGE_RENDERERS');
const REMOVED = ev('REMOVED_PAGES');
const navPages = [];
NAV.forEach(g => (g.items || []).forEach(i => navPages.push(i.page)));

check('every NAV page has a renderer', () => {
  const missing = navPages.filter(p => typeof PR[p] !== 'function');
  if (missing.length) throw new Error('renderer 無し: ' + missing.join(', '));
});
check('REMOVED_PAGES are not in NAV', () => {
  const leaked = navPages.filter(p => REMOVED.includes(p));
  if (leaked.length) throw new Error('削除済みがNAVに残存: ' + leaked.join(', '));
});

// ---- 3. 全ページ描画（例外が出ないこと） ----
const body = win.document.body;
const container = win.document.createElement('div');
container.id = '__smoke_root__';
body.appendChild(container);

const targets = Array.from(new Set([...navPages, 'mc_dashboard', 'overview']));
// mc_dashboard が集約データを参照しても落ちないよう空集計をセット
try { ev('typeof _mcAllLcs !== "undefined"') && win.eval('_mcAllLcs = {};'); } catch (e) {}

targets.forEach(page => {
  check('render: ' + page, () => {
    const fn = PR[page];
    if (typeof fn !== 'function') throw new Error('renderer が無い');
    const data = win.eval('DEFAULT_LC_DATA()');
    container.innerHTML = '';
    fn(container, data); // 例外が出たら fail
    if (!container.innerHTML || container.innerHTML.length < 10)
      throw new Error('描画結果がほぼ空（innerHTML=' + container.innerHTML.length + '）');
  });
});

// ---- 4. マイグレーションが壊れてないこと ----
check('migrate: 空オブジェクト', () => {
  const out = win.eval('migrateLcData({})');
  if (!out.meta || out.meta.schemaVersion !== ev('CURRENT_SCHEMA_VERSION'))
    throw new Error('schemaVersion がスタンプされていない');
});
check('migrate: 廃止キーが除去される', () => {
  win.eval('window.__t = { meta:{}, reach_overall:{ purpose:"x", board:{} }, customer_journey:{ design:"x", good:"y", more:"z" } }');
  const out = win.eval('migrateLcData(window.__t)');
  if ('purpose' in (out.reach_overall || {})) throw new Error('reach_overall.purpose が残ってる');
  if ('design' in (out.customer_journey || {})) throw new Error('customer_journey.design が残ってる');
  if (out.meta.schemaVersion !== ev('CURRENT_SCHEMA_VERSION')) throw new Error('version 未更新');
});
check('migrate: 既存値を破壊しない（不足のみ補完）', () => {
  win.eval('window.__u = { meta:{ schemaVersion: ' + ev('CURRENT_SCHEMA_VERSION') + ' }, overview:{ target_total:"999" } }');
  const out = win.eval('migrateLcData(window.__u)');
  if (out.overview.target_total !== '999') throw new Error('既存値が壊された');
  if (!('actual_total' in out.overview)) throw new Error('不足キーが補完されていない');
});

// ---- 結果 ----
console.log('');
oks.forEach(n => console.log(GRN('  PASS ') + DIM(n)));
fails.forEach(f => { console.log(RED('  FAIL ') + f.name); console.log(DIM('       ' + f.err.split('\n').slice(0, 3).join('\n       '))); });
console.log('');
console.log((fails.length ? RED : GRN)(`${oks.length} passed, ${fails.length} failed`));
process.exit(fails.length ? 1 : 0);
