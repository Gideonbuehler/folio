# Folio

A PDF editor for Windows in the spirit of Acrobat, with a clean interface. It
edits what is already in a PDF, not just what you add on top, and everything
runs on your computer: documents are never uploaded.

## Install

1. Download `Folio_<version>_x64-setup.exe` from the
   [latest release](https://github.com/Gideonbuehler/folio/releases/latest).
2. Run it. Folio installs for your user account only, so no administrator
   rights are needed, and appears in the Start menu. It needs Windows 10 or 11
   (64-bit); the WebView2 component it uses is part of Windows and is
   downloaded automatically if it's missing.
3. If Windows shows "Windows protected your PC", the installer isn't
   code-signed yet: click **More info**, then **Run anyway**.

To open PDFs in Folio by double-clicking them, right-click a PDF, choose
**Open with > Choose another app**, select Folio and click **Always**.

Folio keeps itself up to date. It checks for a new version when it starts and
shows an **Update** button in the header when there is one (or use
File > Check for updates). Updating never closes unsaved work: Folio saves your
documents first, or installs the next time it starts, and reopens what you had
open. File > About Folio shows the version you have.

To uninstall, use Settings > Apps > Installed apps.

## What it can do

- **Edit text and images in place.** Click any paragraph to rewrite it: it
  keeps its font, size, color and line spacing and reflows within its column.
  Move, resize or delete the images already on the page. The page's real
  content is changed, not covered with a patch.
- **Annotate.** Highlight, underline, strike through, add sticky notes and
  comments, saved as standard PDF annotations any reader shows.
- **Draw and add.** Pen, rectangles, ellipses, lines, arrows, text boxes,
  images and whiteout.
- **Fill and sign.** Fill in form fields, then draw, type or upload a
  signature and add dates or check marks.
- **Create forms.** Text fields, check boxes, radio buttons, dropdowns and
  signature fields that work in any PDF reader.
- **Sign with a certificate.** Digitally sign with your digital ID (.pfx or
  .p12), and see who signed a document and whether it changed since.
- **Request signatures.** Place fields for each signer and send the document
  by email, through your own Folio Sign server (signing links that work on
  phones too) or through Documenso. Track who has signed, send reminders, and
  finish with a signing summary page.
- **Redact.** Remove exactly what lies under a mark (text, the covered part of
  an image, shapes and annotations) for good, with a solid color or a fill that
  matches the background.
- **Recognize text (OCR).** Make scanned pages searchable, selectable and
  editable, with recognition running on your computer.
- **Compare.** See two versions side by side or overlaid, with changed words
  and visual differences highlighted.
- **Organize pages.** Reorder, rotate, duplicate, insert, extract and delete
  pages, and combine several PDFs into one.
- **Reduce file size.** Shrink oversized images and drop duplicate and unneeded
  data.
- **Protect and finish.** Password protection (AES-256), watermarks, page
  numbers, headers and footers, document properties, export pages as PNG or
  JPEG, and print.
- **Work comfortably.** Several documents in tabs, each with its own undo
  history; recent files; true save in place (a failed save never damages the
  original); autosave that brings back unsaved work after a crash; PDFs opened
  from Explorer join the running window; light and dark themes; keyboard
  shortcuts (press ? to see them).

Building Folio, making releases and how it works inside:
[docs/development.md](docs/development.md).
