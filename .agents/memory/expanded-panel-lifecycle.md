---
name: Expanded panel lifecycle
description: Why expanded tiles use native top-layer promotion rather than a second widget or a movable portal.
---

Keep expanded tiles as a single continuously connected widget and media DOM owner. Promote the existing host into the browser top layer; do not mount a second widget or move media into a different portal container.

**Why:** React state preservation alone does not protect iframe/video playback when DOM is detached and reparented. Fixed overlays under the dashboard's transformed grid also inherit its scale and clipping.

**How to apply:** Expansion and collapse must change presentation only. Keep wrappers stable, retain real measured width, lift reveal budgets transiently, and route nested widget portals inside the promoted host so they appear above it. Native Popover API support is required; unsupported browsers retain normal tile actions.

Expanded panels should fit their content, avoid dead space, and display the tile title only once.

**Why:** The user rejected repeated titles and near-full-screen panels with little content.

**How to apply:** Use intrinsic height for ordinary content and lists with a viewport scroll cap; reserve bounded working surfaces for media, canvases and editors that cannot supply an intrinsic height. Do not restore a universal full-screen frame.