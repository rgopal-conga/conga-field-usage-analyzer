import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NO_PROJECT, NO_CALLBACK, projectLabel, accessLabel, callbackLabels, filterOptions, searchTerms, customCodeRowVisible } from '../public/resultFilters.js';

const items = [
  { projectName: 'QuoteHooks', access: 'Read' },
  { projectName: 'quoteHooks2', access: 'Write' },
  { projectName: 'QuoteHooks', access: 'Write' },
  { projectName: '', access: 'Condition' },
  { access: 'Condition' }
];

test('project and access options are distinct, counted and sorted with (No project) last', () => {
  assert.deepEqual(filterOptions(items, projectLabel), [
    { value: 'QuoteHooks', count: 2 }, { value: 'quoteHooks2', count: 1 }, { value: NO_PROJECT, count: 2 }
  ]);
  assert.deepEqual(filterOptions(items, accessLabel), [
    { value: 'Condition', count: 2 }, { value: 'Read', count: 1 }, { value: 'Write', count: 2 }
  ]);
  assert.deepEqual(filterOptions([], projectLabel), []);
});

test('rows match project, access and every search word together', () => {
  const visible = (filters, text = '') => items.map((item) => customCodeRowVisible(item, text, filters));
  assert.deepEqual(visible({}), [true, true, true, true, true]);
  assert.deepEqual(visible({ project: 'QuoteHooks' }), [true, false, true, false, false]);
  assert.deepEqual(visible({ access: 'Write' }), [false, true, true, false, false]);
  assert.deepEqual(visible({ project: 'QuoteHooks', access: 'Write' }), [false, false, true, false, false]);
  assert.deepEqual(visible({ project: NO_PROJECT }), [false, false, false, true, true]);
  assert.equal(customCodeRowVisible(items[0], 'QuoteHooks Pricing.cs Read', { project: 'QuoteHooks', terms: searchTerms(' pricing  READ ') }), true);
  assert.equal(customCodeRowVisible(items[0], 'QuoteHooks Pricing.cs Read', { project: 'QuoteHooks', terms: searchTerms('pricing write') }), false);
});

test('callback filter lists mapped callbacks with (No callback) last and filters rows', () => {
  const rows = [
    { projectName: 'A', callbacks: [{ name: 'IConfigCallback' }] },
    { projectName: 'B', callbacks: [{ name: 'IValidationCallback' }, { name: 'IDisplayActionCallback' }] },
    { projectName: 'C', callbacks: [] },
    { projectName: 'D' }
  ];
  assert.deepEqual(filterOptions(rows, callbackLabels), [
    { value: 'IConfigCallback', count: 1 }, { value: 'IDisplayActionCallback', count: 1 }, { value: 'IValidationCallback', count: 1 }, { value: NO_CALLBACK, count: 2 }
  ]);
  assert.deepEqual(rows.map((item) => customCodeRowVisible(item, '', { callback: 'IDisplayActionCallback' })), [false, true, false, false]);
  assert.deepEqual(rows.map((item) => customCodeRowVisible(item, '', { callback: NO_CALLBACK })), [false, false, true, true]);
});

test('results table wires Project and Access filters into the Custom code section', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /from '\.\/resultFilters\.js'/);
  for (const name of ['table-filter-project', 'table-filter-access', 'table-filter-callback', 'table-filter-clear', 'table-search-input']) assert.match(app, new RegExp(name));
  const filters = await readFile(new URL('../public/resultFilters.js', import.meta.url), 'utf8');
  assert.doesNotMatch(filters, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|chrome\.storage/);
});
