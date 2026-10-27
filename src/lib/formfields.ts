/**
 * Form fields designed in Folio, written as real AcroForm fields with
 * appearance streams (pdf-lib's form API), so any reader can fill them.
 */
import {
  beginText,
  degrees,
  endText,
  fill,
  moveText,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRadioGroup,
  PDFTextField,
  rectangle,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  StandardFonts,
  stroke,
  type PDFOperator,
} from '@cantoo/pdf-lib';
import type { FieldKind, FieldObj, Matrix, Rect } from '../types';
import { applyMatrix, invertMatrix } from './geometry';
import { hexToRgb } from './util';

export interface FieldEntry {
  o: FieldObj;
  page: PDFPage;
  /** PDF user space -> page space for this page. */
  m: Matrix;
  /** Signature requests: the signer's name and color, shown on the field. */
  signer?: { name: string; color: string };
}

const BORDER = rgb(0.55, 0.58, 0.63);
const BORDER_WIDTH = 1;

/** Page rotation baked into `m`: how far the page's own /Rotate turns it. */
function rotationOf(m: Matrix) {
  const deg = Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI / 90) * 90;
  return ((deg % 360) + 360) % 360;
}

/** The field's rectangle in PDF user space. */
function userRect(r: Rect, m: Matrix) {
  const inv = invertMatrix(m);
  const pts = [applyMatrix(inv, r.x, r.y), applyMatrix(inv, r.x + r.w, r.y), applyMatrix(inv, r.x + r.w, r.y + r.h), applyMatrix(inv, r.x, r.y + r.h)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Options for pdf-lib's addToPage that land the widget exactly on `r` (user
 * space) with its content turned upright for a page rotated by `rot`.
 * (pdf-lib grows the box by the border width and anchors rotated boxes at a corner.)
 */
function placement(e: FieldEntry) {
  const color = e.signer ? rgb(...hexToRgb(e.signer.color)) : BORDER;
  const R = userRect(e.o, e.m);
  const rot = rotationOf(e.m);
  const b = BORDER_WIDTH / 2;
  const upright = rot % 180 === 0 ? { width: R.w - BORDER_WIDTH, height: R.h - BORDER_WIDTH } : { width: R.h - BORDER_WIDTH, height: R.w - BORDER_WIDTH };
  const anchor =
    rot === 90 ? { x: R.x + R.w - b, y: R.y + b } : rot === 180 ? { x: R.x + R.w - b, y: R.y + R.h - b } : rot === 270 ? { x: R.x + b, y: R.y + R.h - b } : { x: R.x + b, y: R.y + b };
  return {
    ...anchor,
    width: Math.max(1, upright.width),
    height: Math.max(1, upright.height),
    rotate: degrees(rot),
    borderColor: color,
    borderWidth: BORDER_WIDTH,
    backgroundColor: rgb(1, 1, 1),
    textColor: rgb(0, 0, 0),
  };
}

/** Text the form's font (Helvetica) can show; anything else becomes "?". */
export function encodable(font: PDFFont, text: string, warnings: Set<string>) {
  try {
    font.encodeText(text);
    return text;
  } catch {
    warnings.add('Some characters in form field values are not supported by the form font and were replaced with "?".');
    return [...text].map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return ch === '\n' ? ch : '?';
      }
    }).join('');
  }
}

function setCommon(field: PDFField, o: FieldObj) {
  if (o.tooltip) {
    const tip = PDFHexString.fromText(o.tooltip);
    field.acroField.dict.set(PDFName.of('TU'), tip);
    // pdf.js only looks for the tooltip on the widget itself.
    for (const w of field.acroField.getWidgets()) if (w.dict !== field.acroField.dict) w.dict.set(PDFName.of('TU'), tip);
  }
  if (o.required) field.enableRequired();
}

/**
 * Adds the designed fields to the output document's AcroForm. Returns each
 * field object's name in the file (names already in use get a suffix).
 */
export function addFormFields(doc: PDFDocument, entries: FieldEntry[], warnings: Set<string>): Map<string, string> {
  const names = new Map<string, string>();
  if (!entries.length) return names;
  const form = doc.getForm();
  const font = form.getDefaultFont();
  const taken = new Set(form.getFields().map((f) => f.getName()));

  // Fields sharing a name and kind are one field with several widgets, as in Acrobat.
  const groups = new Map<string, FieldEntry[]>();
  const renamed = new Set<string>();
  for (const e of entries) {
    let name = e.o.name.trim().replace(/\./g, '_') || 'Field';
    let key = `${e.o.kind === 'multiline' ? 'text' : e.o.kind}:${name}`;
    const clash = () => {
      const g = groups.get(key);
      const kindClash = [...groups.keys()].some((k) => k !== key && k.endsWith(`:${name}`));
      return (!g && taken.has(name)) || kindClash || (e.o.kind === 'signature' && !!g);
    };
    if (clash()) {
      renamed.add(name);
      const stem = name;
      for (let n = 2; ; n++) {
        name = `${stem}_${n}`;
        key = `${e.o.kind === 'multiline' ? 'text' : e.o.kind}:${name}`;
        if (!clash()) break;
      }
    }
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
    names.set(e.o.id, name);
  }
  if (renamed.size) warnings.add(`Form fields with names already in use were renamed (${[...renamed].join(', ')}).`);

  for (const [key, list] of groups) {
    const name = key.slice(key.indexOf(':') + 1);
    const first = list[0].o;
    try {
      writeField(doc, form, font, name, first.kind, list, warnings);
    } catch (e) {
      console.warn('Form field not written', e);
      warnings.add(`The form field "${name}" could not be created.`);
      for (const e of list) names.delete(e.o.id);
    }
  }
  return names;
}

function writeField(doc: PDFDocument, form: ReturnType<PDFDocument['getForm']>, font: PDFFont, name: string, kind: FieldKind, list: FieldEntry[], warnings: Set<string>) {
  const first = list[0].o;
  let field: PDFField;
  switch (kind) {
    case 'text':
    case 'multiline': {
      const tf: PDFTextField = form.createTextField(name);
      if (list.some((e) => e.o.kind === 'multiline')) tf.enableMultiline();
      if (first.fontSize > 0) tf.setFontSize(first.fontSize);
      const value = first.value ? encodable(font, first.value, warnings) : '';
      if (value) {
        tf.setText(value);
        tf.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText(value));
      }
      for (const e of list) tf.addToPage(e.page, placement(e));
      field = tf;
      break;
    }
    case 'checkbox': {
      const cb: PDFCheckBox = form.createCheckBox(name);
      for (const e of list) cb.addToPage(e.page, placement(e));
      if (first.checked) {
        cb.check();
        const on = cb.acroField.getOnValue();
        if (on) cb.acroField.dict.set(PDFName.of('DV'), on);
      }
      field = cb;
      break;
    }
    case 'radio': {
      const rg: PDFRadioGroup = form.createRadioGroup(name);
      const used = new Set<string>();
      let selected: string | null = null;
      for (const e of list) {
        let choice = encodable(font, (e.o.choice || 'Choice').trim() || 'Choice', warnings);
        if (used.has(choice)) {
          const stem = choice;
          for (let n = 2; used.has(choice); n++) choice = `${stem} ${n}`;
        }
        used.add(choice);
        rg.addOptionToPage(choice, e.page, placement(e));
        if (e.o.checked && selected === null) selected = choice;
      }
      if (selected !== null) {
        rg.select(selected);
        const v = rg.acroField.getValue();
        if (v) rg.acroField.dict.set(PDFName.of('DV'), v);
      }
      field = rg;
      break;
    }
    case 'dropdown': {
      const dd: PDFDropdown = form.createDropdown(name);
      const options = [...new Set((first.options ?? []).map((v) => encodable(font, v.trim(), warnings)).filter(Boolean))];
      if (options.length) dd.addOptions(options);
      if (first.fontSize > 0) dd.setFontSize(first.fontSize);
      const value = first.value ? encodable(font, first.value, warnings) : '';
      if (value && options.includes(value)) {
        dd.select(value);
        dd.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText(value));
      }
      for (const e of list) dd.addToPage(e.page, placement(e));
      field = dd;
      break;
    }
    case 'signature': {
      // pdf-lib can't create signature fields; this is the minimal field-and-widget dictionary.
      const e = list[0];
      const ctx = doc.context;
      const R = userRect(e.o, e.m);
      const ap = e.signer ? signHereAppearance(doc, R, rotationOf(e.m), e, warnings) : ctx.formXObject([], { BBox: [0, 0, R.w, R.h] });
      const widget = ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFHexString.fromText(name),
        Rect: [R.x, R.y, R.x + R.w, R.y + R.h],
        F: 4,
        P: e.page.ref,
        MK: { R: rotationOf(e.m), BC: [0.55, 0.58, 0.63] },
        AP: { N: ctx.register(ap) },
        ...(first.tooltip ? { TU: PDFHexString.fromText(first.tooltip) } : {}),
        ...(first.required ? { Ff: 2 } : {}),
      });
      const ref = ctx.register(widget);
      e.page.node.addAnnot(ref);
      form.acroForm.addField(ref);
      return;
    }
  }
  setCommon(field, first);
}

/**
 * What an empty signature field of a signature request looks like in any
 * reader: a tinted box in the signer's color saying who signs there. The
 * content is turned so it reads upright on rotated pages.
 */
function signHereAppearance(doc: PDFDocument, R: Rect, rot: number, e: FieldEntry, warnings: Set<string>) {
  const ctx = doc.context;
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const [r, g, b] = hexToRgb(e.signer!.color);
  const tint = (c: number) => 1 - 0.1 * (1 - c);
  const [W, H] = rot % 180 === 0 ? [R.w, R.h] : [R.h, R.w];
  const what = e.o.role === 'initials' ? 'Initials' : 'Sign here';
  const size = Math.max(4, Math.min(9, H * 0.3, (W - 6) / Math.max(1, (what.length + e.signer!.name.length + 3) * 0.5)));
  const label = encodable(font, `${what}: ${e.signer!.name}`, warnings);
  const ops: PDFOperator[] = [
    setFillingRgbColor(tint(r), tint(g), tint(b)),
    rectangle(0, 0, W, H),
    fill(),
    setStrokingRgbColor(r, g, b),
    setLineWidth(1),
    rectangle(0.5, 0.5, Math.max(0, W - 1), Math.max(0, H - 1)),
    stroke(),
    setFillingRgbColor(r * 0.8, g * 0.8, b * 0.8),
    beginText(),
    setFontAndSize('F0', size),
    moveText(3, Math.max(2, H - size - 2)),
    showText(font.encodeText(label)),
    endText(),
  ];
  const matrix = rot === 90 ? [0, 1, -1, 0, 0, 0] : rot === 180 ? [-1, 0, 0, -1, 0, 0] : rot === 270 ? [0, -1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0];
  return ctx.formXObject(ops, { BBox: [0, 0, W, H], Matrix: matrix, Resources: { Font: { F0: font.ref } } });
}
