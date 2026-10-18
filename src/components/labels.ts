import type { ObjType } from '../types';

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
};
