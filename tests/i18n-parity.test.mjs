import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const load = file => JSON.parse(readFileSync(fileURLToPath(new URL(`../src/i18n/${file}`, import.meta.url)), 'utf8'));
const flatten = (value, prefix = '', keys = new Set()) => {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') flatten(child, path, keys);
    else keys.add(path);
  }
  return keys;
};

test('every locale exposes the same translation keys as the English baseline', () => {
  const baseline = flatten(load('en.json'));
  assert.ok(baseline.size > 0);
  for (const locale of ['zh-Hans.json', 'zh-Hant.json', 'ja.json', 'es.json']) {
    const keys = flatten(load(locale));
    const missing = [...baseline].filter(key => !keys.has(key));
    const extra = [...keys].filter(key => !baseline.has(key));
    assert.deepEqual(missing, [], `${locale} is missing keys`);
    assert.deepEqual(extra, [], `${locale} has keys absent from en.json`);
  }
});

test('no locale ships an empty translation value', () => {
  for (const locale of ['en.json', 'zh-Hans.json', 'zh-Hant.json', 'ja.json', 'es.json']) {
    const walk = (value, prefix = '') => {
      for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (child && typeof child === 'object') walk(child, path);
        else assert.ok(typeof child === 'string' && child.trim().length > 0, `${locale} has an empty value at ${path}`);
      }
    };
    walk(load(locale));
  }
});
