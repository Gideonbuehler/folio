# Folio

A PDF editor that runs entirely in the browser: nothing is uploaded. Built with
React, pdf.js (rendering, text and forms) and pdf-lib (writing).

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5180.
`npm run build` produces a static site in `dist/`.

## Desktop app (Windows)

Folio ships as a desktop app built with [Tauri](https://tauri.app). It uses the
WebView2 (Edge) engine that comes with Windows, so it renders exactly like the
browser version.

```bash
npm run app
```

```bash
npm run app:build
```

`npm run app` runs the app with hot reload. `npm run app:build` builds the
installer at `src-tauri/target/release/bundle/nsis/Folio_<version>_x64-setup.exe`.
The installer:

- installs per user, so no admin rights are needed
- adds Folio to the Start menu
- registers it for `.pdf` files ("Open with Folio", or set it as the default)

The app adds native Open/Save dialogs and true save-in-place: Ctrl+S writes
through a temporary file, so a failed save never damages the original. Opening
a second PDF from Explorer hands it to the running window, in a new tab. Closing
with unsaved changes asks first, web links in documents open in your default
browser, and the window reopens at the size and place you left it.

Building needs Rust (stable, MSVC) and the Visual Studio C++ build tools.

## What it does

- **Edit** (E): click any paragraph or list item to rewrite it in place. It
  keeps the size, color and line spacing and reflows within its column. Drag an
  existing image to move it, use the corner handles to resize it, or press
  Delete to remove it. Double-clicking text in Select mode does the same thing.
  The page is re-rendered with the change applied to its real content (see
  `src/lib/live.ts`), so whatever is underneath, such as a gradient or a photo,
  shows through. Saving applies the same content-stream rewrite, so the
  original isn't just covered over.
- Fonts: rewritten text keeps the original's look and line breaks. Where the
  PDF embeds a complete font (or a subset that has every character you type),
  that font is reused. Otherwise the text is set in a bundled font with the
  same character widths: Carlito for Calibri, Caladea for Cambria, Liberation
  Sans, Serif and Mono for Arial/Helvetica, Times and Courier. Characters a font
  lacks fall back, per character, to Noto Sans, Noto Sans Symbols 2 and Droid
  Sans Fallback (Chinese, Japanese, Korean), so any text those cover saves as
  real, searchable text. The fonts ship with the app and add 5.7 MiB to the
  installer (3.9 to 9.6 MiB; see `public/fonts/README.md`). Saved files embed
  only the glyphs used.
- Annotate: highlight, underline, strikethrough (select text, or use the
  pop-up that appears), sticky notes, comments on anything. These are saved as
  real PDF annotations.
- Draw: pen, rectangle, ellipse, line, arrow, text boxes, images, whiteout.
- Fill & sign: fill form fields, then draw, type or upload a signature, and add
  dates or check marks.
- Sign with certificate (Tools menu): draw a box (or pick an empty signature
  field), open your digital ID (.pfx/.p12; the password is typed into the
  dialog, used once to open the file and never stored), choose a saved
  handwritten signature or just the name, and Folio saves a signed copy. The
  signature is PAdES baseline B-B (ETSI.CAdES.detached, SHA-256, RSA or EC),
  added in an incremental update after all other changes, so its byte range
  covers the whole file. An unchanged file is signed as is, so signatures
  already in it stay valid (countersigning). Opening a signed PDF shows who
  signed, when, and whether the file was changed since; saving an unchanged
  signed file keeps it byte for byte, and saving edits warns first because
  the rewritten file can't keep the old signatures. Folio checks the signed
  bytes and the signature, not certificate authorities or revocation.
- Create forms (F, or the form field button in the toolbar): drag to place
  text fields, multi-line text fields, check boxes, radio buttons (buttons with
  the same group name are one choice), dropdowns and signature fields. Set the
  name, tooltip, required flag, default value, font size and choices in the
  context bar or the properties dialog (double-click a field). Saving writes
  real AcroForm fields with appearances, fillable in any reader; "Make fields
  fillable now" does the same in place so you can fill them in Folio straight
  away (Undo turns them back into editable designs).
- Compare (Tools > Compare with…): pick another version of the document to
  see the two side by side (scrolling together) or overlaid (what only the old
  version has in red, what only the new one has in blue). Pages are paired by
  their text, so inserted or removed pages are found; word-level changes are
  highlighted in both, a pixel comparison of the rendered pages shows other
  differences (images, graphics) as a layer you can turn off, and the list of
  changes steps through them (Up/Down, Esc to close). Unsaved edits are
  compared as they would be saved.
- Organize: reorder by dragging thumbnails; rotate, duplicate, insert, extract
  and delete pages; combine several PDFs.
- Redact: only what lies under a mark is removed, as in Acrobat. Glyphs
  under the mark are deleted from the text (neighboring words stay real,
  selectable, editable text). Images get the covered pixels painted over in a
  new copy. Vector shapes mostly inside a mark and annotations touching one
  are deleted. Fill marks with a solid color (black by default) or **Match
  background**, which rebuilds the area from the surrounding pixels. Hover
  over a mark to see what's underneath before saving. Content inside form
  XObjects (grouped content, or whole pages some exporters wrap in one) is
  redacted the same way, in a copy of the form for that page only. If a page
  draws content that can't be removed precisely under a mark (a form that
  can't be read, partly covered stencil masks), that page alone is flattened
  to an image, with a warning.
- Watermarks, page numbers, headers and footers, document properties, password
  protection (AES-256), export pages as PNG/JPEG, and print.
- Reduce file size (File menu, or Save with options): images shown at more
  than the chosen resolution (150, 220 or 300 dpi) are downsampled, large photos
  without transparency are stored as JPEG, identical images, fonts and other
  streams are stored once, uncompressed streams are compressed, and embedded
  thumbnails and other applications' private data are dropped. The toast after
  saving reports the size before and after.
- **Recognize text** (OCR): scanned pages get a small "Scanned page" notice;
  click **Recognize text** there for that page, or use **Tools > Recognize
  text** for every scanned page. Recognition runs on your device
  ([tesseract.js](https://github.com/naptha/tesseract.js) in a background
  worker, at 300 dpi) and can be cancelled. Recognized words then behave like
  any other page text: search finds them, you can select, copy, highlight and
  redact them, and Edit mode can rewrite them. Recognition is one undoable
  step. When you save, the words are written as an invisible text layer over
  the scan, so the file is searchable in any PDF reader. Words under a
  redaction mark, or replaced in Edit mode, are left out of it. Pages that
  already have text are never recognized again.

- Tabs: several documents open at once, each with its own undo history, zoom
  and scroll position. Ctrl+Tab / Ctrl+Shift+Tab switch, Ctrl+W closes, drag a
  tab to reorder it. Recent files are on the start screen and in the File menu.
- Autosave: a few seconds after a change, each unsaved document is copied to
  this computer (`%APPDATA%\app.folio.pdfeditor\recovery` in the desktop app,
  IndexedDB in the browser). If Folio crashes or is killed, the next start
  offers to restore them. Saving, closing a document or closing the window
  removes its copy. Nothing is sent anywhere.

## OCR languages

Folio ships with English. Each language is a `@tesseract.js-data/<code>`
package, so adding one is a single dependency, for example German:

```bash
npm install @tesseract.js-data/deu
```

`npm install` copies every installed language into `public/tesseract`
(`scripts/copy-tesseract-assets.mjs`), and Folio recognizes pages with all of
them together (here `eng+deu`). Language codes are listed in
`node_modules/tesseract.js/docs/tesseract_lang_list.md`.

## Known limits

- Fonts without a bundled match (Segoe UI, Georgia, Garamond, ...) are set in
  the closest bundled family, squeezed or stretched to the original width.
  Justified paragraphs keep their line breaks but are set ragged right.
- Bold and italic exist for the Latin fonts only; Chinese, Japanese and Korean
  text and symbols stay regular. Arabic, Indic and Thai scripts, and emoji, are
  not covered by the bundled fonts (saving warns about them). Hebrew is, with
  right-to-left words inside left-to-right lines.
- Text or images in unusual encodings, or inside form XObjects that can't be
  read, can't be removed from the content stream. Only those edits fall back
  to covering the original with a patch of the page's background color.
  Editing inside a form XObject writes a copy of it for that page, so other
  pages drawing the same form are unaffected.
- Effects drawn as separate objects, like the reflections under photos in some
  brochures, stay where they are when you move the photo. Move them separately,
  as you would in Acrobat.
- Vector artwork already in the PDF (lines, shapes) is not editable yet.
- OCR reads upright text only; pages scanned sideways should be rotated in the
  scan first. Recognized text gives no font information, so Edit mode sets
  rewritten scan text in Helvetica, sized and stretched to match.

## Layout

- `src/lib/content.ts`: content-stream tokenizer, interpreter and rewriter
  behind Edit mode saves
- `src/lib/export.ts`: builds the output PDF
- `src/lib/fontdb.ts`, `src/lib/fonts.ts`, `src/lib/docfonts.ts`: the fonts
  text is set in, measuring and line breaking, and reuse of fonts embedded in
  the PDF
- `src/lib/reduce.ts`: Reduce file size (runs at the end of `buildPdf`)
- `src/lib/compare.ts`: page pairing, word diff and pixel diff behind
  `src/components/CompareView.tsx`
- `src/lib/certsign.ts`: incremental signing and signature checks;
  `src/lib/certs.ts` digital IDs and CMS (node-forge opens the .pfx/.p12,
  Web Crypto signs and verifies), `src/lib/der.ts` the DER they need
- `src/lib/formfields.ts`: writes designed form fields as AcroForm fields;
  `src/lib/forms.ts` names them and makes them fillable in place
- `src/components/Overlay.tsx`: all on-page interaction (tools, Edit mode, selection)
- `src/lib/ocr.ts`, `src/lib/ocrModel.ts`, `src/lib/ocrPdf.ts`: text recognition,
  how recognized words join the page text, and the invisible text layer on save
- `scripts/make-samples.mjs`: generates the test PDFs in `public/samples/`,
  including a scanned document, a page wrapped in form XObjects and a 500-page
  document. Open one with `?file=/samples/sample.pdf`.
