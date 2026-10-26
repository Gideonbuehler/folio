import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Bold,
  Circle,
  Copy,
  Eraser,
  EyeOff,
  Hand,
  Highlighter,
  ImagePlus,
  Italic,
  MessageSquarePlus,
  Minus,
  MousePointer2,
  PenLine,
  Signature,
  Square,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  ChevronDown,
  Droplets,
} from 'lucide-react';
import type { FontFamily, Obj, Tool, ToolStyle } from '../types';
import { actions, deleteObjects, duplicateObjects, setStyle, setTool, updateObjects, useStore } from '../store';
import { FONT_LABEL, useFontsVersion } from '../lib/fonts';
import { activeDocFont } from '../lib/fontdb';
import { pickAndInsertImage } from '../lib/commands';
import { ColorButton, HIGHLIGHT_PALETTE, IconButton, Popover, Segmented, SliderButton, usePopover } from './ui';
import { backgroundColorAt } from '../lib/sample';
import { FIELD_LABEL, OBJ_LABEL } from './labels';
import { FieldOptions, FieldsButton, isFieldTool } from './FormTools';

interface ToolDef {
  id: Tool;
  label: string;
  key?: string;
  icon: ReactNode;
}

const S = 18;

const SHAPES: ToolDef[] = [
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <Square size={S} /> },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: <Circle size={S} /> },
  { id: 'line', label: 'Line', key: 'L', icon: <Minus size={S} style={{ transform: 'rotate(-45deg)' }} /> },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: <ArrowUpRight size={S} /> },
];

const GROUPS: (ToolDef | 'shapes' | 'insert' | 'fields')[][] = [
  [
    { id: 'select', label: 'Select', key: 'V', icon: <MousePointer2 size={S} /> },
    { id: 'hand', label: 'Hand', key: 'H', icon: <Hand size={S} /> },
  ],
  [
    { id: 'editText', label: 'Edit text & images', key: 'E', icon: <TextCursorInput size={S} /> },
    { id: 'text', label: 'Add text', key: 'T', icon: <Type size={S} /> },
  ],
  [
    { id: 'highlight', label: 'Highlight', key: 'U', icon: <Highlighter size={S} /> },
    { id: 'underline', label: 'Underline', icon: <Underline size={S} /> },
    { id: 'strike', label: 'Strikethrough', icon: <Strikethrough size={S} /> },
    { id: 'note', label: 'Sticky note', key: 'N', icon: <MessageSquarePlus size={S} /> },
  ],
  [{ id: 'ink', label: 'Draw', key: 'D', icon: <PenLine size={S} /> }, 'shapes'],
  ['insert', 'fields'],
  [
    { id: 'whiteout', label: 'Whiteout', key: 'W', icon: <Eraser size={S} /> },
    { id: 'redact', label: 'Redact', key: 'X', icon: <EyeOff size={S} /> },
  ],
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      <div className="tool-groups">
        {GROUPS.map((g, gi) => (
          <div key={gi} className="tool-group">
            {g.map((t, ti) =>
              t === 'shapes' ? (
                <ShapesButton key="shapes" />
              ) : t === 'insert' ? (
                <InsertButtons key="insert" />
              ) : t === 'fields' ? (
                <FieldsButton key="fields" />
              ) : t.id === 'editText' ? (
                <button
                  key={ti}
                  type="button"
                  className={`tool-pill ${tool === t.id ? 'active' : ''}`}
                  data-tip={`${t.label}  ·  ${t.key}`}
                  aria-pressed={tool === t.id}
                  onClick={() => setTool(tool === t.id ? 'select' : t.id)}
                >
                  {t.icon}
                  <span>Edit</span>
                </button>
              ) : (
                <IconButton key={ti} tip={t.label} shortcut={t.key} active={tool === t.id} onClick={() => setTool(t.id)}>
                  {t.icon}
                </IconButton>
              ),
            )}
          </div>
        ))}
      </div>
      <ContextOptions />
    </div>
  );
}

function ShapesButton() {
  const tool = useStore((s) => s.tool);
  const [last, setLast] = useState<ToolDef>(SHAPES[0]);
  const p = usePopover();
  useEffect(() => {
    const t = SHAPES.find((x) => x.id === tool);
    if (t) setLast(t);
  }, [tool]);
  const active = SHAPES.some((x) => x.id === tool);
  return (
    <div className={`split-btn ${active ? 'active' : ''}`}>
      <IconButton tip={last.label} shortcut={last.key} active={active} onClick={() => setTool(last.id)}>
        {last.icon}
      </IconButton>
      <button ref={p.anchor} type="button" className="split-caret" aria-label="More shapes" onClick={p.toggle}>
        <ChevronDown size={12} />
      </button>
      <Popover anchor={p.anchor} open={p.open} onClose={p.close}>
        <div className="menu">
          {SHAPES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="menu-item"
              onClick={() => {
                setTool(s.id);
                p.close();
              }}
            >
              <span className="menu-icon">{s.icon}</span>
              <span className="menu-label">{s.label}</span>
              <span className="menu-shortcut">{s.key}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function InsertButtons() {
  return (
    <>
      <IconButton tip="Insert image" shortcut="I" onClick={() => void pickAndInsertImage()}>
        <ImagePlus size={S} />
      </IconButton>
      <IconButton tip="Fill & sign" shortcut="S" onClick={() => actions.set({ dialog: { kind: 'signature' } })}>
        <Signature size={S} />
      </IconButton>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Contextual options: what the selection or the active tool can change */
/* ------------------------------------------------------------------ */

type Kind = 'shape' | 'line' | 'ink' | 'text' | 'markup' | 'note' | 'image' | 'whiteout' | 'redact' | 'field' | 'none';

function kindOf(t: Obj['type'] | Tool): Kind {
  if (t === 'field' || isFieldTool(t)) return 'field';
  switch (t) {
    case 'rect':
    case 'ellipse':
      return 'shape';
    case 'line':
    case 'arrow':
      return 'line';
    case 'ink':
      return 'ink';
    case 'text':
      return 'text';
    case 'highlight':
    case 'underline':
    case 'strike':
      return 'markup';
    case 'note':
      return 'note';
    case 'image':
      return 'image';
    case 'whiteout':
      return 'whiteout';
    case 'redact':
      return 'redact';
    default:
      return 'none';
  }
}

function ContextOptions() {
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const objects = useStore((s) => s.objects);
  const style = useStore((s) => s.style);
  useFontsVersion();
  const selected = objects.filter((o) => selection.includes(o.id));
  const subject = selected[0];
  const kind: Kind = subject ? kindOf(subject.type) : kindOf(tool);
  const same = selected.filter((o) => kindOf(o.type) === kind);

  /** Applies to the selection (if any) and remembers it for the next object. */
  const apply = (objPatch: Partial<Obj> | ((o: Obj) => Partial<Obj>), stylePatch: Partial<ToolStyle>) => {
    if (same.length) updateObjects(same.map((o) => o.id), objPatch);
    setStyle(stylePatch);
  };

  const markupKey = (subject && (subject.type === 'highlight' || subject.type === 'underline' || subject.type === 'strike') ? subject.type : tool) as
    | 'highlight'
    | 'underline'
    | 'strike';

  let controls: ReactNode = null;
  const opacity = (value: number) => (
    <SliderButton
      tip="Opacity"
      label="Opacity"
      icon={<Droplets size={15} />}
      value={Math.round(value * 100)}
      min={10}
      max={100}
      step={5}
      format={(v) => `${v}%`}
      onChange={(v) => apply({ opacity: v / 100 }, { opacity: v / 100 })}
    />
  );

  if (kind === 'shape') {
    const o = subject as Extract<Obj, { type: 'rect' | 'ellipse' }> | undefined;
    controls = (
      <>
        <ColorButton tip="Border color" kind="stroke" allowNone value={o ? o.stroke : style.stroke} onChange={(c) => apply({ stroke: c } as Partial<Obj>, c ? { stroke: c } : {})} />
        <ColorButton tip="Fill color" allowNone value={o ? o.fill : style.fill} onChange={(c) => apply({ fill: c } as Partial<Obj>, { fill: c })} />
        <WidthButton value={o ? o.width : style.width} onChange={(v) => apply({ width: v } as Partial<Obj>, { width: v })} />
        {opacity(o ? o.opacity : style.opacity)}
      </>
    );
  } else if (kind === 'line') {
    const o = subject as Extract<Obj, { type: 'line' | 'arrow' }> | undefined;
    controls = (
      <>
        <ColorButton tip="Color" kind="stroke" value={o ? o.stroke : style.stroke} onChange={(c) => c && apply({ stroke: c } as Partial<Obj>, { stroke: c })} />
        <WidthButton value={o ? o.width : style.width} onChange={(v) => apply({ width: v } as Partial<Obj>, { width: v })} />
        {opacity(o ? o.opacity : style.opacity)}
      </>
    );
  } else if (kind === 'ink') {
    const o = subject as Extract<Obj, { type: 'ink' }> | undefined;
    controls = (
      <>
        <ColorButton tip="Pen color" kind="stroke" value={o ? o.stroke : style.inkColor} onChange={(c) => c && apply({ stroke: c } as Partial<Obj>, { inkColor: c })} />
        <WidthButton value={o ? o.width : style.inkWidth} onChange={(v) => apply({ width: v } as Partial<Obj>, { inkWidth: v })} />
        {opacity(o ? o.opacity : style.opacity)}
      </>
    );
  } else if (kind === 'text') {
    const o = subject?.type === 'text' ? subject : undefined;
    const v = o ?? { font: style.font, size: style.size, bold: style.bold, italic: style.italic, color: style.textColor };
    // Text rewritten in Edit mode may be set in the PDF's own font.
    const docFont = o ? activeDocFont(o) : null;
    controls = (
      <>
        <select
          className="select"
          aria-label="Font"
          value={docFont ? docFont.id : v.font}
          onChange={(e) => {
            if (e.target.value === docFont?.id) return;
            const font = e.target.value as FontFamily;
            apply({ font, embedded: undefined } as Partial<Obj>, { font });
          }}
        >
          {docFont && <option value={docFont.id}>{docFont.name} (from document)</option>}
          {(Object.keys(FONT_LABEL) as FontFamily[]).map((f) => (
            <option key={f} value={f}>
              {FONT_LABEL[f]}
            </option>
          ))}
        </select>
        <FontSize value={v.size} onChange={(n) => apply({ size: n } as Partial<Obj>, { size: n })} />
        <IconButton tip="Bold" shortcut="Ctrl+B" active={v.bold} onClick={() => apply({ bold: !v.bold } as Partial<Obj>, { bold: !v.bold })}>
          <Bold size={16} />
        </IconButton>
        <IconButton tip="Italic" shortcut="Ctrl+I" active={v.italic} onClick={() => apply({ italic: !v.italic } as Partial<Obj>, { italic: !v.italic })}>
          <Italic size={16} />
        </IconButton>
        <ColorButton tip="Text color" kind="text" value={v.color} onChange={(c) => c && apply({ color: c } as Partial<Obj>, { textColor: c })} />
        {o && opacity(o.opacity)}
      </>
    );
  } else if (kind === 'markup') {
    const o = subject as Extract<Obj, { type: 'highlight' | 'underline' | 'strike' }> | undefined;
    controls = (
      <>
        <ColorButton
          tip="Color"
          palette={markupKey === 'highlight' ? HIGHLIGHT_PALETTE : undefined}
          value={o ? o.color : style[markupKey]}
          onChange={(c) => c && apply({ color: c } as Partial<Obj>, { [markupKey]: c })}
        />
        {!subject && <span className="hint">Select text on the page to {OBJ_LABEL[markupKey].toLowerCase()} it</span>}
      </>
    );
  } else if (kind === 'note') {
    const o = subject as Extract<Obj, { type: 'note' }> | undefined;
    controls = (
      <>
        <ColorButton tip="Note color" palette={HIGHLIGHT_PALETTE} value={o ? o.color : style.noteColor} onChange={(c) => c && apply({ color: c } as Partial<Obj>, { noteColor: c })} />
        {!subject && <span className="hint">Click on the page to add a note</span>}
      </>
    );
  } else if (kind === 'image') {
    controls = opacity(subject?.opacity ?? 1);
  } else if (kind === 'whiteout') {
    const o = subject as Extract<Obj, { type: 'whiteout' | 'redact' }> | undefined;
    controls = o ? (
      <ColorButton tip="Cover color" value={o.color} onChange={(c) => c && updateObjects(same.map((x) => x.id), { color: c } as Partial<Obj>)} />
    ) : (
      <span className="hint">Drag to cover content with white</span>
    );
  } else if (kind === 'redact') {
    const o = subject?.type === 'redact' ? subject : undefined;
    const match = o ? !!o.match : style.redactMatch;
    const color = o && !o.match ? o.color : style.redactColor;
    const setMatch = (m: boolean) => {
      if (same.length) {
        updateObjects(
          same.map((x) => x.id),
          (x) => {
            if (x.type !== 'redact') return {};
            if (!m) return { match: undefined, color: style.redactColor };
            const pg = actions.get().pages.find((p) => p.id === x.page)!;
            return { match: true, color: backgroundColorAt(x.page, pg, actions.get().zoom, x) };
          },
        );
      }
      setStyle({ redactMatch: m });
    };
    controls = (
      <>
        <span className="context-hint-label">Fill</span>
        <Segmented
          value={match ? 'match' : 'color'}
          onChange={(v) => setMatch(v === 'match')}
          options={[
            { value: 'color', label: 'Color', tip: 'Fill redacted areas with a solid color' },
            { value: 'match', label: 'Match background', tip: 'Fill redacted areas with the surrounding background' },
          ]}
        />
        {!match && (
          <ColorButton
            tip="Redaction color"
            value={color}
            onChange={(c) => c && apply({ color: c, match: undefined } as Partial<Obj>, { redactColor: c })}
          />
        )}
        {!subject && <span className="hint">Content in marked areas is permanently removed when you save</span>}
      </>
    );
  }
  if (tool === 'certSign') {
    controls = <span className="hint">Drag a box where the signature should appear, or click for the usual size · Esc to cancel</span>;
  }
  if (kind === 'field') {
    controls = <FieldOptions selected={same.filter((o) => o.type === 'field')} tool={tool} />;
  }
  if (tool === 'editText' && !subject) {
    controls = <span className="hint">Click any text to rewrite it · drag an image to move it · Delete removes the selection</span>;
  }

  if (!controls && !selected.length) return <div className="context-options" />;

  return (
    <div className="context-options">
      {subject && (
        <span className="context-label">{selected.length > 1 ? `${selected.length} selected` : subject.type === 'field' ? FIELD_LABEL[subject.kind] : OBJ_LABEL[subject.type]}</span>
      )}
      {controls}
      {selected.length > 0 && (
        <>
          <span className="toolbar-sep" />
          <IconButton tip="Duplicate" shortcut="Ctrl+D" onClick={() => duplicateObjects(selection)}>
            <Copy size={16} />
          </IconButton>
          <IconButton tip="Delete" shortcut="Del" onClick={() => deleteObjects(selection)}>
            <Trash2 size={16} />
          </IconButton>
        </>
      )}
    </div>
  );
}

function WidthButton({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <SliderButton
      tip="Line width"
      label="Width"
      icon={<span className="width-glyph" style={{ height: Math.max(1, Math.min(6, value)) }} />}
      value={value}
      min={0.5}
      max={16}
      step={0.5}
      format={(v) => `${v}pt`}
      onChange={onChange}
    />
  );
}

function FontSize({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commitDraft = () => {
    const n = Number(draft);
    if (draft !== null && n >= 4 && n <= 400) onChange(Math.round(n * 10) / 10);
    setDraft(null);
  };
  return (
    <div className="font-size" data-tip="Font size">
      <input
        aria-label="Font size"
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commitDraft();
          if (e.key === 'ArrowUp') onChange(Math.min(400, value + 1));
          if (e.key === 'ArrowDown') onChange(Math.max(4, value - 1));
        }}
      />
      <span>pt</span>
    </div>
  );
}
