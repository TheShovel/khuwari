---
slug: undo-redo
title: Undo & redo
blurb: Stepping your edits back and forward, in the timeline and in the paint tool.
---

## Undo and redo {#undo-redo}

The transport at the bottom of the timeline has Undo and Redo buttons. Everything you do to your keyframes, gaps, layers, dots, camera and audio lands on the history stack, so a couple of clicks can walk any change back. Try things; that is the point of undo.

[[fig:historyFig]]

## Shortcuts {#shortcuts}

| Key | Action |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd> | undo |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd>, or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Y</kbd> | redo |

## In the paint tool {#paint}

The paint tool keeps its own history, separate from the timeline's. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd> undoes your last stroke or tool action; <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Y</kbd> redoes it. Each time you open the tool it starts fresh, so there is no undoing yesterday's strokes. Plan accordingly.

## Slider edits collapse {#coalescing}

Dragging a slider (a camera pan or a squash amount, for example) records one undo step for the whole gesture, not one per frame. So one <kbd>Ctrl</kbd> + <kbd>Z</kbd> reverts the entire drag instead of just the last tick. Undo stays one step ahead of you.