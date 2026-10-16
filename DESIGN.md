# DESIGN.md

Visual source of truth. The values live as CSS variables in `web/src/styles.css`;
this file states the rules, not the values.

## The rule: one scale, a few bricks

Nothing is hard-coded. A new element reuses the existing bricks; if it needs a
size that does not exist, the scale is discussed, not one more exception.

| Scale | Variables | Phone |
|---|---|---|
| Text | `--fs-xs` `--fs-sm` `--fs-md` `--fs-lg` `--fs-xl` | one step up (16 px base, otherwise iOS zooms) |
| Control height | `--h-sm` `--h` | 32 and 40 px |
| Radius | `--r-sm` `--r` `--r-lg` `--r-pill` | same |
| Spacing | `--s1` to `--s5` (4, 8, 12, 16, 24) | same |

One font (Inter, with system fallbacks), monospace included: code and logs keep
the same family with tabular figures.

## Bricks

- **Button** `.btn`: one height, one radius, one border. Color variants only:
  `prim`, `on`, `danger`; `bare` removes the frame; `ico` makes it square; `sm`
  uses the small height; `round` for the chat send button. No icon is a typed
  character ("×", "+"): everything goes through `Icons.jsx`, single-weight
  line drawings.
- **Tag** `.tag`: one size, one shape; families (`moved`, `warn`, `verdict`,
  `time`, `appt`, `st-*`) only change the color. Clickable: `.tag.link`.
- **Field** `.field`: every input outside the line editor.
- **Switch** `.seg`: several views of the same screen.
- **Pop-up** `Pop` (`Pickers.jsx`): anchored on large screens, bottom sheet on
  phones. Calendar, day picker, time picker. No native browser input.

## Colors

Theme variables, dark by default, light with `data-theme="light"`. Families:
accent (`--acc*`), warning (`--warn*`), danger (`--danger*`), postponed (`--moved*`).

## Shell

Single-band header: the sidebar logo has the height and the rule of the top bar
(`--top-h`). Side navigation: agenda (today, week, inbox) / knowledge /
assistant. The "Assistant" button opens and closes the chat. Top bar: panel,
previous / next day, title, worker, theme, undo, redo, go to a day.

## Outliner

Row `.orow`, handle `.grip`, checkbox `.cb`. On hover, three `.btn.ico.sm.bare`
buttons (note, time, day) are laid over the end of the row (`.racts`). The
agent's review badge sits on the left, against the handle; tags on the right.
On phones, the gesture bar (`.linebar`) replaces the navigation while editing.

## Knowledge: the note

Read top to bottom in one column: title, a TL;DR (the note's thesis), then the
text. Fields written for the model (counter-argument, exception, use-for, links,
tags, "See also" block) stay in the file and are not displayed.

## Knowledge: folder colors

Hues are assigned, not hashed (`Kb.jsx`), from the top-level folder name:
knowledge orange (28), projects green (145), memory red (0), archives blue (220),
root blue (210); other folders get a spare hue. The top-level folder is vivid;
files and sub-folders keep its hue and get lighter (and more saturated) per level.

## Files

- Scale, bricks, shell, outliner, chat: `web/src/styles.css`
- Pop-ups: `web/src/Pickers.jsx`
- Knowledge: `web/src/Kb.jsx`, `web/src/kb.css`
- Attachments: `web/src/attachments.css`
