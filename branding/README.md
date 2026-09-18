# Branding

Source artwork and the script that turns it into Android resources.

## Files

| File | What it is |
|---|---|
| `icon-full.svg` | The complete icon — squircle, emblem, NEXUS wordmark. Source of the legacy launcher PNGs and the Play Store listing icon. |
| `icon-adaptive-foreground.svg` | Emblem only, transparent, re-centred and scaled into the adaptive safe zone. No wordmark: an adaptive icon is cropped to a circle on most launchers, and bottom-anchored text is the first thing lost. |
| `play-store-icon-512.png` | 512×512 for the Play Console listing. |
| `render-icons.mjs` | Rasteriser. |

## Regenerating

`sharp` is not a project dependency — icons change rarely and a native image library is not
worth carrying in the app's `package.json`. Install it where you run the script:

```bash
npm i sharp
node render-icons.mjs ../clients/web/android/app/src/main/res
```

It writes, for every density (mdpi → xxxhdpi):

- `ic_launcher.png` — legacy, 48dp base, supplies its own squircle
- `ic_launcher_round.png` — the same, circularly masked
- `ic_launcher_foreground.png` — adaptive foreground, 108dp canvas

## Not generated

Two layers are hand-written vectors rather than bitmaps, in
`clients/web/android/app/src/main/res/drawable/`:

- `ic_launcher_background.xml` — the diagonal gradient. A vector because the launcher scales
  the background layer 1.5× for its parallax, which a bitmap does not survive cleanly.
- `ic_launcher_monochrome.xml` — the Android 13+ themed-icon layer. The launcher tints it to
  the wallpaper palette, so it must be a flat silhouette with no colour and no glow of its own.

## Why the SVG is not a VectorDrawable

It uses `feGaussianBlur` filters and `<text>`. VectorDrawable supports neither, so the full
artwork has to be rasterised. That is why the emblem is redrawn by hand for the monochrome
layer instead of being converted.
