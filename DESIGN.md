# Caelogram design

Caelogram is an inspection instrument for an existing, revision-bound repository. GitHub remains canonical; the interface helps a developer inspect structural evidence, resolve bounded task context, and take explicit changes toward validation and a draft pull request. It does not supply a coding model. This document records the implemented extension of the established visual world, alongside `PRODUCT.md` and `docs/orbital-direction.md`.

## Visual world and composition

Retain charcoal/slate, lighter gray, gold, and warm metallic accents. No blue. Reference galaxies inform depth and textured material; repository data supplies the celestial objects. Empty space is meaningful when a repository is small.

The frame uses the existing `web/orbit.css` values: background `#111213`, panel `#191a1a`, border `#333432`, muted text `#aaa69e`, gold `#d8bc86`, and primary text `#ece9e2`. Gold communicates selection and actionable emphasis. Region colors identify subsystems, not severity or runtime activity. The orbital palette is `#d9b572`, `#be8570`, `#c4c0b7`, `#9d9e84`, `#cfa493`, `#ae8d70`, `#c1ac7c`, and `#b5a1ac`, assigned in sorted subsystem order and repeated as needed. These are current implementation values, not a new token system.

DM Sans is the declared interface and numeric-fact face, with system/sans-serif fallbacks. Space Grotesk is declared for headings and the brand, also with system fallbacks. Revision identifiers and code use monospace. The orbital stylesheet reduces desktop headings to 32px, keeps facts at 18px with tabular numerals, and uses small, quiet labels. Font declarations do not establish that external font assets loaded.

Desktop composition places repository identity and commit context above a compact facts strip. A large map occupies the main column, with selected-component evidence at right. The toolbar puts Orbit, Heatmap, Components, and component search together. The orbital caption sits at the upper left; Top view, Spin/Pause spin, and Reset sit at the bottom. The legend explains the encodings. Borders and subtle surfaces separate the instrument; metrics are unboxed facts rather than headline cards.

The effective desktop orbit height is `clamp(440px, 52vh, 720px)`. At 1000px and below, the evidence panel moves beneath the map. At the final 650px breakpoint, the topbar is 44px high, the heading is 24px, and all four facts occupy one grid row. The orbit is 370px high, with 44px-tall view and orbital controls. This final composition fits the facts row and complete orbit/control area within the 390 × 844 mobile target; evidence continues below. Later rules in `orbit.css` override its earlier, taller viewport declarations.

## Three complementary views

| View | Purpose and behavior |
| --- | --- |
| Orbit | Rotatable perspective map with textured file bodies, depth, selection, search emphasis, and task-context emphasis. Large maps use a counted subsystem overview; selecting one opens that region. File pages are bounded to at most 350 bodies, with an explicit displayed range and full total, to bound GPU and texture memory. |
| Heatmap | Preserves the existing two-dimensional SVG galaxy for spatial inspection. Its own overview groups repositories above 200 files into counted regions, with region exploration. It shares component selection and context with Orbit. |
| Components | Accessible table of actual file components, subsystem, and incoming count. Search filters file paths; explicit buttons select components for the evidence panel. It provides keyboard selection independently of canvas rendering. |

## Data and visual semantics

| Encoding | Implemented meaning |
| --- | --- |
| File body | One indexed node whose kind is `file`; symbols are not extra planets. No decorative stars. |
| File size | Incoming non-`contains` edges: orbital radius is `0.42 + log2(incoming + 1) × 0.28`. |
| Star/glow | At least 3 incoming links, only in the nonaggregated file view. |
| Ring | At least 2 incoming links. Aggregated bodies can also meet this threshold. |
| Banded material | Subsystem name matches `config`, `schema`, or `database`. This is a naming-based texture cue, not inferred file contents. |
| Color | Subsystem membership. |
| Filament | Existing noncontainment relationship between visible files; selected connections gain emphasis. Test connections receive dashed treatment, with renderer-specific matching. |
| Region body | Actual member-file count; radius is `1 + log2(count + 1) × 0.3`, and incoming links are summed across members. |

The facts strip reads `data.files`, `data.symbols`, `data.relationships`, and the first eight revision characters. During a resolved task, the fourth fact becomes the estimated context-token count. Captions report actual current body or region counts. The indexed sample fixture contains 24 files, 26 symbols, and 22 noncontainment relationships: its file view therefore has 24 bodies. These quantities describe different entities and must not be inflated to produce a denser scene. Static links do not prove runtime reachability, execution, or impact. Search and task relevance dim unrelated bodies rather than inventing connections.

## Interaction, motion, and renderer resilience

Both renderers draw on demand for interaction, resize, and selection/context changes. Spin starts off and is explicitly controlled. A continuous frame loop runs only for enabled spin; hidden-document handling suppresses drawing. Reduced-motion preference prevents spin and stops an active spin when the preference changes. Button transitions are removed under reduced motion. Ordinary button feedback uses the existing short color/background transitions and press scale, with hover restricted to fine pointers.

The WebGL surface supports drag, zoom, pan, arrow-key rotation, plus/minus zoom, and Home reset. Its keyboard navigation stops spin. Controls have text labels and the canvas has a visible focus treatment and keyboard instructions. Components remains the direct keyboard route to selecting files.

WebGL2 initialization failure or context loss switches to `SoftwareOrbit.tsx`: an interactive Canvas 2D perspective projection of the same layout and topology. It keeps seeded textures, bands, glows, rings, selection, search, region exploration, and explicit controls. Drag rotates; wheel/pinch zooms; Shift-drag, right-drag, two-finger movement, or Shift-arrow keys pan. This is a working renderer path in code, not a static illustration or a replacement screenshot. Software and WebGL rendering are not pixel-identical.

This document is based on implementation inspection and the supplied final mobile composition. It does not claim successful WebGL execution or new browser verification.

## Emil review

| Before | After | Why |
| --- | --- | --- |
| Promotional eyebrow copy | Repository and revision lead | Put the developer's inspection task first. |
| Decorative glyph navigation | Plain navigation labels and purposeful SVG icons | Improve recognition and visual consistency. |
| Boxed headline metrics | Compact factual strip; one row on mobile | Preserve space for the map and its controls. |
| Ambient or broad motion treatment | Explicit spin, demand rendering, short interaction feedback, reduced-motion handling | Keep motion under user control and avoid idle rendering. |

Source skill references: [pbakaus/impeccable](https://github.com/pbakaus/impeccable) and [emilkowalski/skills](https://github.com/emilkowalski/skills), including the Emil design engineering guidance. Their craft and motion principles are applied within the user's existing no-blue direction.
