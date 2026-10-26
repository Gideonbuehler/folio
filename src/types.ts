import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Affine matrix [a, b, c, d, e, f] in the PDF convention. */
export type Matrix = [number, number, number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;

/** A PDF that pages were taken from. Immutable once loaded. */
export interface SourceDoc {
  id: string;
  name: string;
  /** Untouched bytes as read from disk; pdf.js gets its own copy. */
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  password?: string;
}

/**
 * A page in the working document. Geometry is expressed in "page space":
 * points, origin top-left, y down, as the page appears with its own /Rotate
 * applied. Objects drawn on the page live in this space, so they follow the
 * page through user rotation and reordering.
 */
export interface PageItem {
  id: string;
  src: string;
  index: number;
  /** Rotation the user added on top of the page's own /Rotate. */
  rotation: Rotation;
  w: number;
  h: number;
  baseRotate: number;
  /** PDF user space -> page space. */
  m: Matrix;
}

/** Bundled font families (see lib/fontdb.ts). */
export type FontFamily = 'sans' | 'serif' | 'mono' | 'carlito' | 'caladea' | 'noto';

interface Base {
  id: string;
  page: string;
  created: number;
  author?: string;
  /** Free-form comment shown in the Comments panel. */
  comment?: string;
  opacity: number;
}

export interface BoxObj extends Base {
  type: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string | null;
  fill: string | null;
  width: number;
}

export interface LineObj extends Base {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  width: number;
}

export interface InkObj extends Base {
  type: 'ink';
  /** Each stroke is a flat list [x0, y0, x1, y1, ...]. */
  strokes: number[][];
  stroke: string;
  width: number;
}

export interface TextObj extends Base {
  type: 'text';
  x: number;
  y: number;
  text: string;
  font: FontFamily;
  /** Font embedded in the source PDF, used instead of `font` while it can draw the text. */
  embedded?: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  /** Clockwise degrees around the box center (watermarks). */
  rotate?: number;
  /** Wrap width in points; without it the box grows to fit each line. */
  width?: number;
  /** Line spacing as a multiple of the font size (default 1.2). */
  lineHeight?: number;
  /** Horizontal glyph scaling, used to match the width of replaced text. */
  hscale?: number;
  /** Area of original page text this object replaces. */
  cover?: Rect & { color: string };
}

export interface MarkupObj extends Base {
  type: 'highlight' | 'underline' | 'strike';
  rects: Rect[];
  color: string;
  /** The page text the markup covers, for the Comments panel. */
  text?: string;
}

export interface NoteObj extends Base {
  type: 'note';
  x: number;
  y: number;
  color: string;
}

export interface ImageObj extends Base {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  signature?: boolean;
  /** Where the original page image was, for images lifted in Edit mode. */
  orig?: Rect;
  /** Visible part of the image as fractions of its box (the PDF clips the rest). */
  crop?: { l: number; t: number; r: number; b: number };
  /** Background painted over the original image's spot in the editor. */
  cover?: Rect & { color: string };
}

export interface FillObj extends Base {
  type: 'whiteout' | 'redact';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Original page content under this whiteout is deleted from the file on save. */
  erase?: 'text' | 'image';
  /** Redactions only: fill with the surrounding background instead of `color`. */
  match?: boolean;
}

export type FieldKind = 'text' | 'multiline' | 'checkbox' | 'radio' | 'dropdown' | 'signature';

/** A form field being designed; saved as a real AcroForm field. */
export interface FieldObj extends Base {
  type: 'field';
  kind: FieldKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Field name. Radio buttons sharing a name form one group; other fields sharing one stay in sync. */
  name: string;
  tooltip?: string;
  required?: boolean;
  /** Text and dropdown fields: the value it starts with. */
  value?: string;
  /** Check boxes and radio buttons: on to start with. */
  checked?: boolean;
  /** Radio buttons: the value the group takes when this button is chosen. */
  choice?: string;
  /** Dropdown choices. */
  options?: string[];
  /** Text size in points; 0 fits the text to the field. */
  fontSize: number;
}

export type Obj = BoxObj | LineObj | InkObj | TextObj | MarkupObj | NoteObj | ImageObj | FillObj | FieldObj;
export type ObjType = Obj['type'];

export type Tool =
  | 'select'
  | 'hand'
  | 'editText'
  | 'text'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'note'
  | 'whiteout'
  | 'redact'
  /** Drawing the box for a certificate signature. */
  | 'certSign'
  | FieldTool;

export const FIELD_TOOLS = {
  fieldText: 'text',
  fieldMultiline: 'multiline',
  fieldCheckbox: 'checkbox',
  fieldRadio: 'radio',
  fieldDropdown: 'dropdown',
  fieldSignature: 'signature',
} as const satisfies Record<string, FieldKind>;

export type FieldTool = keyof typeof FIELD_TOOLS;

export interface DocMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

/** Style the next object of each kind is created with. */
export interface ToolStyle {
  stroke: string;
  fill: string | null;
  width: number;
  opacity: number;
  highlight: string;
  underline: string;
  strike: string;
  inkColor: string;
  inkWidth: number;
  textColor: string;
  font: FontFamily;
  size: number;
  bold: boolean;
  italic: boolean;
  noteColor: string;
  redactColor: string;
  redactMatch: boolean;
}

export type Dialog =
  | { kind: 'signature' }
  | { kind: 'watermark' }
  | { kind: 'pageNumbers' }
  | { kind: 'properties' }
  | { kind: 'save'; saveAs: boolean; reduce?: boolean }
  | { kind: 'password'; name: string; retry: boolean; resolve: (pw: string | null) => void }
  | { kind: 'exportImages' }
  | { kind: 'field'; id: string }
  | { kind: 'certSign' }
  | { kind: 'signatures' }
  | { kind: 'shortcuts' };
