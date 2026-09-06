# Caelogram visual system

## Thesis

An instrument for observing real architecture: neutral dark slate, precise typography, restrained warm controls, and luminous source bodies. Space is functional. Empty areas communicate a small repository rather than being filled with fictional stars.

## Tokens

| Token               | Value     | Use                                      |
| ------------------- | --------- | ---------------------------------------- |
| Ink                 | `#111110` | Background and negative space            |
| Observatory         | `#151514` | Inspector and working surfaces           |
| Boundary            | `#2c2b29` | Structure, separation, orbit scaffolding |
| Text                | `#e8e5de` | Primary information                      |
| Muted               | `#a69f90` | Secondary evidence and metadata          |
| Navigation accent   | `#e4c58c` | Primary action and selected component    |
| Structural platinum | `#d4c9b0` | Links and supportive navigation          |

DM Sans is used for interface copy; Space Grotesk for headings, counts, and the wordmark. Font files are bundled locally so private-code sessions do not contact a font CDN. Code uses the platform's monospace font. Surfaces use 5–8 px corner radii, one-pixel borders, and a 4/8 px spacing rhythm.

## Fixed visual meanings

| Property                         | Meaning                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| One luminous body                | One actual indexed file                                              |
| Region                           | Actual source subsystem/directory grouping                           |
| Color                            | Subsystem category, repeated in text labels                          |
| File radius and glow             | Log-scaled static incoming module-link count, capped for readability |
| Orbit around a file              | Multiple resolved incoming consumers                                 |
| Filament                         | Resolved module relationship                                         |
| Dashed filament                  | A test-file import; not a coverage guarantee                         |
| Highlighted body and connections | Included task-context file                                           |
| Dimmed body                      | Outside selected task context or current search match                |
| Small points at deeper zoom      | Actual AST declarations; at most 15 shown per file                   |
| Gold selection ring              | Current persistent inspector selection                               |
| Empty space                      | No additional indexed components; not hidden fictional complexity    |

Orbit scaffolding and a subtle ambient radial fill are non-data framing. They do not introduce extra file/symbol counts. Hover and focus disclose the file; click/Enter/Space persist selection. The inspector explains the appearance and exposes actual paths, static edges, confidence, and commit.

Do not encode churn, health, risk, coverage, staleness, or unreachable-code certainty until a corresponding extractor and revision-valid evidence exist. Unknown coverage and uncertain reachability are explicitly labeled. Alpha motion is user-controlled pan, zoom, and rotation; there is no continuous animation loop. Reduced-motion preferences disable motion and transitions.

## Navigation and accessibility

The console opens with a usable sample graph, not a mock marketing screenshot. Marketing remains available through the wordmark. Main areas are Repository map, Task context, Changesets, Audit trail, and Access/integrations. Connect a repository is persistent desktop navigation and available through the account page on narrow screens.

All data has a table/inspector alternative. SVG file bodies have keyboard roles, labels, and native titles. Search is literal and case-insensitive. Color never supplies the only meaning. Touch users can select files and use pan/zoom controls. A persistent details panel avoids hover-only disclosure.

Above 200 files, a counted region overview opens before drilling into file bodies. Region aggregates are labeled with actual member counts and are not presented as individual files. Rendering is currently SVG and should be regarded as an alpha limitation; the benchmark validates the backend at 2,500 files, not GPU frame rate at that density. WebGL and cross-device dense-map performance remain explicit rendering milestones. Do not fabricate nodes or hide truncation to improve apparent performance.

## Palette constraint

No blue is used. Backgrounds are neutral charcoal/slate; the subsystem palette uses warm white, grays, platinum, brass, and gold. Text labels and line styles keep regions distinguishable without relying on saturated hues.
