<div align="center">

<img src="banner.PNG" alt="Khuwari" width="100%">

<div align="center">
  <img src="https://img.shields.io/github/stars/TheShovel/khuwari?style=flat-square&logo=github" alt="Stars">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/languages/top/TheShovel/khuwari?style=flat-square&logo=javascript&label=language" alt="Language">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/license/TheShovel/khuwari?style=flat-square" alt="License">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/last-commit/TheShovel/khuwari?style=flat-square&logo=git" alt="Last Commit">
</div>

</div>

Khuwari is a browser-based animation tool that fills in the frames between your keyframes with machine learning. Everything runs locally, so your images and projects never leave your machine.

## What it does

You make the keyframes, Khuwari makes the inbetweens. Draw or import your poses, place them on the timeline, and a machine-learning model (RIFE, running in your browser via ONNX Runtime Web) generates the frames between them. Each gap has its own settings for how the motion behaves. Nothing is baked in until you export, so you can edit a keyframe or change a gap setting any time and the affected frames regenerate.

What makes it different from other animation apps is how little of the drawing you have to do. Most of them make you create every frame by hand, or wrestle with tweening curves. With Khuwari you draw the key poses and it handles the frames in between, so the boring grind just isn't there, letting you focus on actually making what your vision is. There's nothing to install either, it runs right in a browser, and the whole workflow lives in one window: sketch in the built-in paint tool, animate on the timeline, add a camera move or reference audio, export, done.

## Try it

The easiest way is to open Khuwari straight from the [website](https://theshovel.rocks/khuwari/) in your browser.

You can also host it yourself. Khuwari is a static site, so any file server works!

```sh
python3 -m http.server 4000
```

Then open http://localhost:4000/editor.html for the editor itself.

## How it works

The docs walk through the whole workflow, from adding your images to exporting the finished animation. Start with [Getting started](https://theshovel.rocks/khuwari/docs/getting-started.html).

## Development

The editor code lives in `src/` as plain scripts, one file per thing (state, elements, workers, timeline, generation, export, paint, and so on). There is no build step: `editor.html` loads them in order, and the whole editor shares one global scope. Edit a file in `src/` and refresh the page.

The files are roughly ordered by dependency, so read them top to bottom: `src/header.js` pulls in the vendor globals (the morph fallback, GIF encoder, ML model), `src/state.js` holds the project state, and `src/footer.js` starts everything with `boot()` (defined in `src/boot.js`). The paint tool grew large, so it now spans `src/paint.js` plus the `src/paint-*.js` files loaded just before it: `paint-color.js` (colour wheel), `paint-brushes.js` (dab/stamping engine), `paint-parsers.js` (Krita/MyPaint/GIMP brush parsing), `paint-layers.js` (layers + onion skin) and `paint-tools.js` (selection and the rest of the tools).

## Testing

The repo has two kinds of tests, both plain Node scripts with no framework:

- **Site tests:** `site_tools/test-site.js`, or `npm run test:site`. Parses the site pages with jsdom and checks structure, nav, links and the docs search index. Needs `jsdom`, so run `npm install` at the repo root once.
- **Editor tests:** the `tools/*.js` scripts. These drive the real editor (or the paint engine) in a headless Chromium over CDP and assert on real rendering and parsing. They need a Chromium/Chrome binary; common names (`chromium`, `google-chrome`, `msedge`, ...) are auto-detected, and you can force one with the `KHUWARI_CHROME` (or `CHROME_BIN`) environment variable.

Each editor test runs standalone, e.g. `node tools/test-paint.js` or `node tools/smoke-paint.js`. The scripts use fixed ports, so run them one at a time.

## Our stance on AI

<img align="right" width="220" src="happyartist.png" alt="An old-school artist at their drawing board">

We don't support AI-generated "art". To us, AI is a practical tool for tedious tasks, not a replacement for the things we enjoy doing. We will never add features that generate images, music or videos. All art for this project is made by TheShovel and the Khuwari contributors, without any generative AI tools.

## Credits

Khuwari uses RIFE and ONNX Runtime Web for machine-learning inbetweens, gifenc for GIF encoding, and Mediabunny for video muxing. Everything else was written for Khuwari. See the [credits page](https://theshovel.rocks/khuwari/credits.html) for the full list.
