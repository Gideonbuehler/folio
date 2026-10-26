# Bundled fonts

Folio sets text it writes (Edit mode rewrites, text boxes, watermarks, page
numbers) in these fonts, on screen and in saved files. They ship with the app
and are only ever read from here; nothing is downloaded at runtime.

| Family | Files | Stands in for | License | Source |
| --- | --- | --- | --- | --- |
| Liberation Sans, Serif, Mono 2.1.5 | `Liberation*.ttf` (4 styles each) | Arial/Helvetica, Times New Roman/Times, Courier New/Courier (same character widths) | SIL OFL 1.1 (`LICENSE-Liberation.txt`) | github.com/liberationfonts/liberation-fonts, release 2.1.5 |
| Carlito | `Carlito-*.ttf` | Calibri (same widths) | SIL OFL 1.1 (`LICENSE-Carlito.txt`) | github.com/google/fonts, `ofl/carlito` |
| Caladea | `Caladea-*.ttf` | Cambria (same widths) | SIL OFL 1.1 (`LICENSE-Caladea.txt`) | github.com/google/fonts, `ofl/caladea` |
| Noto Sans | `NotoSans-*.ttf` | Fallback for Latin, Greek and Cyrillic the font above lacks; also offered in the Font menu | SIL OFL 1.1 (`LICENSE-NotoSans.txt`) | github.com/notofonts/notofonts.github.io, `fonts/NotoSans/unhinted/ttf` |
| Noto Sans Symbols 2 | `NotoSansSymbols2-Regular.ttf` | Fallback for symbols, dingbats and check boxes (✓ ☑ ❖ ➢ ■) | SIL OFL 1.1 (`LICENSE-NotoSansSymbols2.txt`) | same, `fonts/NotoSansSymbols2/unhinted/ttf` |
| Droid Sans Fallback | `DroidSansFallback.ttf` | Fallback for Chinese, Japanese and Korean (20,902 ideographs, all 11,172 Hangul syllables, kana) | Apache 2.0 (`LICENSE-DroidSansFallback.txt`) | Android Open Source Project, `frameworks/base/data/fonts` at `kitkat-release` |

`DroidSansFallback.ttf` was changed in one way: `scripts/fix-glyph-flags.mjs`
cleared a reserved bit that the original sets in its glyph point flags, which
Chrome's (and so WebView2's) font sanitizer rejects. The outlines are unchanged.

## Size

| | On disk | Compressed (brotli, as Tauri embeds assets) |
| --- | --- | --- |
| Liberation (12 files) | 4.16 MB | 2.02 MB |
| Carlito (4) | 2.61 MB | 0.92 MB |
| Caladea (4) | 0.32 MB | 0.15 MB |
| Noto Sans (4) | 1.67 MB | 0.76 MB |
| Noto Sans Symbols 2 | 0.64 MB | 0.27 MB |
| Droid Sans Fallback | 3.76 MB | 1.47 MB |
| Total | 13.15 MB | 5.57 MB |

Measured on the Windows build (`npm run app:build`), against the build of the
commit before the fonts were added:

| | Before | With the fonts | Added |
| --- | --- | --- | --- |
| Installer (`Folio_0.1.0_x64-setup.exe`) | 3.87 MiB | 9.59 MiB | 5.72 MiB |
| Installed `folio.exe` | 5.95 MiB | 11.68 MiB | 5.73 MiB |

That includes fontkit (about 0.15 MiB compressed), which subsets the fonts on
save and checks a PDF's own fonts in Edit mode; it loads on first use.

The editor only loads the faces a document needs (a Calibri paragraph loads
Carlito and nothing else); the CJK fallback loads the first time such text
appears.

## Changing the fonts

After adding, removing or replacing a file here, update `FAMILIES` in
`scripts/build-font-manifest.mjs` if needed and run

```bash
node scripts/build-font-manifest.mjs
```

It writes `src/lib/fonts.manifest.json`: each face's file, style, vertical
metrics and the characters it covers, which the editor uses to pick a font per
character before any font has loaded.
