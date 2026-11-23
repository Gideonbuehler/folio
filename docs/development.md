# Developing Folio

Folio is built with React, pdf.js (rendering, text and forms) and pdf-lib
(writing), and packaged for Windows with Tauri. The [README](../README.md)
covers installing and using it; this covers building, releasing and how it
works.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5180.
`npm run build` produces a static site in `dist/`.

## Desktop app (Windows)

The desktop app is built with [Tauri](https://tauri.app). It uses the WebView2
(Edge) engine that comes with Windows, so it renders exactly like the browser
version.

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

## Releases

Pushing a version tag builds the installer on GitHub Actions
(`.github/workflows/release.yml`, windows-latest, tauri-action) and publishes a
GitHub Release with the installer, its update signature and `latest.json`.
Installed copies check
`https://github.com/Gideonbuehler/folio/releases/latest/download/latest.json`
(`plugins.updater.endpoints`): quietly a few seconds after starting (a found
update only shows as an **Update** button in the header), and from
File > Check for updates. The prompt never closes unsaved work: it saves every
document first (Save and install) or waits (Install on next start). Installing
restarts Folio and reopens the documents that were open. File > About Folio
shows the version. Prereleases (`v1.2.0-beta.1`) are published but not offered
as updates.

Make a release:

```bash
npm run bump -- 0.2.0
```

That sets the version in package.json, package-lock.json,
src-tauri/tauri.conf.json, Cargo.toml and Cargo.lock (`patch`, `minor` and
`major` work too) and prints the commit, tag and push commands. Write the
release notes in the tag message (`git tag -a v0.2.0 -m "..."`): they become
the release body and the text in Folio's update prompt. The workflow refuses a
tag that doesn't match the version. Actions > Release > Run workflow only builds
the installer and keeps it as a workflow artifact.

### Setup

1. **Updater key.** The key pair was generated with `tauri signer generate`.
   Only the public key is in the repo (`plugins.updater.pubkey`). The private
   key is `%USERPROFILE%\.tauri\folio-updater.key`, its password in
   `folio-updater.key.password` next to it. They go in the repository secrets
   `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a backup (a password manager):
   if the key is lost, installed copies can't update any more and need a
   manual reinstall.
2. **Code signing (optional).** Unsigned installers make SmartScreen warn
   ("Windows protected your PC"). Updates are verified by the updater key either
   way. Release builds call `scripts/sign-windows.mjs` for every binary
   (`src-tauri/tauri.release.conf.json`); it signs with whatever these secrets
   provide and leaves files unsigned when there are none:
   - **Azure Artifact Signing** (formerly Trusted Signing), about $9.99 a
     month, the cheapest option; individuals in the US and Canada only
     (organizations also in the EU and UK), identity check takes a few days.
     Create an Artifact Signing account and a Public Trust certificate
     profile, an app registration with the signer role on it, then add
     `AZURE_TRUSTED_SIGNING_ENDPOINT` (for example
     `https://eus.codesigning.azure.net`), `AZURE_TRUSTED_SIGNING_ACCOUNT`,
     `AZURE_TRUSTED_SIGNING_PROFILE`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
     `AZURE_CLIENT_SECRET`.
   - **OV certificate** from a CA (DigiCert, Sectigo, SSL.com, Certum), about
     $150–300 a year, worldwide. Since 2023 new keys must live on a hardware
     token or cloud HSM, so a plain .pfx usually means a CA's cloud signing
     export or an older certificate: add it base64-encoded as
     `WINDOWS_CERTIFICATE` with `WINDOWS_CERTIFICATE_PASSWORD`. For a USB
     token, sign on your own machine: `WINDOWS_CERTIFICATE_THUMBPRINT`, then
     `npm run app:release`.
   - EV certificates ($400+ a year) no longer skip SmartScreen (since 2024),
     so they aren't worth it here. With any of these, warnings fade as signed
     releases build reputation.

A signed release build locally: set `TAURI_SIGNING_PRIVATE_KEY` (the key file's
path or contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, then
`npm run app:release`. `npm run app:build` stays unsigned and needs no key.

## Folio Sign (signing server)

`server/` is a small self-hosted signing service for Folio: Node 22.18 or
newer, no database (requests are JSON files and PDFs in a data folder), and
SMTP for mail. It serves Folio's built web app as the signing page.

```bash
npm run build
```

```bash
cd server
```

```bash
npm install
```

```bash
npm run new-key
```

Put the settings in `server/.env` (or the environment):

```
FOLIO_SIGN_KEYS=alice=<the key from new-key>,bob=<another key>
FOLIO_SIGN_PUBLIC_URL=https://sign.example.com
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM="Folio Sign <sign@example.com>"
```

```bash
npm start
```

Each sender enters the server address and their key in File > Signing
services. Without `SMTP_URL`, mail is written to `server/data/outbox` as .eml
files, which is how to try it locally: in development, run the server, set
`FOLIO_SIGN_PUBLIC_URL=http://localhost:5180` so links open the Vite dev server
(which forwards `/api` to the server on port 8787), and use
`http://127.0.0.1:8787` as the address in Folio. Other settings
(`FOLIO_SIGN_PORT`, `FOLIO_SIGN_HOST`, `FOLIO_SIGN_DATA`, `FOLIO_SIGN_WEB`,
`FOLIO_SIGN_MAX_MB`) are described in `server/src/config.ts`.

For real use, run it behind HTTPS (a reverse proxy such as Caddy or nginx in
front of port 8787, which also sets `X-Forwarded-For` so the audit trail gets
signers' addresses) and back up the data folder. Signing links are long random
tokens; anyone with a link can sign as that signer, which is the same trust a
signing email gives.

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

## How it works

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
- Request signatures (Tools menu): add signers (name and email, in order or
  all at once), pick a signer and place their fields: signature, initials,
  date signed, name, text and check boxes, each tinted in the signer's color.
  "Send for signature" writes the fields and the request into a copy and opens
  an email to the first signer with the copy attached. Folio never sends mail
  itself and nothing is uploaded: the desktop app hands the message to a mail
  program that takes attachments (Simple MAPI: classic Outlook, Thunderbird),
  and otherwise saves the copy, shows it in its folder and opens a mailto:
  link; the browser uses the share sheet, or a download and a mailto: link.
  - Signers who open the PDF in Folio see whose turn it is, click "Start
    signing" and are taken through their fields: signature and initials
    fields open the signature dialog and take the signature in place, date
    and name fill in by themselves, everyone else's fields are locked. Finish
    saves the signed copy and opens the email to the next signer (with the
    sender in copy), or back to the sender. They can also decline, with a
    reason. Without Folio, the fields work in any reader that fills forms.
  - The sender's Folio keeps a copy of what it sent and a fingerprint of every
    page. Opening a signed copy that comes back adds its signatures to that
    copy (so copies signed in parallel are combined) and says if any page
    differs from what was sent. File > Signature requests lists every request
    with who has signed, with Remind and Open. When everyone has signed,
    Finalize flattens the signatures and fields into the pages, adds a
    signing summary page (signers, times, history, what was checked and the
    SHA-256 of the copy sent) and saves the signed document, ready to email
    to the signers.
  - The request travels inside the PDF as a custom entry in the document
    information dictionary; signatures are locked stamp annotations named
    after their field until the sender finalizes. Signers are identified by
    the address the email went to; for proof against later changes, sign the
    finished document with a certificate.
  - Instead of your own email, a request can go out through a signing service
    (File > Signing services, then pick it in the send dialog):
    - Folio Sign, the signing server in `server/` (see below), emails each
      signer a personal link when it's their turn. The link opens Folio in the
      browser with just that document and the signing bar; finishing uploads
      the signed copy. The server records when each link was opened and
      signed and from which address. Folio collects the signed copies on
      start and from Signature requests (Check for updates), merges and checks
      them as above, and after finalizing, "Send to signers" has the server
      email everyone the finished document.
    - Documenso (documenso.com or self-hosted, with an API token): the
      document and the signers' fields go to Documenso's v2 API, which emails
      the signers, collects the signatures and seals the document. Folio shows
      its progress, reminds through it, and keeps the signed document it
      returns. The browser may block calls to it; the desktop app makes them
      through Tauri's HTTP plugin.
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
- `src/lib/envelope.ts`: the signature request carried in the PDF;
  `src/lib/prepare.ts` signers and their fields, `src/lib/signing.ts` guided
  signing, `src/lib/requests.ts` the sender's copies, merging and finalizing,
  `src/lib/mail.ts` handing messages to the mail program (Simple MAPI in
  `src-tauri/src/lib.rs`)
- `src/lib/services.ts`: the signing services and their settings;
  `src/lib/foliosign.ts` the Folio Sign API, `src/lib/linksign.ts` and
  `src/components/LinkSigning.tsx` signing from a link, `src/lib/documenso.ts`
  the Documenso API
- `server/`: Folio Sign (`src/main.ts` routes, `src/store.ts` requests on disk,
  `src/mail.ts` SMTP or the outbox folder)
- `src/lib/formfields.ts`: writes designed form fields as AcroForm fields;
  `src/lib/forms.ts` names them and makes them fillable in place
- `src/components/Overlay.tsx`: all on-page interaction (tools, Edit mode, selection)
- `src/lib/ocr.ts`, `src/lib/ocrModel.ts`, `src/lib/ocrPdf.ts`: text recognition,
  how recognized words join the page text, and the invisible text layer on save
- `scripts/make-samples.mjs`: generates the test PDFs in `public/samples/`,
  including a scanned document, a page wrapped in form XObjects and a 500-page
  document. Open one with `?file=/samples/sample.pdf`.
