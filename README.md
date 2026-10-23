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
a second PDF from Explorer hands it to the running window. Closing with unsaved
changes asks first, and web links in documents open in your default browser.

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
- Annotate: highlight, underline, strikethrough (select text, or use the
  pop-up that appears), sticky notes, comments on anything. These are saved as
  real PDF annotations.
- Draw: pen, rectangle, ellipse, line, arrow, text boxes, images, whiteout.
- Fill & sign: fill form fields, then draw, type or upload a signature, and add
  dates or check marks.
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

## Known limits

- Replaced text is set in Helvetica, Times or Courier (closest match to the
  original). Its width is matched with horizontal scaling.
- Text or images in unusual encodings, or inside form XObjects that can't be
  read, can't be removed from the content stream. Only those edits fall back
  to covering the original with a patch of the page's background color.
  Editing inside a form XObject writes a copy of it for that page, so other
  pages drawing the same form are unaffected.
- Effects drawn as separate objects, like the reflections under photos in some
  brochures, stay where they are when you move the photo. Move them separately,
  as you would in Acrobat.
- Vector artwork already in the PDF (lines, shapes) is not editable yet.

## Layout

- `src/lib/content.ts`: content-stream tokenizer, interpreter and rewriter
  behind Edit mode saves
- `src/lib/export.ts`: builds the output PDF
- `src/components/Overlay.tsx`: all on-page interaction (tools, Edit mode, selection)
- `scripts/make-samples.mjs`: generates the test PDFs in `public/samples/`,
  including a page wrapped in form XObjects and a 500-page document. Open one
  with `?file=/samples/sample.pdf`.
