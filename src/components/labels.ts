import type { FieldKind, ObjType } from '../types';

export const OBJ_LABEL: Record<ObjType, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  ink: 'Drawing',
  text: 'Text',
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'Strikethrough',
  note: 'Note',
  image: 'Image',
  whiteout: 'Whiteout',
  redact: 'Redaction',
  field: 'Form field',
};

export const FIELD_LABEL: Record<FieldKind, string> = {
  text: 'Text field',
  multiline: 'Multi-line text field',
  checkbox: 'Check box',
  radio: 'Radio button',
  dropdown: 'Dropdown',
  signature: 'Signature field',
};
