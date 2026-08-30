/* Generator for the Khuwari docs subpages. Emits docs/<slug>.html from the
 * category definitions below. Run: node gen-docs-subpages.js
 * (output lives in docs/, which is committed). */
'use strict';
const fs = require('fs');
const path = require('path');

const SITE = path.resolve(__dirname, '..');
const OUT = path.join(SITE, 'docs');

const NAV = `<nav class="nav">
  <a class="nav-brand" href="../index.html">
    <img src="../logo.svg" alt="" class="brand-logo">
    Khuwari
  </a>
  <div class="nav-links" id="navLinks">
    <a href="../index.html">Home</a>
    <a href="../docs.html" class="active">Docs</a>
    <a href="../credits.html">Credits</a>
    <a href="https://github.com/TheShovel/khuwari">GitHub</a>
  </div>
  <div class="nav-cta">
    <a class="btn primary" href="../editor.html">Open Khuwari</a>
  </div>
</nav>`;

const FOOTER = `<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <img src="../logo.svg" alt="" class="brand-logo">
      Khuwari
    </div>
    <div class="footer-links">
      <a href="../index.html">Home</a>
      <a href="../docs.html">Docs</a>
      <a href="../credits.html">Credits</a>
      <a href="https://github.com/TheShovel/khuwari">GitHub</a>
    </div>
  </div>
</footer>`;

// Shared SVG figure library. Every figure mirrors the real app UI (same
// palette and layout) so it reads like a screenshot; animated ones use the
// .fig-* CSS animations in site.css and pause under prefers-reduced-motion.
// Figures are authored at a 720-unit viewBox with fonts sized to match their
// boxes (no post-scaling), so text never overflows or clips.
// Figure library. UI figures are real screenshots of the editor (shots/);
// the remaining illustrations (project file, keyboard, privacy) are SVGs.
const FIG = {
  appWindow:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/win.png" alt="The Khuwari window with a project loaded: assets on the left, the canvas in the middle, the selection panel on the right, and the timeline along the bottom" width="720">
  <figcaption>The whole Khuwari window. Your image library sits on the left, the canvas is in the middle, the selection panel is on the right, and the timeline runs along the bottom.</figcaption>
</figure>`,
  browserBar:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/start.png" alt="The Khuwari start screen with the mascot banner and the launch buttons" width="720">
  <figcaption>The start screen greets you with a new project, load, docs, example project, credits and GitHub buttons.</figcaption>
</figure>`,
  projectFile: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 200" role="img" aria-label="A .khuwari project file with its contents listed" class="fig-border">
    <rect x="40" y="30" width="200" height="150" rx="10" fill="#22272e" stroke="#39414d"/>
    <path d="M70 30 h60 l20 20 h50 v120 h-130 z" fill="#1b1f25" stroke="#8aa3b9" stroke-width="1.5"/>
    <text x="80" y="120" font-size="14.5" fill="#e6e9ee" font-weight="600">my-anim</text>
    <text x="80" y="138" font-size="12.5" fill="#c3ab7d">.khuwari</text>
    <text x="300" y="64" font-size="15" fill="#98a1ad">One file holds everything:</text>
    <circle cx="316" cy="92" r="3.5" fill="#8aa3b9"/><text x="328" y="96" font-size="15" fill="#e6e9ee">layers</text>
    <circle cx="316" cy="118" r="3.5" fill="#8aa3b9"/><text x="328" y="122" font-size="15" fill="#e6e9ee">keyframes and gaps</text>
    <circle cx="316" cy="144" r="3.5" fill="#8aa3b9"/><text x="328" y="148" font-size="15" fill="#e6e9ee">settings</text>
  </svg>
  <figcaption>A project is one file, easy to save, share and version.</figcaption>
</figure>`,
  assetsPanel:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/assets.png" alt="The assets panel with images in a grid" width="720">
  <figcaption>The assets panel. Drag any tile onto the timeline to turn it into a keyframe.</figcaption>
</figure>`,
  previewFilmstrip:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/preview.png" alt="The preview canvas with the filmstrip below it" width="720">
  <figcaption>The preview canvas with the filmstrip below. Click any thumb to jump to that frame.</figcaption>
</figure>`,
  timelineLayers:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/timeline_layers.png" alt="The timeline with a normal layer and a thin color layer holding stacked dot chips" width="720">
  <figcaption>The timeline. Keyframes are chips on their layer track; color layers stay thin and hold dots.</figcaption>
</figure>`,
  selectionPanel:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/selection.png" alt="The selection panel showing a selected keyframe" width="720">
  <figcaption>Select a keyframe and its details appear in the right panel.</figcaption>
</figure>`,
  kfChip:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/kfchip.png" alt="A keyframe chip selected on the timeline" width="720">
  <figcaption>Drag the chip to retime it; drag its edges to change how long it holds.</figcaption>
</figure>`,
  gapInbetween:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/gap.png" alt="A gap between two keyframes with the generated inbetween frames marked" width="720">
  <figcaption>Between two keyframes is a gap. Khuwari generates the inbetween frames for it.</figcaption>
</figure>`,
  squash:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/squash.png" alt="A gap in squash mode with its options in the right panel" width="720">
  <figcaption>Squash mode deforms the inbetweens for cartoon motion.</figcaption>
</figure>`,
  motionBlur:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/blur.png" alt="A gap with motion blur on and its intensity slider in the right panel" width="720">
  <figcaption>Motion blur smears the inbetweens along their movement, easing in and out.</figcaption>
</figure>`,
  colorFill:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/colorfill.png" alt="Color dots flooding the line art shapes on the canvas" width="720">
  <figcaption>Each dot flood-fills the connected area inside the nearest lines.</figcaption>
</figure>`,
  onion:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/onion.png" alt="Onion skinning with ghost frames around the current one and the settings popup" width="720">
  <figcaption>Onion skinning keeps the neighboring frames faintly visible while you work.</figcaption>
</figure>`,
  blend:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/blend.png" alt="The selection panel with the blend mode dropdown for a keyframe" width="720">
  <figcaption>Each keyframe can blend with the layers below it in 16 different ways.</figcaption>
</figure>`,
  exportMenu:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/export.png" alt="The export menu with the format and resolution dropdowns" width="720">
  <figcaption>The export menu. Pick a format and resolution, then hit Export.</figcaption>
</figure>`,
  settingsMenu:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/settings.png" alt="The settings menu with FPS, snapping, aspect ratio and working size" width="720">
  <figcaption>The settings menu controls the pace and shape of your project.</figcaption>
</figure>`,
  keys: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 190" role="img" aria-label="Keyboard keys: space, left arrow, right arrow, delete" class="fig-border">
    <g class="fig-anim fig-tap">
      <rect x="60" y="50" width="220" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
      <text class="fig-key" x="170" y="88" font-size="17" fill="#e6e9ee" text-anchor="middle">Space</text>
    </g>
    <rect x="320" y="50" width="60" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(332 62) scale(1.5)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 12H5"/>
      <path d="m12 19-7-7 7-7"/>
    </g>
    <rect x="400" y="50" width="60" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(412 62) scale(1.5)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12h14"/>
      <path d="m12 5 7 7-7 7"/>
    </g>
    <rect x="500" y="50" width="150" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <text class="fig-key" x="575" y="88" font-size="17" fill="#e6e9ee" text-anchor="middle">Del</text>
    <text x="360" y="150" font-size="15" fill="#98a1ad" text-anchor="middle">space plays, arrows step, delete removes</text>
  </svg>
  <figcaption>The shortcuts are easy to reach while you work.</figcaption>
</figure>`,
  paintWorkspace: `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/paint.png" alt="The paint workspace: toolbar on top, tools on the left, the canvas in the center, and color, brushes and layers dockers on the right" width="720">
  <figcaption>The paint workspace: a Krita-style window where you draw on the canvas in the center with tools, color, brushes and layers docked around it.</figcaption>
</figure>`,
  cameraFig: `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/camera.png" alt="The camera panel open in the right panel with pan, zoom, rotation and the effects sliders, a lens-warped preview, and the Camera track with its key dots along the bottom" width="720">
  <figcaption>The camera panel. Drag any slider to add a camera key at the playhead, and the keys appear as dots on the Camera track. The Effects sliders add lens and film looks on top of the pan, zoom and rotation.</figcaption>
</figure>`,
  audioFig: `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/audio.png" alt="The audio panel with a loaded scratch track and the green waveform lane under the timeline" width="720">
  <figcaption>The reference audio: load it in the Audio panel and a green waveform appears under the timeline, aligned with your keyframes.</figcaption>
</figure>`,
  historyFig: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 200" role="img" aria-label="The undo and redo buttons and the Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y shortcuts" class="fig-border">
    <rect x="40" y="24" width="150" height="44" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(60.6 32.2) scale(1.2)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 14L4 9l5-5"/>
      <path d="M4 9h11a5 5 0 0 1 0 10h-1"/>
    </g>
    <text x="118" y="51" font-size="15" fill="#e6e9ee">Undo</text>
    <rect x="210" y="24" width="150" height="44" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(222.6 32.2) scale(1.2)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 14l5-5-5-5"/>
      <path d="M20 9H9a5 5 0 0 0 0 10h1"/>
    </g>
    <text x="288" y="51" font-size="15" fill="#e6e9ee">Redo</text>
    <g class="fig-key">
      <rect x="46" y="98" width="62" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="77" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Ctrl</text>
      <text x="116" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="128" y="98" width="42" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="149" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Z</text>
      <rect x="190" y="98" width="62" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="221" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Ctrl</text>
      <text x="260" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="272" y="98" width="72" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="308" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Shift</text>
      <text x="352" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="364" y="98" width="42" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="385" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Z</text>
      <rect x="426" y="98" width="62" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="457" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Ctrl</text>
      <text x="496" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="508" y="98" width="42" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="529" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Y</text>
    </g>
    <text x="46" y="184" font-size="14" fill="#98a1ad">Undo and redo work in the timeline and in the paint tool.</text>
  </svg>
  <figcaption>Undo and redo are one keystroke away, in the timeline and in the paint tool.</figcaption>
</figure>`,
  privacy: ``
};

// Structured category content. Each section: { id, title, html }.
const CATEGORIES = [
  {
    slug: 'getting-started', title: 'Getting started',
    blurb: 'What Khuwari is, how to open it, and how project files work.',
    sections: [
      { id: 'what-is', title: 'What is Khuwari?', html: `
        <p>Khuwari is a browser based animation tool that fills in the frames between your keyframes using machine learning. You draw or import the important poses, place them on the timeline, and Khuwari generates everything in between.</p>
        <h3>The idea</h3>
        <ul>
          <li>You provide the key poses, called <strong>keyframes</strong>.</li>
          <li>Khuwari generates the frames between them, called <strong>inbetweens</strong>.</li>
          <li>Everything runs in your browser. The model downloads once, and your art never leaves your machine.</li>
        </ul>
        ${FIG.appWindow}
      ` },
      { id: 'open-app', title: 'Open the app', html: `
        <p>The easiest way is to open the app straight from the <a href="https://theshovel.rocks/khuwari/" target="_blank" rel="noopener">Khuwari website</a> in your browser. No install, nothing to set up, everything runs in the tab. This is the recommended way to use Khuwari.</p>
        <p>You can also host it yourself. Khuwari is a static site, so any file server works.</p>
        <ol>
          <li>Serve the project folder, for example with <code>python3 -m http.server 4000</code>.</li>
          <li>Open <code>http://localhost:4000</code> in your browser.</li>
        </ol>
        <p>From the start screen you can start a new project, load an existing <code>.khuwari</code> file, or try the bundled example project. The example project is the fastest way to see a finished animation. Load it and press play.</p>
        ${FIG.browserBar}
      ` },
      { id: 'project-files', title: 'Project files', html: `
        <p>Projects save as <code>.khuwari</code> files that are easy to version and share.</p>
        <ul>
          <li>Use <code>File</code> in the toolbar, then <code>Save project (.khuwari)</code> to download one.</li>
          <li>Use <code>File</code>, then <code>Load project</code> to bring one back.</li>
          <li>A project file holds your layers, keyframes, gaps and settings.</li>
        </ul>
        ${FIG.projectFile}
      ` }
    ]
  },
  {
    slug: 'interface', title: 'The interface',
    blurb: 'The assets panel, the preview, the timeline, the selection panel and layers.',
    sections: [
      { id: 'assets-panel', title: 'The assets panel', html: `
        <p>The panel on the left is your image library.</p>
        <ul>
          <li>Use <code>Add images</code> to bring in art.</li>
          <li>Drag an image onto the timeline to make a keyframe.</li>
          <li>Hover a tile to reveal a delete badge. Deleting an image removes it from the library only.</li>
        </ul>
        ${FIG.assetsPanel}
      ` },
      { id: 'preview', title: 'The preview', html: `
        <p>The large canvas in the center shows the current frame, and the filmstrip under it shows every frame of the animation.</p>
        <ul>
          <li>Press play to watch it move, or step frame by frame with the arrow keys.</li>
          <li>Click a filmstrip thumb to jump to that frame.</li>
          <li>The outlined thumb is the frame you are looking at.</li>
        </ul>
        ${FIG.previewFilmstrip}
      ` },
      { id: 'timeline', title: 'The timeline', html: `
        <p>Each layer has its own track along the bottom. Keyframes appear as chips, and the space between two keyframes is a gap.</p>
        <ul>
          <li>Click a chip to select it.</li>
          <li>Drag a chip to move it in time.</li>
          <li>Drag a chip's edges to change how long it holds.</li>
          <li>Click a gap to open its inbetween options.</li>
        </ul>
        ${FIG.timelineLayers}
      ` },
      { id: 'selection-panel', title: 'The selection panel', html: `
        <p>The panel on the right shows the details of whatever you have selected, whether that is a keyframe, a gap or a color dot.</p>
        <ul>
          <li>Set exact times and blend modes for keyframes.</li>
          <li>Choose how a gap fills in its inbetweens, and tune squash and motion blur.</li>
          <li>Edit a color dot's color, threshold, grow and gradient.</li>
        </ul>
        ${FIG.selectionPanel}
      ` },
      { id: 'layers', title: 'Layers', html: `
        <p>The <code>Layer</code> button in the toolbar opens the layer menu.</p>
        <ul>
          <li>Add a normal layer or a color layer.</li>
          <li>Rename, hide or remove the active layer.</li>
          <li>Layers draw from top to bottom, and each one keeps its own keyframes and gaps.</li>
          <li>Drag layers up and down in the menu to reorder them.</li>
        </ul>
      ` }
    ]
  },
  {
    slug: 'keyframes', title: 'Keyframes',
    blurb: 'Adding, selecting, moving, resizing, timing, replacing and deleting frames.',
    sections: [
      { id: 'add-keyframe', title: 'Add a keyframe', html: `
        <p>Drag an image from the assets panel onto a layer track at the time you want it. The image becomes a keyframe chip that holds that pose.</p>
      ` },
      { id: 'select-inspect', title: 'Select and inspect', html: `
        <p>Click a chip to select it. The selection panel on the right shows:</p>
        <ul>
          <li>a thumbnail of the frame</li>
          <li>the exact time</li>
          <li>the blend mode</li>
          <li>buttons to replace or delete the frame</li>
        </ul>
        ${FIG.selectionPanel}
      ` },
      { id: 'move-resize', title: 'Move and resize', html: `
        <p>Drag a chip left or right to change when it happens. Drag its edges to change how long the frame holds before the gap starts. Hold times matter for pacing.</p>
        ${FIG.kfChip}
      ` },
      { id: 'set-time', title: 'Set the time exactly', html: `
        <p>With a keyframe selected, enter the time in seconds in the selection panel. Use the playhead and frame counter to find the moment you want.</p>
      ` },
      { id: 'replace-delete', title: 'Replace or delete', html: `
        <ul>
          <li><code>Replace image</code> swaps in different art while keeping the timing.</li>
          <li><code>Delete</code> removes the keyframe. The keyboard shortcut <kbd>Delete</kbd> or <kbd>Backspace</kbd> also works.</li>
        </ul>
      ` }
    ]
  },
  {
    slug: 'gaps', title: 'Gaps & inbetweens',
    blurb: 'Machine learning, squash and stretch, no inbetweens, motion blur and regeneration.',
    sections: [
      { id: 'what-is-gap', title: 'What is a gap?', html: `
        <p>The space between two keyframes on the same layer is a gap. Click the gap chip on the timeline to open its options in the right panel, and the inbetweens are generated there.</p>
        ${FIG.gapInbetween}
      ` },
      { id: 'ml', title: 'Machine learning', html: `
        <p>The default mode. A machine learning model generates the inbetween frames, which gives the most natural motion for complex art. This is where Khuwari shines.</p>
      ` },
      { id: 'squash', title: 'Squash and stretch', html: `
        <p>A stylized deformation for cartoon motion.</p>
        <ul>
          <li><strong>Amount</strong> controls how strong the deformation is, or set it to auto for a distance based value.</li>
          <li><strong>Curve</strong> picks the motion: anticipation (peak mid-gap), impact (builds to the end), ease (smooth) or linear.</li>
          <li><strong>Preserve</strong> keeps area or volume constant while deforming.</li>
        </ul>
        ${FIG.squash}
      ` },
      { id: 'none', title: 'No inbetweens', html: `
        <p>No inbetweens at all. The first keyframe simply holds until the next one starts. Good for flashes, cuts and text.</p>
      ` },
      { id: 'motion-blur', title: 'Motion blur', html: `
        <p>A per gap toggle. When on, the inbetweens smear along their motion, and the blur eases in and out with the movement.</p>
        <ul>
          <li>The <strong>intensity</strong> slider controls how strong the smear is.</li>
          <li>It is designed to mask small imperfections in generated frames.</li>
          <li>It works on color layers too.</li>
        </ul>
        ${FIG.motionBlur}
      ` },
      { id: 'regenerate', title: 'Regenerate', html: `
        <p>Inbetweens regenerate automatically whenever your keyframes change. To force a full refresh, use the regenerate button above the timeline, to the right of the play buttons.</p>
      ` }
    ]
  },
  {
    slug: 'color-layers', title: 'Color layers',
    blurb: 'Color dots that fill the layer above, with thresholds, grow, gradients and timing.',
    sections: [
      { id: 'what-they-do', title: 'What they do', html: `
        <p>A color layer holds dots instead of keyframes. Each dot acts like a smart bucket fill for the layer above it, so you can color in line art without touching the drawing.</p>
        ${FIG.colorFill}
      ` },
      { id: 'add-place', title: 'Add one and place dots', html: `
        <ol>
          <li>Use the <code>Layer</code> menu and choose <code>Add color layer</code>.</li>
          <li>Click on the canvas to place a dot.</li>
          <li>The dot fills everything inside the nearest lines of the layer above.</li>
        </ol>
        <p class="doc-note">New dots remember the last color you used, so coloring many regions is quick. You can also copy and paste a dot's properties onto other dots.</p>
      ` },
      { id: 'dot-properties', title: 'Dot properties', html: `
        <ul>
          <li><strong>Fill color</strong> is what the dot pours into the area.</li>
          <li><strong>Threshold</strong> is how strong a line must be to stop the fill.</li>
          <li><strong>Grow</strong> is a radius in pixels that tucks the color under soft edges.</li>
        </ul>
      ` },
      { id: 'gradients', title: 'Gradients', html: `
        <p>Turn on <code>Gradient</code> to give a dot a gradient instead of a flat fill.</p>
        <ul>
          <li><strong>Gradient color</strong> is the color the fill fades toward.</li>
          <li><strong>Height</strong> controls how tall the gradient is.</li>
          <li><strong>Direction</strong> picks top, bottom, left or right.</li>
        </ul>
      ` },
      { id: 'timing', title: 'Timing', html: `
        <p>Dots only work during the time you set. Use the start and end fields in the right panel, or drag the dot chip on the timeline and drag its edges to resize. Outside that window the dot does nothing.</p>
      ` }
    ]
  },
  {
    slug: 'onion-skinning', title: 'Onion skinning',
    blurb: 'Seeing the frames around the current one, and configuring the ghosts.',
    sections: [
      { id: 'what-it-is', title: 'What it is', html: `
        <p>Onion skinning shows the frames around the current one, so you can see where the motion is heading while you work. It is a toggle, like the view only keyframes button.</p>
        ${FIG.onion}
      ` },
      { id: 'turn-it-on', title: 'Turn it on', html: `
        <p>The onion button in the transport area toggles it on and off. The small arrow next to it opens the settings popup.</p>
      ` },
      { id: 'settings', title: 'Settings', html: `
        <ul>
          <li><strong>Frames before</strong> and <strong>after</strong> choose how many neighbors to show.</li>
          <li><strong>Opacity</strong> sets how strong the ghosts are.</li>
          <li><strong>Tint</strong> replaces the ghost look with a flat tint; pick the color and strength.</li>
        </ul>
      ` },
      { id: 'saved', title: 'Saved automatically', html: `
        <p>Your onion skin settings are saved in the browser, so they come back the next time you open Khuwari, even after loading a project.</p>
      ` }
    ]
  },
  {
    slug: 'paint', title: 'Paint',
    blurb: 'The built-in drawing tool: brushes, layers, color, selection, transform and saving drawings into your animation.',
    sections: [
      { id: 'what-it-is', title: 'What it is', html: `
        <p>The paint tool is a full drawing workspace built into Khuwari, styled after Krita. You can sketch, ink and color right inside the editor, keep your work on separate layers, and drop the result straight into the timeline.</p>
        <ul>
          <li>Brushes, eraser, selection, transform, fill, shapes, line, eyedropper and crop tools.</li>
          <li>Krita-style layers: opacity, visibility and blend modes.</li>
          <li>Onion skinning, brush stabilizers and an HSV color wheel.</li>
          <li>Paint-made images stay editable - their layers are saved with the project.</li>
        </ul>
        ${FIG.paintWorkspace}
      ` },
      { id: 'open', title: 'Open the paint tool', html: `
        <p>There are three ways in:</p>
        <ul>
          <li>The <code>Paint</code> button in the toolbar opens a blank canvas, ready for a new drawing.</li>
          <li>Right-click a keyframe on the timeline and choose <code>Edit in paint</code> to redraw that pose in place - the existing image stays editable on a layer.</li>
          <li>When you add a finished drawing to the library it becomes an asset you can drag onto the timeline like any other image.</li>
        </ul>
        <p class="doc-note">Leave the tool with <kbd>Esc</kbd> or the close button in the top-right corner. Editing a library image saves automatically when you close.</p>
      ` },
      { id: 'tools', title: 'Tools', html: `
        <p>The tool docker on the left holds everything you need:</p>
        <table class="doc-table">
          <thead><tr><th>Tool</th><th>Shortcut</th><th>What it does</th></tr></thead>
          <tbody>
            <tr><td>Brush</td><td><kbd>B</kbd></td><td>paint with the current brush</td></tr>
            <tr><td>Eraser</td><td><kbd>E</kbd></td><td>erase pixels</td></tr>
            <tr><td>Select</td><td><kbd>S</kbd></td><td>rectangle, ellipse or lasso selection</td></tr>
            <tr><td>Lasso</td><td><kbd>L</kbd></td><td>freehand selection</td></tr>
            <tr><td>Move</td><td><kbd>V</kbd></td><td>move content, duplicate with Alt</td></tr>
            <tr><td>Transform</td><td><kbd>T</kbd></td><td>scale, rotate and move with handles</td></tr>
            <tr><td>Fill</td><td><kbd>G</kbd></td><td>flood fill with tolerance</td></tr>
            <tr><td>Color picker</td><td><kbd>I</kbd></td><td>pick a color from the canvas</td></tr>
            <tr><td>Line</td><td><span class="muted">-</span></td><td>straight lines with the current brush</td></tr>
            <tr><td>Rectangle</td><td><kbd>U</kbd></td><td>outline or filled rectangles</td></tr>
            <tr><td>Ellipse</td><td><span class="muted">-</span></td><td>outline or filled ellipses</td></tr>
            <tr><td>Crop</td><td><kbd>C</kbd></td><td>crop the canvas</td></tr>
          </tbody>
        </table>
        <p class="doc-note">Shortcut letters only work while the paint tool is open, and not while you are typing in a field.</p>
      ` },
      { id: 'brushes', title: 'Brushes', html: `
        <p>The brush docker is a Krita-style preset list. The toolbar shows the current brush plus quick <strong>size</strong> and <strong>opacity</strong> sliders - drag to change, double-click to type an exact value.</p>
        <ul>
          <li><strong>Hardness</strong> softens the brush edge.</li>
          <li><strong>Smoothing</strong> adds a stabilizer (none, basic or stabilizer) to tame wobbly strokes.</li>
          <li>The bundle ships with Krita's default preset brushes (<code>.kpp</code>), including their real brush tips, plus MyPaint (<code>.myb</code>) brushes. Drop more files into <code>brushes/</code> and they are picked up automatically.</li>
        </ul>
      ` },
      { id: 'layers', title: 'Layers', html: `
        <p>Every drawing can be split across layers, each with its own thumbnail, visibility, opacity and blend mode.</p>
        <ul>
          <li>Add, delete, move up and down, and merge a layer down from the layer toolbar.</li>
          <li>Double-click a layer name to rename it.</li>
          <li>Select a layer to paint on it. Alt-drag with the move tool duplicates content onto the same layer.</li>
          <li>Paint layers are saved with the image, so a drawing stays editable no matter how often you save, close and reopen the project.</li>
        </ul>
      ` },
      { id: 'color', title: 'Color', html: `
        <p>The color docker gives you an HSV color wheel - a saturation/value square and a hue slider - plus a hex field for exact colors. The color picker tool (<kbd>I</kbd>) grabs a color straight off the canvas.</p>
      ` },
      { id: 'onion', title: 'Onion skin in paint', html: `
        <p>Turn on <code>Onion skin</code> in the tool docker to see the neighboring frames while you draw, with the same before/after counts, opacity and tint options as the main viewport.</p>
        <p>Use the <strong>frame scrubber</strong> at the bottom of the workspace to move the playhead; the ghosts follow it so you can check the motion on either side of the frame you are drawing.</p>
      ` },
      { id: 'image-ops', title: 'Canvas and image operations', html: `
        <p>The <code>Image</code> menu in the toolbar operates on the whole canvas:</p>
        <ul>
          <li>Flip horizontal or vertical</li>
          <li>Rotate 90 degrees clockwise or counter-clockwise</li>
          <li>Resize the canvas, with optional aspect-lock and scale-content</li>
        </ul>
        <p>The <strong>crop</strong> tool (<kbd>C</kbd>) trims to a rectangle you drag; press <kbd>Enter</kbd> to apply or <kbd>Esc</kbd> to cancel. Double-click empty space to re-center the view, scroll to zoom, and hold the middle mouse button (or <kbd>Shift</kbd> with a brush) to pan.</p>
      ` },
      { id: 'save', title: 'Save your drawing', html: `
        <p><code>Save to library</code> in the bottom status bar adds the drawing to the assets panel, where you can drag it onto the timeline like any image.</p>
        <ul>
          <li>When you are repainting a keyframe, saving updates that keyframe in place and the gaps around it regenerate.</li>
          <li>Editing a library image saves automatically when you close the tool.</li>
          <li>Brand-new drawings ask for a name the first time you add them.</li>
        </ul>
      ` }
    ]
  },
  {
    slug: 'blend-modes', title: 'Blend modes',
    blurb: '16 blend modes per keyframe, from multiply to luminosity.',
    sections: [
      { id: 'per-keyframe', title: 'Per keyframe blending', html: `
        <p>Each keyframe can blend with the layers below it in 16 different ways. Set the mode in the selection panel with a keyframe selected.</p>
        <table class="doc-table">
          <thead><tr><th>Group</th><th>Modes</th></tr></thead>
          <tbody>
            <tr><td>Normal</td><td>normal</td></tr>
            <tr><td>Darken</td><td>multiply, darken, color burn</td></tr>
            <tr><td>Lighten</td><td>screen, lighten, color dodge</td></tr>
            <tr><td>Contrast</td><td>overlay, hard light, soft light</td></tr>
            <tr><td>Invert</td><td>difference, exclusion</td></tr>
            <tr><td>Color</td><td>hue, saturation, color, luminosity</td></tr>
          </tbody>
        </table>
        ${FIG.blend}
      ` }
    ]
  },
  {
    slug: 'camera', title: 'Camera',
    blurb: 'A non-destructive camera: pan, zoom and rotation plus lens and film effects, every value keyframed on its own track.',
    sections: [
      { id: 'what-it-is', title: 'What it is', html: `
        <p>The camera applies a pan, zoom and rotation to the whole frame, on top of your layers, and can add lens and film looks with the Effects sliders: fisheye, film grain, chromatic aberration, vignette and handheld shake. It is non-destructive - your keyframes are never changed - and it is applied to the preview and to exports alike.</p>
        <p class="doc-note">While a <strong>Color layer</strong> is selected the camera steps aside and the panel locks, so dots land exactly where you click. Switch back to a normal layer and the camera returns, keys intact.</p>
        ${FIG.cameraFig}
      ` },
      { id: 'add-key', title: 'Add a camera key', html: `
        <p>Open the <code>Camera</code> panel at the top of the right panel and move to the moment you want.</p>
        <ol>
          <li>Move the playhead to where the change should start.</li>
          <li>Drag any of the Pan X, Pan Y, Zoom, Rotation or Effects sliders.</li>
          <li>A camera key appears at the playhead. The first key is remembered for the whole timeline, so the pose holds before your camera moves.</li>
        </ol>
        <p>You can also press <code>Add key</code> to stamp a key with the current values when you want the pose to stay readable.</p>
      ` },
      { id: 'lane', title: 'The Camera track', html: `
        <p>The timeline has a <code>Camera</code> row under your layers. Each key is a small dot:</p>
        <ul>
          <li>Drag a dot to retime it.</li>
          <li>Double-click a dot to remove that key.</li>
          <li>With the playhead on a key you can nudge the sliders to edit it, or press <code>Remove key</code>.</li>
        </ul>
      ` },
      { id: 'effects', title: 'The Effects sliders', html: `
        <p>Five effects sit under the transform sliders, each with an intensity from 0 (off) to 100 percent. Like every camera value, the intensity is remembered per key and blends between keys, so you can ease an effect in or out over time.</p>
        <ul>
          <li><strong>Fisheye</strong> warps the frame outward like a wide lens, magnifying the centre.</li>
          <li><strong>Chromatic aberration</strong> splits red and blue along the edges for a cheap lens look.</li>
          <li><strong>Film grain</strong> adds a seeded speckle over the whole frame.</li>
          <li><strong>Vignette</strong> darkens the corners to focus the centre.</li>
          <li><strong>Handheld shake</strong> adds a smooth, low-frequency wobble to the frame for a real-camera feel, and the <strong>Shake speed</strong> slider right below it tunes how quickly it wobbles - a slow drift up to an energetic handheld look.</li>
        </ul>
        <p>Grain and shake are deterministic: the same frame always renders the same way in the preview, the filmstrip and your exports.</p>
      ` },
      { id: 'interpolation', title: 'Between keys', html: `
        <p>Every camera value, transforms and effects alike, blends smoothly from key to key. A slow push-in is just two keys: one at normal zoom, a later one zoomed in. Easing a fisheye in from a punch-out is two keys too. Space your keys on the timeline to shape the easing of the movement.</p>
      ` },
      { id: 'export', title: 'Applied to exports', html: `
        <p>The camera is part of the final composite, so every exported frame includes it, lens effects and all. Combine it freely with squash, motion blur and color layers exactly like the rest of the frame.</p>
      ` }
    ]
  },
  {
    slug: 'audio', title: 'Audio',
    blurb: 'A reference audio track that plays in sync with your timeline.',
    sections: [
      { id: 'what-it-is', title: 'What it is', html: `
        <p>The audio track is a scratch track for timing: load a sound file and it plays in sync with the timeline, so you can animate to the beat or to dialogue. It is there to guide you - it is not part of the export.</p>
        ${FIG.audioFig}
      ` },
      { id: 'load-remove', title: 'Load and manage audio', html: `
        <p>In the <code>Audio</code> panel in the right column:</p>
        <ul>
          <li><code>Load audio...</code> lets you pick a sound file (mp3, wav, ogg - any format your browser plays).</li>
          <li><code>Mute</code> silences it without removing it.</li>
          <li><code>Remove</code> drops the track.</li>
        </ul>
        <p>The Load and Remove buttons swap: Load shows when there is no audio, Remove when there is.</p>
      ` },
      { id: 'waveform', title: 'The waveform lane', html: `
        <p>Once loaded, a green waveform appears in a lane under the timeline. Click anywhere in it to jump the playhead to that moment. The waveform lines up with the same time ruler as your keyframes, so beats line up with frames.</p>
      ` },
      { id: 'saved', title: 'Saved with the project', html: `
        <p>The audio file is stored inside the <code>.khuwari</code> project, so it comes back when you reopen the file - no need to find the sound again. Everything is stored locally on your machine.</p>
      ` }
    ]
  },
  {
    slug: 'undo-redo', title: 'Undo & redo',
    blurb: 'Step your edits back and forward, in the timeline and in the paint tool.',
    sections: [
      { id: 'undo-redo', title: 'Undo and redo', html: `
        <p>The transport at the bottom of the timeline has Undo and Redo buttons. Edits to your keyframes, gaps, layers, dots, camera and audio all land on the history stack, so a couple of clicks can walk any change back.</p>
        ${FIG.historyFig}
      ` },
      { id: 'shortcuts', title: 'Shortcuts', html: `
        <table class="doc-table">
          <thead><tr><th>Key</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd></td><td>undo</td></tr>
            <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd>, or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Y</kbd></td><td>redo</td></tr>
          </tbody>
        </table>
      ` },
      { id: 'paint', title: 'In the paint tool', html: `
        <p>The paint tool keeps its own history, separate from the timeline's. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd> undoes your last stroke or tool action; <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Y</kbd> redoes it. Each time you open the tool it starts fresh.</p>
      ` },
      { id: 'coalescing', title: 'Slider edits collapse', html: `
        <p>Dragging a slider - a camera pan or a squash amount, for example - records one undo step for the whole gesture, not one per frame. So one <kbd>Ctrl</kbd> + <kbd>Z</kbd> reverts the entire drag instead of just the last tick.</p>
      ` }
    ]
  },
  {
    slug: 'export', title: 'Export',
    blurb: 'PNG sequences, GIFs, video in five containers and exporting the current frame.',
    sections: [
      { id: 'formats', title: 'Formats', html: `
        <p>The <code>Export</code> button in the toolbar offers stills, a GIF, video in five containers and the current frame.</p>
        <table class="doc-table">
          <thead><tr><th>Format</th><th>Use it for</th></tr></thead>
          <tbody>
            <tr><td>PNG sequence (.zip)</td><td>frame by frame work, other tools</td></tr>
            <tr><td>Animated GIF</td><td>quick loops and web embeds</td></tr>
            <tr><td>MP4 video</td><td>the widest compatibility</td></tr>
            <tr><td>WebM video</td><td>small modern web videos</td></tr>
            <tr><td>MKV video</td><td>archival and everything inside one file</td></tr>
            <tr><td>MOV video</td><td>Apple and video editing workflows</td></tr>
            <tr><td>MPEG-TS video</td><td>broadcast and streaming</td></tr>
            <tr><td>Current frame (PNG)</td><td>a single still</td></tr>
          </tbody>
        </table>
        ${FIG.exportMenu}
      ` },
      { id: 'resolution', title: 'Resolution', html: `
        <p>Pick the export resolution from the export menu. Exports run in the background with a progress bar, and you can stop them if you change your mind.</p>
      ` }
    ]
  },
  {
    slug: 'settings', title: 'Settings',
    blurb: 'FPS, snapping, aspect ratios and the working size.',
    sections: [
      { id: 'fps', title: 'FPS', html: `
        <p>How many frames per second the timeline plays. Lower values are punchier and cheaper to generate, higher values are smoother.</p>
      ` },
      { id: 'snap', title: 'Snap to frames', html: `
        <p>Keeps the playhead and keyframes on whole frames, so times stay tidy. Turn it off for free placement.</p>
      ` },
      { id: 'aspect', title: 'Aspect ratio', html: `
        <p>Follow the first frame, pick a preset such as 16:9 or 1:1, or set a custom size or a manual ratio like 2.35.</p>
      ` },
      { id: 'work-size', title: 'Working size', html: `
        <p>The long edge of the working canvas, from 512 pixels down to 320. Smaller is noticeably faster to generate, and exports still come out at full resolution.</p>
        ${FIG.settingsMenu}
      ` }
    ]
  },
  {
    slug: 'shortcuts', title: 'Keyboard shortcuts',
    blurb: 'Playback and editing shortcuts, and when they are ignored.',
    sections: [
      { id: 'playback', title: 'Playback', html: `
        <table class="doc-table">
          <thead><tr><th>Key</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>Space</kbd></td><td>play or pause</td></tr>
            <tr><td><kbd>Left</kbd></td><td>step one frame back</td></tr>
            <tr><td><kbd>Right</kbd></td><td>step one frame forward</td></tr>
          </tbody>
        </table>
        ${FIG.keys}
      ` },
      { id: 'editing', title: 'Editing', html: `
        <table class="doc-table">
          <thead><tr><th>Key</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>Delete</kbd> or <kbd>Backspace</kbd></td><td>delete the selected keyframe</td></tr>
            <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd></td><td>undo</td></tr>
            <tr><td><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Y</kbd></td><td>redo</td></tr>
          </tbody>
        </table>
        <p>Shortcuts are ignored while you are typing in a field.</p>
      ` }
    ]
  },
  {
    slug: 'privacy', title: 'Privacy',
    blurb: 'How Khuwari stays local and what never leaves your machine.',
    sections: [
      { id: 'nothing-leaves', title: 'Nothing leaves your browser', html: `
        <p>Khuwari is a free and open source tool that runs entirely in your browser. No server, no backend, no cloud. The machine learning model downloads once and then runs locally on your machine.</p>
        <ul>
          <li>Your images never leave your machine.</li>
          <li>Your projects never leave your machine.</li>
          <li>Your exports never leave your machine.</li>
          <li>Your art is never sent anywhere and never used to train any model.</li>
          <li>There are no accounts and no tracking.</li>
        </ul>
      ` }
    ]
  }
];

const ALL_TITLES = CATEGORIES.map((c) => ({ slug: c.slug, title: c.title }));

function sidebar(activeSlug) {
  return `
  <nav class="doc-side-nav">
    ${ALL_TITLES.map((c) =>
      `<a href="${c.slug}.html"${c.slug === activeSlug ? ' class="active"' : ''}>${c.title}</a>`).join('\n    ')}
  </nav>`;
}

function page(cat, prev, next) {
  const prevNext = [];
  if (prev) prevNext.push(`<a class="pn-link" href="${prev.slug}.html"><span class="pn-dir">Previous</span>${prev.title}</a>`);
  else prevNext.push('<span class="pn-link pn-empty"></span>');
  if (next) prevNext.push(`<a class="pn-link next" href="${next.slug}.html"><span class="pn-dir">Next</span>${next.title}</a>`);
  else prevNext.push('<span class="pn-link pn-empty"></span>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cat.title} · Khuwari</title>
<meta name="description" content="${cat.blurb}">
<link rel="stylesheet" href="../site.css">
</head>
<body>

${NAV}

<div class="wrap doc-layout">

  <aside class="doc-side">
    <a class="doc-side-back" href="../docs.html">All docs</a>
    <div class="doc-side-title">Categories</div>
    ${sidebar(cat.slug)}
  </aside>

  <main class="doc-main">
    <nav class="crumbs rise" aria-label="Breadcrumb">
      <a href="../docs.html">Docs</a>
      <span class="crumb-sep">/</span>
      <span>${cat.title}</span>
    </nav>

    <header class="doc-head rise-1">
      <h1>${cat.title}</h1>
      <p>${cat.blurb}</p>
    </header>

    ${cat.sections.map((s, i) => `
    <section class="doc-sec" id="${s.id}">
      <h2>${s.title}</h2>
      ${s.html}
    </section>`).join('\n')}

    <nav class="pn-nav">
      ${prevNext.join('\n    ')}
    </nav>
  </main>

</div>

${FOOTER}

<script src="../site.js"></script>
</body>
</html>
`;
}

const idx = {};
CATEGORIES.forEach((c, i) => { idx[c.slug] = { cat: c, prev: CATEGORIES[i - 1] || null, next: CATEGORIES[i + 1] || null }; });

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
CATEGORIES.forEach((c) => {
  const { prev, next } = idx[c.slug];
  fs.writeFileSync(path.join(OUT, c.slug + '.html'), page(c, prev, next));
  console.log('wrote', c.slug + '.html');
});
