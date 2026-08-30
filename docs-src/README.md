# Docs source

The pages in `docs/` are generated from the Markdown files in this folder, one
file per category. To regenerate the pages:

    node site_tools/gen-docs-subpages.js

`docs/` is committed, so commit the regenerated pages together with your text
changes. Do not hand-edit the HTML in `docs/`; it will be overwritten.

## Front matter

Every file starts with a `---` block holding the slug, the title and the
blurb (the blurb is shown under the heading and used as the meta description):

    ---
    slug: getting-started
    title: Getting started
    blurb: What Khuwari is, how to open it, and how a project becomes one tidy file.
    ---

The slug must match the file name, and the file must sit in the right slot of
the sidebar order (see `PAGE_ORDER` in the generator if you add a page).

## Sections

Each `## Heading` starts a section with its own anchor. You can pin the anchor
id, or leave it out and the generator slugs the heading for you:

    ## What is a gap? {#what-is-gap}

`### Sub-heading` works inside a section.

## Markup

- `**bold**` becomes `<strong>`, `` `code` `` becomes `<code>`.
- `- item` makes a bullet list, `1. item` a numbered list.
- Tables are written pipe-style: the first row is the header, the second row
  is a `| --- |` separator, and the rest are body rows.
- Raw HTML passes through untouched, so `<kbd>Ctrl</kbd>` and
  `<a href="...">` links work as-is.
- `[[kbd:Delete]]` is a shorter way to write `<kbd>Delete</kbd>`.
- `[[na]]` renders the muted dash used for "no shortcut" cells in tables.
- `[[note]]` on its own line turns the next paragraph into a callout box.
- `[[fig:name]]` on its own line inserts a figure. The available names are
  the keys of the `FIG` library in `site_tools/gen-docs-subpages.js`
  (for example `[[fig:appWindow]]`, `[[fig:historyFig]]`, `[[fig:keys]]`).

## Keep in sync

- The search index in `docs-data.js` maps search topics to section anchors.
  When you add or rename a section, update the matching entry there too.
- Preview a change without touching `docs/`:
  `node site_tools/gen-docs-subpages.js --out /tmp/docs-preview`