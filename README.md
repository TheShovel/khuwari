<div align="center">

<img src="banner.PNG" alt="Khuwari" width="100%">

<div align="center">
  <img src="https://img.shields.io/github/stars/TheShovel/khuwari?style=flat-square&logo=github" alt="Stars">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/languages/top/TheShovel/khuwari?style=flat-square&logo=javascript&label=language" alt="Language">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/license/TheShovel/khuwari?style=flat-square" alt="License">&nbsp;&nbsp;
  <img src="https://img.shields.io/github/last-commit/TheShovel/khuwari?style=flat-square&logo=git" alt="Last Commit">
</div>

</div>
Khuwari is an in-browser animation tool that fills in the frames between your hand drawn keyframes, using machine learning and algorithms. It is fully local and runs entirely in your browser, even on weaker hardware.

## How it works

What makes it different from other animation apps, is how little of the animation you actually have to draw by hand. All you really need to make a full shot with this is a storyboard and some rough frames that you can color in dynamically inside the editor, or refine later and just update them quickly. No tweening curves or tons of hours spent drawing inbetweens. You can actually focus on your work rather than on the subtle stuff that would take way longer than they are worth (especially for indie animation and game development). 

You draw your animation keyframes inside the app or in your favorite animation software, you drag them onto the timeline and Khuwari will fill in the gaps for you. It gives you full control over the timing, the amount of inbetweens, the type of interpolation and if you even want interpolation at all.

## Try it

The easiest way is to open Khuwari straight from the [website](https://theshovel.rocks/khuwari/) in your browser.

You can also host it yourself. Khuwari is a static site, so any file server works!

```sh
python3 -m http.server 4000
```

Then open http://localhost:4000/editor.html for the editor itself.

## Tutorials

There's full documentation on our website. You can view all the categories and search for topics [here](https://theshovel.rocks/khuwari/docs), or you can read the starter guide at [Getting started](https://theshovel.rocks/khuwari/docs/getting-started.html).

## Development

The actual editor code is inside `src/` as plain pure JavaScript. Every category has its own file, and is loaded inside the `editor.html` in the order of dependency.

The docs text lives as Markdown in `docs-src/` and is generated into `docs/` by `site_tools/gen-docs-subpages.js`. Edit the Markdown, run the script, and commit the regenerated pages (see `docs-src/README.md` for the format).

## Testing

The repo has a testing suite with some scripts that require Node.

- *Site tests* -  used for testing the landing page. You probably won't mess with this much. Run by doing `npm run test:site`
- *Editor tests* - these are the actual important ones you might want to use often. These are in individual scripts that you have to run manually with Node depending on what you need. These also need a Chromium environment. By default it searches for common names (chromium, google-chrome, msedge), but if all of them fail, you have to either install one of them, or point towards your own path by setting `KHUWARI_CHROME` or `CHROME_BIN` in your environment variables.

Make sure to run `npm install` before running them.

## Our stance on AI

<img align="right" width="220" src="happyartist.png" alt="An old-school artist at their drawing board">

We don't support AI-generated "art". To us, AI is a practical tool for tedious tasks, not a replacement for the things we enjoy doing. We will never add features that generate images, music or videos. All art for this project is made by TheShovel and the Khuwari contributors, without any generative AI tools.

## Credits

The full credits for 3rd party libraries and tools can be found on the [credits page](https://theshovel.rocks/khuwari/credits) on our website.

(also, fuck you adobe)
