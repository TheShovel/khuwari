/* Theme system: editor colour schemes, persisted to localStorage. The active
 * theme lives on <html data-theme="..."> and styles/editor.css keys the whole palette
 * off it ("dark" is the built-in default). editor.html applies the saved theme
 * from localStorage in <head> to avoid a first-paint flash; this file owns
 * loading it again at boot, re-applying it, and persisting changes. */
'use strict';

var THEME_KEY = 'khuwari-theme';
var THEMES = ['dark', 'light', 'lavender', 'greentea', 'paper'];

function themeName() {
  var v = document.documentElement.dataset.theme;
  return THEMES.indexOf(v) === -1 ? 'dark' : v;
}

function applyTheme(name) {
  var t = THEMES.indexOf(name) === -1 ? 'dark' : name;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  if (el.themeInput) el.themeInput.value = t;
}

function loadTheme() {
  var t = 'dark';
  try { t = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
  document.documentElement.dataset.theme = THEMES.indexOf(t) === -1 ? 'dark' : t;
}