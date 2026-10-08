import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ICON_LENGTH,
  iconExtension,
  iconToCss,
  isRelativeIcon,
  readSwatchIcon,
  resolveIcon,
} from './swatchIcon.ts';

test('the three forms an icon takes are accepted', () => {
  for (const icon of [
    'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    'https://example.com/worlds/default/dunes.ab12.jpg',
    'dunes.ab12cd34.jpg',
  ]) {
    assert.equal(readSwatchIcon(icon), icon, icon);
  }
});

// The value lands inside a CSS url(""), so anything that could close the
// string, or name a scheme that is not an image, must not get through.
test('anything that could escape a CSS url() or run script is refused', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html;base64,AAAA',
    'data:image/jpeg;base64,AA"AA',
    'https://example.com/a".jpg',
    'https://example.com/a\\b.jpg',
    'https://example.com/a\u0008b.jpg',
    'https://example.com/a b.jpg',
    '../escape.jpg',
    'sub/dir.jpg',
    'dunes.json',
    '',
    42,
    null,
  ]) {
    assert.equal(readSwatchIcon(bad), null, String(bad));
  }
});

test('an absurdly long icon is refused', () => {
  const long = `data:image/jpeg;base64,${'A'.repeat(MAX_ICON_LENGTH)}`;
  assert.equal(readSwatchIcon(long), null);
});

test('pack file names resolve against the pack; URLs pass through', () => {
  const base = 'https://example.com/app/worlds/default/';
  assert.equal(isRelativeIcon('dunes.ab12.jpg'), true);
  assert.equal(resolveIcon('dunes.ab12.jpg', base), `${base}dunes.ab12.jpg`);
  const data = 'data:image/jpeg;base64,AAAA';
  assert.equal(resolveIcon(data, base), data);
});

test('css and extensions', () => {
  assert.equal(iconToCss('a.jpg'), 'url("a.jpg")');
  assert.equal(iconExtension('image/jpeg'), 'jpg');
  assert.equal(iconExtension('image/png'), 'png');
  assert.equal(iconExtension(''), 'jpg');
});
