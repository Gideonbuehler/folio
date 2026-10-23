import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { ArrowDownToLine, ArrowUpToLine, Copy, MessageSquarePlus, Trash2 } from 'lucide-react';
import { FIELD_TOOLS, type FieldTool, type ImageObj, type InkObj, type Obj, type PageItem, type Point, type Rect, type TextObj, type Tool } from '../types';
import {
  actions,
  beginGesture,
  commit,
  deleteObjects,
  duplicateObjects,
  endGesture,
  reorderObjects,
  setHole,
  toolDone,
  transient,
  updateObjectsTransient,
  useStore,
} from '../store';
import { clientToPage, moveObj, NOTE_SIZE, objBounds, pointInRect, rectFromPoints, rectsIntersect, resizeObj, unionRects } from '../lib/geometry';
import { firstBaseline, LINE_HEIGHT, measureText, offsetAt, TEXT_PAD, textWidth } from '../lib/fonts';
import { buildLines, buildParagraphs, findImages, getText, imagePixels, lineFont, type PageImage, type Paragraph } from '../lib/pdfjs';
import { matchingPatch, sampleColors } from '../lib/sample';
import { uid } from '../lib/util';
import { BaseShape, CoverShape, cssTransform, HighlightShape, inkPath, NoteView, svgTransform, textStyle, TextView, TopShape } from './objects';
import { ContextMenu, type MenuItem } from './ui';
import { liveKey } from '../lib/live';
import type { Shown } from './PageView';
import { defaultFieldRect, isFieldTool } from './FormTools';
import { newField } from '../lib/forms';
import { placeSignatureBox } from '../lib/certflow';

const { get, set } = actions;

const CAPTURE: Tool[] = ['editText', 'text', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'note', 'whiteout', 'redact', 'certSign', ...(Object.keys(FIELD_TOOLS) as FieldTool[])];

type Draft =
  | { kind: 'box'; tool: 'rect' | 'ellipse' | 'whiteout' | 'redact' | 'certSign' | FieldTool; r: Rect }
  | { kind: 'line'; tool: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'ink'; pts: number[] };

type Editable = { kind: 'para'; p: Paragraph } | { kind: 'img'; img: PageImage };

/** Original text of paragraphs opened in Edit mode, by object id. */
const converted = new Map<string, string>();
/** Caret offset to place when an editor opens, by object id. */
const pendingCaret = new Map<string, number>();

/** A double-click on page text in Select mode asks the page to open that paragraph. */
let editRequest: { page: string; pt: Point } | null = null;
const editListeners = new Set<() => void>();

export function requestEditAt(page: string, pt: Point) {
  editRequest = { page, pt };
  editListeners.forEach((l) => l());
}

interface Props {
  page: PageItem;
  zoom: number;
  objects: Obj[];
  pdfPage: PDFPageProxy | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  shown: Shown;
  holes: ReadonlySet<string>;
  liveFailed: boolean;
  canvasVersion: number;
}

export function Overlay({ page, zoom, objects, pdfPage, canvasRef, shown, holes, liveFailed, canvasVersion }: Props) {
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const editing = useStore((s) => s.editing);
  const openNote = useStore((s) => s.openNote);
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hover, setHover] = useState<Editable | null>(null);
  const [menu, setMenu] = useState<{ at: Point; id: string } | null>(null);
  const editMode = tool === 'editText';
  const editables = useEditables(page, pdfPage, editMode);
  const capture = CAPTURE.includes(tool);

  useEffect(() => {
    if (!editMode) setHover(null);
  }, [editMode]);

  /** Original content already replaced by an object is no longer offered for editing. */
  const taken = useMemo(() => {
    const areas: Rect[] = [];
    for (const o of objects) {
      if ((o.type === 'text' || o.type === 'image') && o.cover) areas.push(o.cover);
      if (o.type === 'whiteout' && o.erase) areas.push(o);
    }
    return areas;
  }, [objects]);

  const free = useMemo(() => {
    const isTaken = (r: Rect) => taken.some((t) => rectsIntersect(t, r) && overlapRatio(r, t) > 0.6);
    return {
      paragraphs: editables.paragraphs.filter((p) => !isTaken(p)),
      images: editables.images.filter((i) => !isTaken(i.visible)),
    };
  }, [editables, taken]);

  /**
   * Edits of the page's own content are visible in the canvas once a live render
   * with them has been drawn. Covers are only painted where the content could
   * not be changed (or live rendering failed); while a render is pending the
   * original simply stays visible for a moment.
   */
  const inCanvas = (o: Obj) => {
    const k = liveKey(o, holes);
    return k !== null && shown.keys.get(o.id) === k;
  };
  const seamless = (o: Obj) => inCanvas(o) && shown.native.has(o.id);
  const needsCover = (o: Obj) => liveFailed || (inCanvas(o) && !shown.native.has(o.id));

  /* Previews of background-matched redactions, sampled from the rendered page. */
  const matchKey = objects
    .filter((o) => o.type === 'redact' && o.match)
    .map((o) => (o.type === 'redact' ? `${o.id}:${o.x},${o.y},${o.w},${o.h}` : ''))
    .join('|');
  const patches = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const o of objects) if (o.type === 'redact' && o.match) m.set(o.id, matchingPatch(canvasRef.current, page, zoom, o));
    return m;
    // Recompute when the boxes change or the page is redrawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, canvasVersion]);

  const toPage = (e: { clientX: number; clientY: number }) => clientToPage(root.current!, page, zoom, e.clientX, e.clientY);

  const hitEditable = (pt: Point): Editable | null => {
    const p = free.paragraphs.find((x) => pointInRect(pt, x, 1.5));
    if (p) return { kind: 'para', p };
    // Topmost image wins.
    for (let i = free.images.length - 1; i >= 0; i--) if (pointInRect(pt, free.images[i].visible)) return { kind: 'img', img: free.images[i] };
    return null;
  };

  /** Runs a pointer drag with window-level listeners. */
  const drag = (onMove: (p: Point, e: PointerEvent) => void, onUp: (p: Point, e: PointerEvent) => void) => {
    const move = (e: PointerEvent) => onMove(toPage(e), e);
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp(toPage(e), e);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /* ---------------------------- selection ---------------------------- */

  const startMove = (obj: Obj, e: React.PointerEvent, start: Point, editOnClick = false) => {
    const st = get();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const has = st.selection.includes(obj.id);
      set({ selection: has ? st.selection.filter((x) => x !== obj.id) : [...st.selection, obj.id], editing: null, openNote: null });
      return;
    }
    const wasSelected = st.selection.includes(obj.id);
    const sel = wasSelected ? st.selection : [obj.id];
    if (!wasSelected) set({ selection: sel, editing: null, openNote: st.openNote === obj.id ? obj.id : null });
    const originals = new Map(st.objects.filter((o) => sel.includes(o.id)).map((o) => [o.id, o]));
    const lifted = [...originals.values()].filter((o) => o.type === 'image' && o.orig).map((o) => o.id);
    let moved = false;
    beginGesture();
    drag(
      (p) => {
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        if (!moved && Math.hypot(dx, dy) * zoom < 3) return;
        if (!moved) lifted.forEach((id) => setHole(id, true));
        moved = true;
        updateObjectsTransient(sel, (o) => moveObj(originals.get(o.id)!, dx, dy));
      },
      (p) => {
        lifted.forEach((id) => setHole(id, false));
        endGesture();
        if (moved) return;
        if (obj.type === 'text' && sel.length === 1 && (wasSelected || editOnClick)) {
          pendingCaret.set(obj.id, offsetAt(obj, p.x - obj.x, p.y - obj.y));
          set({ editing: obj.id });
        } else if (obj.type === 'note') set({ openNote: obj.id });
      },
    );
  };

  const startResize = (handle: string, obj: Obj) => {
    const b0 = objBounds(obj, measureText);
    const keepRatio = obj.type === 'image' || obj.type === 'text';
    const lifted = obj.type === 'image' && !!obj.orig;
    if (lifted) setHole(obj.id, true);
    beginGesture();
    drag(
      (p, e) => {
        if (obj.type === 'line' || obj.type === 'arrow') {
          const [ax, ay] = handle === 'p1' ? [obj.x2, obj.y2] : [obj.x1, obj.y1];
          const q = e.shiftKey ? snapAngle({ x: ax, y: ay }, p) : p;
          updateObjectsTransient([obj.id], handle === 'p1' ? { x1: q.x, y1: q.y } : { x2: q.x, y2: q.y });
          return;
        }
        if (obj.type === 'text' && (handle === 'e' || handle === 'w')) {
          // Side handles set the wrap width; the text reflows.
          const right = b0.x + b0.w;
          const left = handle === 'w' ? Math.min(p.x, right - obj.size * 2) : b0.x;
          const w = handle === 'w' ? right - left : Math.max(obj.size * 2, p.x - b0.x);
          updateObjectsTransient([obj.id], { x: left, width: Math.max(obj.size, w - TEXT_PAD * 2) } as Partial<Obj>);
          return;
        }
        let x1 = b0.x;
        let y1 = b0.y;
        let x2 = b0.x + b0.w;
        let y2 = b0.y + b0.h;
        if (handle.includes('w')) x1 = p.x;
        if (handle.includes('e')) x2 = p.x;
        if (handle.includes('n')) y1 = p.y;
        if (handle.includes('s')) y2 = p.y;
        if ((keepRatio || e.shiftKey) && handle.length === 2 && b0.h > 0) {
          const ratio = b0.w / b0.h;
          let w = Math.abs(x2 - x1);
          let h = Math.abs(y2 - y1);
          if (w / h > ratio) w = h * ratio;
          else h = w / ratio;
          if (handle.includes('w')) x1 = x2 - w;
          else x2 = x1 + w;
          if (handle.includes('n')) y1 = y2 - h;
          else y2 = y1 + h;
        }
        const r = rectFromPoints({ x: x1, y: y1 }, { x: x2, y: y2 });
        if (r.w < 3 || r.h < 3) return;
        updateObjectsTransient([obj.id], resizeObj(obj, b0, r));
      },
      () => {
        if (lifted) setHole(obj.id, false);
        endGesture();
      },
    );
  };

  /* ----------------------------- creation ---------------------------- */

  const style = () => get().style;

  const base = () => ({ id: uid(), page: page.id, created: Date.now(), opacity: 1, author: get().userName });

  const createText = (at: Point) => {
    const s = style();
    const o: TextObj = {
      ...base(),
      type: 'text',
      x: at.x - TEXT_PAD,
      y: at.y - (s.size * LINE_HEIGHT) / 2 - TEXT_PAD,
      text: '',
      font: s.font,
      size: s.size,
      bold: s.bold,
      italic: s.italic,
      color: s.textColor,
    };
    beginGesture();
    transient((st) => ({ objects: [...st.objects, o] }));
    set({ selection: [o.id], editing: o.id });
    toolDone();
  };

  /** Turns a paragraph of page text into an editable text box over the original. */
  const paragraphObject = (para: Paragraph): TextObj => {
    const first = para.lines[0];
    const f = pdfPage ? lineFont(pdfPage, first) : { font: 'sans' as const, bold: false, italic: false };
    const size = Math.round(para.size * 10) / 10;
    const pad = Math.max(0.6, size * 0.08);
    const cover = { x: para.x - pad, y: para.y - pad, w: para.w + pad * 2, h: para.h + pad * 2 };
    const colors = sampleColors(canvasRef.current, page, zoom, cover);
    const multi = para.lines.length > 1;
    const lineHeight = multi ? Math.round(Math.min(2.2, Math.max(0.9, para.lineHeight)) * 1000) / 1000 : LINE_HEIGHT;
    // Squeeze or stretch the substitute font so lines keep their original length.
    const style = { font: f.font, size, bold: f.bold, italic: f.italic };
    const natural = para.lines.reduce((t, l) => t + textWidth(style, l.text), 0);
    const actual = para.lines.reduce((t, l) => t + l.w, 0);
    let hscale = natural > 0 ? actual / natural : 1;
    hscale = Math.abs(hscale - 1) < 0.03 ? 1 : Math.round(Math.min(1.25, Math.max(0.75, hscale)) * 1000) / 1000;
    return {
      ...base(),
      type: 'text',
      x: para.x - TEXT_PAD,
      y: para.baseline - firstBaseline(f.font, size, lineHeight),
      text: multi ? para.text : first.text,
      ...style,
      color: colors.fg,
      lineHeight,
      hscale: hscale === 1 ? undefined : hscale,
      // Multi-line paragraphs reflow inside their original column.
      width: multi ? para.w + size * 0.6 : undefined,
      cover: { ...cover, color: colors.bg },
    };
  };

  /** Lifts an image off the page into a movable object (the original is moved on save). */
  const imageObject = (img: PageImage): ImageObj | null => {
    if (!pdfPage) return null;
    const src = imagePixels(pdfPage, img);
    if (!src) return null;
    const r = img.rect;
    const v = img.visible;
    const ring = { x: v.x - 2, y: v.y - 2, w: v.w + 4, h: v.h + 4 };
    const colors = sampleColors(canvasRef.current, page, zoom, ring);
    const cropped = v.w < r.w - 0.5 || v.h < r.h - 0.5;
    const crop = cropped ? { l: (v.x - r.x) / r.w, t: (v.y - r.y) / r.h, r: (v.x + v.w - r.x) / r.w, b: (v.y + v.h - r.y) / r.h } : undefined;
    return { ...base(), type: 'image', ...r, src, orig: { ...r }, crop, cover: { ...v, color: colors.bg } };
  };

  /** Edit mode: press on a paragraph or image. Click edits/selects, drag moves. */
  const startEditable = (target: Editable, start: Point) => {
    let created: Obj | null = null;
    let moved = false;
    beginGesture();
    const make = () => {
      if (created) return created;
      created = target.kind === 'para' ? paragraphObject(target.p) : imageObject(target.img);
      if (created) {
        const o = created;
        if (o.type === 'text') converted.set(o.id, o.text);
        transient((st) => ({ objects: [...st.objects, o] }));
        set({ selection: [o.id], editing: null });
        setHover(null);
      }
      return created;
    };
    drag(
      (p) => {
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        if (!moved && Math.hypot(dx, dy) * zoom < 3) return;
        moved = true;
        const o = make();
        if (!o) return;
        if (o.type === 'image') setHole(o.id, true);
        const orig = o;
        updateObjectsTransient([o.id], () => moveObj(orig, dx, dy));
      },
      (p) => {
        const o = make();
        if (o?.type === 'image') setHole(o.id, false);
        if (!o) {
          endGesture();
          return;
        }
        if (o.type === 'text' && !moved) {
          // Keep the gesture open: the editor ends it when typing is done.
          pendingCaret.set(o.id, offsetAt(o, p.x - o.x, p.y - o.y));
          set({ editing: o.id });
          return;
        }
        if (o.type === 'text') converted.delete(o.id);
        endGesture();
      },
    );
  };

  const startDraw = (t: Tool, start: Point) => {
    const s = style();
    if (t === 'ink') {
      const pts = [start.x, start.y];
      setDraft({ kind: 'ink', pts: [...pts] });
      drag(
        (p) => {
          const lx = pts[pts.length - 2];
          const ly = pts[pts.length - 1];
          if (Math.hypot(p.x - lx, p.y - ly) * zoom < 1.5) return;
          pts.push(p.x, p.y);
          setDraft({ kind: 'ink', pts: [...pts] });
        },
        () => {
          setDraft(null);
          const o: InkObj = { ...base(), type: 'ink', strokes: [pts], stroke: s.inkColor, width: s.inkWidth, opacity: s.opacity };
          commitObject(o, false);
        },
      );
      return;
    }
    if (t === 'line' || t === 'arrow') {
      let cur = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
      setDraft({ kind: 'line', tool: t, ...cur });
      drag(
        (p, e) => {
          const q = e.shiftKey ? snapAngle(start, p) : p;
          cur = { ...cur, x2: q.x, y2: q.y };
          setDraft({ kind: 'line', tool: t, ...cur });
        },
        () => {
          setDraft(null);
          if (Math.hypot(cur.x2 - cur.x1, cur.y2 - cur.y1) < 3) cur = { ...cur, x2: cur.x1 + 120, y2: cur.y1 };
          commitObject({ ...base(), type: t, ...cur, stroke: s.stroke, width: s.width, opacity: s.opacity });
        },
      );
      return;
    }
    if (t === 'certSign') {
      let r: Rect = { x: start.x, y: start.y, w: 0, h: 0 };
      setDraft({ kind: 'box', tool: t, r });
      drag(
        (p) => {
          r = rectFromPoints(start, p);
          setDraft({ kind: 'box', tool: t, r });
        },
        () => {
          setDraft(null);
          if (r.w < 24 || r.h < 12) r = { x: start.x - 90, y: start.y - 25, w: 180, h: 50 };
          placeSignatureBox(page, r);
        },
      );
      return;
    }
    if (isFieldTool(t)) {
      const kind = FIELD_TOOLS[t];
      let r: Rect = { x: start.x, y: start.y, w: 0, h: 0 };
      setDraft({ kind: 'box', tool: t, r });
      drag(
        (p, e) => {
          let q = p;
          if (e.shiftKey || kind === 'checkbox' || kind === 'radio') {
            const d = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
            q = { x: start.x + Math.sign(p.x - start.x || 1) * d, y: start.y + Math.sign(p.y - start.y || 1) * d };
          }
          r = rectFromPoints(start, q);
          setDraft({ kind: 'box', tool: t, r });
        },
        () => {
          setDraft(null);
          const o = newField(kind, page, r.w < 6 || r.h < 6 ? defaultFieldRect(kind, start) : r);
          if (r.w < 6 || r.h < 6) {
            // A click places the usual size, centered there (radio buttons match their group).
            o.x = start.x - o.w / 2;
            o.y = start.y - o.h / 2;
          }
          commit((st) => ({ objects: [...st.objects, o] }));
          set({ selection: [o.id] });
          // Radio buttons usually come several at a time; the tool stays on for them.
          if (kind !== 'radio') set({ tool: 'select' });
        },
      );
      return;
    }
    if (t === 'rect' || t === 'ellipse' || t === 'whiteout' || t === 'redact') {
      let r: Rect = { x: start.x, y: start.y, w: 0, h: 0 };
      setDraft({ kind: 'box', tool: t, r });
      drag(
        (p, e) => {
          let q = p;
          if (e.shiftKey) {
            const d = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
            q = { x: start.x + Math.sign(p.x - start.x || 1) * d, y: start.y + Math.sign(p.y - start.y || 1) * d };
          }
          r = rectFromPoints(start, q);
          setDraft({ kind: 'box', tool: t, r });
        },
        () => {
          setDraft(null);
          if (r.w < 3 || r.h < 3) {
            if (t === 'whiteout' || t === 'redact') return;
            r = { x: start.x - 60, y: start.y - 40, w: 120, h: 80 };
          }
          if (t === 'whiteout') commitObject({ ...base(), type: 'whiteout', ...r, color: '#ffffff' }, false);
          else if (t === 'redact') {
            const match = s.redactMatch;
            const color = match ? sampleColors(canvasRef.current, page, zoom, r).bg : s.redactColor;
            commitObject({ ...base(), type: 'redact', ...r, color, match: match || undefined }, false);
          }
          else commitObject({ ...base(), type: t, ...r, stroke: s.stroke, fill: s.fill, width: s.width, opacity: s.opacity });
        },
      );
    }
  };

  const commitObject = (o: Obj, select = true) => {
    commit((st) => ({ objects: [...st.objects, o] }));
    if (select) set({ selection: [o.id] });
    toolDone();
  };

  /* Double-click on page text in Select mode lands here once editables load. */
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    editListeners.add(l);
    return () => {
      editListeners.delete(l);
    };
  }, []);
  useEffect(() => {
    const req = editRequest;
    if (!req || req.page !== page.id || !editMode || !editables.ready) return;
    editRequest = null;
    const hit = free.paragraphs.find((x) => pointInRect(req.pt, x, 2));
    if (!hit) return;
    const o = paragraphObject(hit);
    converted.set(o.id, o.text);
    beginGesture();
    transient((st) => ({ objects: [...st.objects, o] }));
    pendingCaret.set(o.id, offsetAt(o, req.pt.x - o.x, req.pt.y - o.y));
    set({ selection: [o.id], editing: o.id });
  });

  /* ----------------------------- events ------------------------------ */

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !root.current) return;
    const target = e.target as Element;
    if (target.closest('.tobj-edit, .note-popup')) return;
    const pt = toPage(e);
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
    const id = target.closest<HTMLElement | SVGElement>('[data-id]')?.getAttribute('data-id');
    const obj = id ? objects.find((o) => o.id === id) : undefined;
    const sel = get().selection;

    if (handle && sel.length === 1) {
      const o = objects.find((x) => x.id === sel[0]);
      if (o) {
        e.preventDefault();
        e.stopPropagation();
        startResize(handle, o);
      }
      return;
    }

    if (!capture) {
      if (obj) {
        e.preventDefault();
        e.stopPropagation();
        window.getSelection()?.removeAllRanges();
        startMove(obj, e, pt);
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (get().editing) set({ editing: null });

    switch (tool) {
      case 'editText': {
        if (obj) {
          startMove(obj, e, pt, true);
          return;
        }
        const hit = hitEditable(pt);
        if (hit) startEditable(hit, pt);
        else set({ selection: [], openNote: null });
        return;
      }
      case 'text':
        if (obj?.type === 'text') {
          pendingCaret.set(obj.id, offsetAt(obj, pt.x - obj.x, pt.y - obj.y));
          set({ selection: [obj.id], editing: obj.id });
          return;
        }
        createText(pt);
        return;
      case 'note': {
        const s = style();
        const o: Obj = { ...base(), type: 'note', x: pt.x - NOTE_SIZE / 2, y: pt.y - NOTE_SIZE / 2, color: s.noteColor, comment: '' };
        commitObject(o);
        set({ openNote: o.id });
        return;
      }
      default:
        set({ selection: [], openNote: null });
        startDraw(tool, pt);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!editMode || e.buttons) return;
    const target = e.target as Element;
    if (target.closest('[data-id], [data-handle]')) {
      if (hover) setHover(null);
      return;
    }
    const next = hitEditable(toPage(e));
    const same = next && hover && (next.kind === 'para' ? hover.kind === 'para' && hover.p === next.p : hover.kind === 'img' && hover.img === next.img);
    if (!same && (next || hover)) setHover(next);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const id = (e.target as Element).closest('[data-id]')?.getAttribute('data-id');
    const obj = id ? objects.find((o) => o.id === id) : undefined;
    if (!obj) return;
    e.stopPropagation();
    if (obj.type === 'text') set({ selection: [obj.id], editing: obj.id });
    else if (obj.type === 'field') set({ selection: [obj.id], dialog: { kind: 'field', id: obj.id } });
    else set({ selection: [obj.id], openNote: obj.id });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const id = (e.target as Element).closest('[data-id]')?.getAttribute('data-id');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (!get().selection.includes(id)) set({ selection: [id], editing: null });
    setMenu({ at: { x: e.clientX, y: e.clientY }, id });
  };

  const menuItems: MenuItem[] = menu
    ? [
        { label: 'Add comment', icon: <MessageSquarePlus size={15} />, onClick: () => set({ openNote: menu.id }) },
        { label: 'Duplicate', icon: <Copy size={15} />, shortcut: 'Ctrl+D', onClick: () => duplicateObjects(get().selection) },
        { separator: true },
        { label: 'Bring to front', icon: <ArrowUpToLine size={15} />, onClick: () => reorderObjects(get().selection, 'front') },
        { label: 'Send to back', icon: <ArrowDownToLine size={15} />, onClick: () => reorderObjects(get().selection, 'back') },
        { separator: true },
        { label: 'Delete', icon: <Trash2 size={15} />, shortcut: 'Del', danger: true, onClick: () => deleteObjects(get().selection) },
      ]
    : [];

  /* ----------------------------- render ------------------------------ */

  const view = page.rotation % 180 ? `0 0 ${page.h} ${page.w}` : `0 0 ${page.w} ${page.h}`;
  const tx = svgTransform(page);
  const htmlStyle = { transform: cssTransform(page, zoom), width: page.w * zoom, height: page.h * zoom };
  const selected = objects.filter((o) => selection.includes(o.id));
  const texts = objects.filter((o): o is TextObj => o.type === 'text');
  const hoverRect = hover ? (hover.kind === 'para' ? hover.p : hover.img.visible) : null;
  const cursor = editMode ? (hover?.kind === 'img' ? 'move' : hover?.kind === 'para' ? 'text' : 'default') : undefined;

  return (
    <div
      ref={root}
      className={`overlay ${capture ? 'capture' : ''} tool-${tool}`}
      style={cursor ? { cursor } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => hover && setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <svg className="ov-svg" viewBox={view} preserveAspectRatio="none">
        <g transform={tx}>
          {objects.map((o) => (o.type === 'whiteout' && (!o.erase || needsCover(o)) ? <BaseShape key={o.id} o={o} /> : null))}
          {objects.map((o) => (needsCover(o) ? <CoverShape key={o.id} o={o} /> : null))}
          {objects.map((o) =>
            o.type === 'whiteout' ? null : o.type === 'image' && o.orig && seamless(o) ? (
              // Drawn by the canvas now; keep an invisible copy to click and drag.
              <BaseShape key={o.id} o={{ ...o, opacity: 0.001 }} />
            ) : (
              <BaseShape key={o.id} o={o} />
            ),
          )}
        </g>
      </svg>
      <div className="ov-html" style={htmlStyle}>
        {texts.map((o) => (o.id === editing ? <TextEditor key={o.id} o={o} zoom={zoom} /> : <TextView key={o.id} o={o} zoom={zoom} />))}
      </div>
      <svg className="ov-svg blend" viewBox={view} preserveAspectRatio="none">
        <g transform={tx}>
          {objects.map((o) => (
            <HighlightShape key={o.id} o={o} />
          ))}
        </g>
      </svg>
      <svg className="ov-svg" viewBox={view} preserveAspectRatio="none">
        <g transform={tx}>
          {objects.map((o) => (
            <TopShape key={o.id} o={o} patch={patches.get(o.id)} />
          ))}
          {editMode &&
            free.paragraphs.map((p, i) => <rect key={`p${i}`} className="editable-box" x={p.x - 1.5} y={p.y - 1.5} width={p.w + 3} height={p.h + 3} rx={1.5} />)}
          {editMode &&
            free.images.map((m, i) => <rect key={`i${i}`} className="editable-box img" x={m.visible.x} y={m.visible.y} width={m.visible.w} height={m.visible.h} />)}
          {hoverRect && <rect className="hover-line" x={hoverRect.x - 1.5} y={hoverRect.y - 1.5} width={hoverRect.w + 3} height={hoverRect.h + 3} rx={1.5} />}
          {draft && <DraftShape d={draft} />}
        </g>
      </svg>
      <div className="ov-html ov-ui" style={htmlStyle}>
        {objects.map((o) => (o.type === 'note' ? <NoteView key={o.id} o={o} zoom={zoom} active={openNote === o.id} /> : null))}
        {selected.map((o) => (o.id === editing ? null : <SelectionFrame key={o.id} o={o} zoom={zoom} handles={selected.length === 1} />))}
      </div>
      <ContextMenu at={menu?.at ?? null} items={menuItems} onClose={() => setMenu(null)} />
    </div>
  );
}

function overlapRatio(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1, a.w * a.h) : 0;
}

function snapAngle(a: Point, p: Point): Point {
  const dx = p.x - a.x;
  const dy = p.y - a.y;
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

/** Paragraphs and images of the page that Edit mode can change. */
function useEditables(page: PageItem, pdfPage: PDFPageProxy | null, enabled: boolean) {
  const docs = useStore((s) => s.docs);
  const [state, setState] = useState<{ paragraphs: Paragraph[]; images: PageImage[]; ready: boolean }>({ paragraphs: [], images: [], ready: false });
  const m = page.m;
  useEffect(() => {
    if (!enabled || !pdfPage) return;
    const doc = docs[page.src];
    if (!doc) return;
    let alive = true;
    Promise.all([getText(doc, page.index), findImages(pdfPage, page).catch(() => [])]).then(([tc, images]) => {
      if (alive) setState({ paragraphs: buildParagraphs(buildLines(tc, page)), images, ready: true });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pdfPage, page.src, page.index, m, docs]);
  return state;
}

function DraftShape({ d }: { d: Draft }) {
  const s = useStore((st) => st.style);
  if (d.kind === 'ink') return <path d={inkPath(d.pts)} fill="none" stroke={s.inkColor} strokeWidth={s.inkWidth} strokeLinecap="round" strokeLinejoin="round" opacity={s.opacity} />;
  if (d.kind === 'line') {
    return <line x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} stroke={s.stroke} strokeWidth={s.width} strokeLinecap="round" opacity={0.8} />;
  }
  const { r } = d;
  if (isFieldTool(d.tool) || d.tool === 'certSign') return <rect x={r.x} y={r.y} width={r.w} height={r.h} className="draft-field" />;
  if (d.tool === 'whiteout') return <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#fff" className="draft-outline" />;
  if (d.tool === 'redact') return <rect x={r.x} y={r.y} width={r.w} height={r.h} className="redact-box" />;
  const props = { fill: s.fill ?? 'none', stroke: s.stroke, strokeWidth: s.width, opacity: 0.85 };
  return d.tool === 'rect' ? <rect x={r.x} y={r.y} width={r.w} height={r.h} {...props} /> : <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} {...props} />;
}

const BOX_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNER_HANDLES = ['nw', 'ne', 'se', 'sw'];
const TEXT_HANDLES = ['nw', 'ne', 'e', 'se', 'sw', 'w'];

function SelectionFrame({ o, zoom, handles }: { o: Obj; zoom: number; handles: boolean }) {
  if ((o.type === 'line' || o.type === 'arrow') && handles) {
    return (
      <>
        <div className="sel-line-handle" data-handle="p1" style={{ left: o.x1 * zoom, top: o.y1 * zoom }} />
        <div className="sel-line-handle" data-handle="p2" style={{ left: o.x2 * zoom, top: o.y2 * zoom }} />
      </>
    );
  }
  const b = o.type === 'highlight' || o.type === 'underline' || o.type === 'strike' ? unionRects(o.rects) : objBounds(o, measureText);
  const list = !handles
    ? []
    : o.type === 'text'
      ? o.rotate
        ? []
        : TEXT_HANDLES
      : o.type === 'image'
        ? CORNER_HANDLES
        : o.type === 'note' || o.type === 'highlight' || o.type === 'underline' || o.type === 'strike'
          ? []
          : BOX_HANDLES;
  return (
    <div
      className="sel-frame"
      style={{
        left: b.x * zoom,
        top: b.y * zoom,
        width: b.w * zoom,
        height: b.h * zoom,
        transform: o.type === 'text' && o.rotate ? `rotate(${o.rotate}deg)` : undefined,
      }}
    >
      {list.map((h) => (
        <div key={h} className={`sel-handle h-${h}`} data-handle={h} />
      ))}
    </div>
  );
}

function TextEditor({ o, zoom }: { o: TextObj; zoom: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = o.id;
  useEffect(() => {
    if (!get().gestureBase) beginGesture();
    const el = ref.current;
    if (el) {
      el.focus({ preventScroll: true });
      const at = pendingCaret.get(id) ?? el.value.length;
      pendingCaret.delete(id);
      el.setSelectionRange(at, at);
    }
    return () => finishEditing(id);
  }, [id]);
  const st = useMemo(() => ({ ...textStyle(o, zoom), whiteSpace: o.width ? ('pre-wrap' as const) : ('pre' as const) }), [o, zoom]);
  return (
    <textarea
      ref={ref}
      className="tobj tobj-edit"
      style={st}
      value={o.text}
      spellCheck
      wrap={o.width ? 'soft' : 'off'}
      onChange={(e) => updateObjectsTransient([id], { text: e.target.value })}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          set({ editing: null });
        }
      }}
      onBlur={() => {
        if (get().editing === id) set({ editing: null });
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

function finishEditing(id: string) {
  const s = get();
  const o = s.objects.find((x) => x.id === id);
  const original = converted.get(id);
  converted.delete(id);
  if (o && o.type === 'text') {
    if (original !== undefined && o.text === original) {
      // Opened in Edit mode but left unchanged: drop it and keep the original.
      transient((st) => ({ objects: st.objects.filter((x) => x.id !== id) }));
      set({ selection: s.selection.filter((x) => x !== id) });
    } else if (!o.text.trim()) {
      if (o.cover) {
        // All of an original paragraph deleted: erase it from the page.
        const c = o.cover;
        transient((st) => ({
          objects: st.objects.map((x) =>
            x.id === id
              ? { id, page: o.page, created: Date.now(), author: o.author, opacity: 1, type: 'whiteout' as const, x: c.x, y: c.y, w: c.w, h: c.h, color: c.color, erase: 'text' as const }
              : x,
          ),
        }));
      } else transient((st) => ({ objects: st.objects.filter((x) => x.id !== id) }));
      set({ selection: s.selection.filter((x) => x !== id) });
    }
  }
  endGesture();
}
