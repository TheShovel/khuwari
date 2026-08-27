<div align="center">

<img src="banner.PNG" alt="Khuwari" width="100%">

<div align="center">
  <img src="https://img.shields.io/github/stars/TheShovel/khuwari?style=flat-square&logo=github" alt="Stars">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/languages/top/TheShovel/khuwari?style=flat-square&logo=javascript&label=language" alt="Language">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/license/TheShovel/khuwari?style=flat-square" alt="License">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/last-commit/TheShovel/khuwari?style=flat-square&logo=git" alt="Last Commit">
</div>

</div>

Khuwari is a browser based animation tool that fills in the frames between your keyframes with machine learning. You bring the art, it brings the inbetweens. Everything runs locally, so your images and projects never leave your machine.

## What you can do

- **ML inbetweens.** A machine-learning model (RIFE via ONNX Runtime Web) generates the frames between your keyframes, with a built-in fallback engine and a squash-and-stretch mode per gap. Edit a keyframe and the affected gaps regenerate automatically — nothing is baked until you export.
- **Layer based timeline.** Backgrounds, characters and effects each live on their own layer, with their own keyframes and gaps.
- **Color fill dots.** Drop dots on a color layer and they fill the line art on the layer above, each with its own threshold, grow radius, gradient and timing.
- **Onion skinning.** See the frames around the one you are working on, as ghosts or tinted, with configurable frame counts.
- **Motion blur.** Per gap motion blur that eases in and out with the movement, to mask small glitches in the generated frames.
- **Camera.** A non-destructive pan / zoom / rotation track, keyframed on its own row in the timeline and included in exports, plus per-key lens and film effects: fisheye, film grain, chromatic aberration, vignette and handheld shake.
- **Reference audio.** Load a sound file to animate to; it plays in sync with the timeline, and the file rides along inside your project file.
- **Built-in paint tool.** A Krita-style drawing workspace with layers (opacity, visibility and blend modes), onion skinning, brush stabilizers and an HSV color wheel. Real selections — rectangle, ellipse, freehand lasso and a magic wand, with feather, invert, grow/shrink and move — and painting, erasing and fill stay inside them. Ships with Krita's own brush presets, loads more `.kpp` and MyPaint `.myb` brushes, and paint-made library images stay editable with their layers intact.
- **Local and private.** The whole tool runs in your browser. No accounts, no uploads, no tracking.

## Try it

The easiest way is to open Khuwari straight from the [website](https://theshovel.rocks/khuwari/) in your browser. No install, nothing to set up, everything runs in the tab.

You can also host it yourself. Khuwari is a static site, so any file server works:

```sh
python3 -m http.server 4000
```

Then open http://localhost:4000 to browse the site, and http://localhost:4000/editor.html for the editor itself. Load the example project from the editor's start screen and press play.

## Documentation

The website lives at [theshovel.rocks/khuwari](https://theshovel.rocks/khuwari/): the home page, the [docs hub](https://theshovel.rocks/khuwari/docs.html) with a live search across every category, each category's own [page](https://theshovel.rocks/khuwari/docs/getting-started.html) under the docs section, and the [credits page](https://theshovel.rocks/khuwari/credits.html).

## How it works

1. Add images to the asset library.
2. Drag them onto the timeline as keyframes.
3. Set how each gap behaves and let the machine generate the inbetweens.
4. Play, tweak, and export a PNG frame sequence, GIF or video (MP4, WebM, MKV, MOV or MPEG-TS) at the resolution you pick — inbetweens are upscaled to the export size.

Projects save as single `.khuwari` files, which are plain JSON.

## Krita brushes

The paint tool auto-loads every brush in the `brushes/` folder — Krita `.kpp` presets (stroke preview, engine params, and the real brush-tip textures from `brushes/tips/` are all parsed — including `.gbr` and `.gih` GIMP brush formats) **and** MyPaint `.myb` brushes (with their `_prev.png` previews). The bundled set is Krita's own default presets, and the tool opens with Krita's default brush (“b) Basic-5 Size” — a 40px hard auto-brush with auto-spacing). Just drop files into the folder:

- **Served with `python3 -m http.server`** (recommended): the app reads the folder's directory index directly, so any brush you add is picked up automatically — no extra step.
- **Static hosts** that hide directory listings (e.g. GitHub Pages): the app falls back to `brushes/manifest.json`. Refresh it after adding brushes with `node tools/update-brush-manifest.js`.

Loading is logged to the browser console with a `[brushes]` prefix, so a failed load is never silent. Note: if you open `editor.html` straight from disk (`file://`), browsers block the folder/manifest fetch — serve the folder over HTTP instead.

## Development

The editor code lives in `src/` as plain scripts, one file per concern (state, elements, workers, timeline, generation, export, paint, and so on). No build step: `editor.html` loads them in order, and the whole editor shares one global scope. Edit a file in `src/` and refresh the page.

Roughly ordered by dependency, so read them top to bottom: `src/header.js` pulls in the vendor globals (the morph fallback, GIF encoder, ML model), `src/state.js` holds the project state, and `src/footer.js` starts everything with `boot()` (defined in `src/boot.js`). Because the paint tool grew large, it now spans `src/paint.js` plus the `src/paint-*.js` files loaded just before it: `paint-color.js` (colour wheel), `paint-brushes.js` (dab/stamping engine), `paint-parsers.js` (Krita/MyPaint/GIMP brush parsing), `paint-layers.js` (layers + onion skin) and `paint-tools.js` (selection and the rest of the tools).

## Testing

The repo has two kinds of tests, both plain Node scripts with no framework:

- **Site tests** — `site_tools/test-site.js`, or `npm run test:site`. Parses the site pages with jsdom and checks structure, nav, links and the docs search index. Needs `jsdom`, so run `npm install` at the repo root once.
- **Editor tests** — the `tools/*.js` scripts. These drive the real editor (or the paint engine) in a headless Chromium over CDP and assert on real rendering and parsing. They need a Chromium/Chrome binary; common names (`chromium`, `google-chrome`, `msedge`, ...) are auto-detected, and you can force one with the `KHUWARI_CHROME` (or `CHROME_BIN`) environment variable. Without one they exit with a clear message instead of a confusing spawn error.

Each editor test runs standalone, e.g. `node tools/test-paint.js` or `node tools/smoke-paint.js` (the scripts use fixed ports each, so run them one at a time).

## Our stance on AI

<img align="right" width="220" src="happyartist.png" alt="An old-school artist at their drawing board">

We don't support AI-generated "art". We see AI as a practical tool, meant to simplify tedious tasks and make life easier. Not to replace the things we enjoy doing. We will never add features that let you generate images, music or videos. All art for this project is made by TheShovel and the Khuwari contributors, without any generative AI tools.

## Credits

Khuwari is built with RIFE and ONNX Runtime Web for machine learning inbetweens, gifenc for GIF encoding and Mediabunny for video muxing. Everything else was written for Khuwari. See the [credits page](https://theshovel.rocks/khuwari/credits.html) for the full list.

## License

Khuwari is open source under the GNU Affero General Public License v3. See [LICENSE](LICENSE).
