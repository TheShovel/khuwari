'use strict';
// Resolve a Chromium/Chrome binary for the CDP test scripts.
//
// The tests in tools/ + site_tools/ drive a real headless browser over the
// DevTools protocol. The binary name varies between machines ("chromium" on
// Debian/Ubuntu/Arch, "google-chrome" on Fedora/Chrome installs, "msedge" on
// Windows), so this helper checks the common candidates and lets you override
// the pick with $KHUWARI_CHROME (or the standard $CHROME_BIN). Use
// `assertChrome()` so a missing browser fails with a helpful message instead
// of a confusing ENOENT from spawn().
const fs = require('fs');
const { spawnSync } = require('child_process');

const CANDIDATES = {
  win32: ['msedge', 'chrome', 'chromium'],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'chromium', 'google-chrome', 'chrome'
  ],
  linux: ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']
}[process.platform] || ['chromium', 'google-chrome', 'chrome'];

function onPath(name) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'pipe' });
    return r.status === 0 && String(r.stdout || '').trim().length > 0;
  } catch (e) {
    return false;
  }
}

function resolveChrome() {
  const env = process.env.KHUWARI_CHROME || process.env.CHROME_BIN;
  // explicit path (contains a slash) is taken as-is; bare names still go
  // through PATH lookup so a wrong override fails loudly later
  if (env && (/[\\/]/.test(env) || fs.existsSync(env))) return env;
  for (const c of CANDIDATES) {
    if (c.indexOf('/') === -1 ? onPath(c) : fs.existsSync(c)) return c;
  }
  return null;
}

function assertChrome() {
  const c = resolveChrome();
  if (c) return c;
  console.error(
    '[chrome] No Chromium/Chrome binary found on PATH.\n' +
    '[chrome] These tests drive a real headless browser over CDP.\n' +
    '[chrome] Install Chromium or Chrome, or point $KHUWARI_CHROME (or\n' +
    '[chrome] $CHROME_BIN) at a browser binary and re-run.'
  );
  process.exit(1);
}

module.exports = { CANDIDATES, resolveChrome, assertChrome };