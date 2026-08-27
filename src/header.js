// Khuwari, a browser animation tool; no build step. The src/*.js files load
// as plain scripts into one global scope, one file per concern. boot()
// starts everything in header/state/footer order: header defines the globals,
// state.js holds the model, footer.js calls boot(). Gaps between keyframes
// are interpolated with a local RIFE model when it loads, else a JS mesh warp.
'use strict';

var morph = window.KHUWARI_MORPH;
var gifenc = window.gifenc;
var model = window.KHUWARI_MODEL;
