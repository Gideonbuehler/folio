import { useEffect, useState, type ReactNode } from 'react';
import { Asterisk, ChevronDown, CircleDot, FileSignature, FormInput, Settings2, SquareCheckBig, SquareChevronDown, TextCursor, AlignLeft, Wand2 } from 'lucide-react';
import { FIELD_TOOLS, type FieldKind, type FieldObj, type FieldTool, type Rect } from '../types';
import { actions, setTool, updateObjects, useStore } from '../store';
import { makeFieldsFillable, primeFieldNames } from '../lib/forms';
import { assignedSize } from '../lib/prepare';
import { IconButton, Popover, usePopover } from './ui';
import { FIELD_LABEL } from './labels';

const S = 18;

export const FIELD_ICONS: Record<FieldKind, ReactNode> = {
  text: <TextCursor size={S} />,
  multiline: <AlignLeft size={S} />,
  checkbox: <SquareCheckBig size={S} />,
  radio: <CircleDot size={S} />,
  dropdown: <SquareChevronDown size={S} />,
  signature: <FileSignature size={S} />,
};

const ORDER = Object.keys(FIELD_TOOLS) as FieldTool[];

export const isFieldTool = (t: string): t is FieldTool => t in FIELD_TOOLS;

/** Size of a field placed with a click instead of a drag. */
export function defaultFieldRect(kind: FieldKind, at: { x: number; y: number }): Rect {
  const [w, h] = assignedSize() ?? { text: [150, 22], multiline: [200, 60], checkbox: [14, 14], radio: [14, 14], dropdown: [130, 22], signature: [180, 46] }[kind];
  return { x: at.x - w / 2, y: at.y - h / 2, w, h };
}

/** Toolbar button for the form field tools, like the shapes button. */
export function FieldsButton() {
  const tool = useStore((s) => s.tool);
  const [last, setLast] = useState<FieldTool>('fieldText');
  const p = usePopover();
  useEffect(() => {
    if (isFieldTool(tool)) setLast(tool);
  }, [tool]);
  const active = isFieldTool(tool);
  const choose = (t: FieldTool) => {
    primeFieldNames();
    setTool(t);
  };
  return (
    <div className={`split-btn ${active ? 'active' : ''}`}>
      <IconButton tip={`Add ${FIELD_LABEL[FIELD_TOOLS[last]].toLowerCase()}`} shortcut={last === 'fieldText' ? 'F' : undefined} active={active} onClick={() => choose(last)}>
        {FIELD_ICONS[FIELD_TOOLS[last]]}
      </IconButton>
      <button ref={p.anchor} type="button" className="split-caret" aria-label="More form fields" onClick={p.toggle}>
        <ChevronDown size={12} />
      </button>
      <Popover anchor={p.anchor} open={p.open} onClose={p.close}>
        <div className="menu">
          <div className="menu-heading">Form fields</div>
          {ORDER.map((t) => (
            <button
              key={t}
              type="button"
              className="menu-item"
              onClick={() => {
                choose(t);
                p.close();
              }}
            >
              <span className="menu-icon">{FIELD_ICONS[FIELD_TOOLS[t]]}</span>
              <span className="menu-label">{FIELD_LABEL[FIELD_TOOLS[t]]}</span>
              {t === 'fieldText' && <span className="menu-shortcut">F</span>}
            </button>
          ))}
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item"
            disabled={!actions.get().objects.some((o) => o.type === 'field')}
            onClick={() => {
              p.close();
              void makeFieldsFillable();
            }}
          >
            <span className="menu-icon">
              <Wand2 size={16} />
            </span>
            <span className="menu-label">Make fields fillable now</span>
          </button>
        </div>
      </Popover>
    </div>
  );
}

/** Context bar controls for selected fields (or the active field tool). */
export function FieldOptions({ selected, tool }: { selected: FieldObj[]; tool: string }) {
  const o = selected[0];
  const [name, setName] = useState<string | null>(null);
  useEffect(() => setName(null), [o?.id]);
  if (!o) {
    const kind = isFieldTool(tool) ? FIELD_TOOLS[tool] : 'text';
    return (
      <span className="hint">
        {kind === 'radio' ? 'Click or drag to place buttons of one group; Esc when done' : `Drag to place a ${FIELD_LABEL[kind].toLowerCase()}, or click for the usual size`}
      </span>
    );
  }
  const ids = selected.map((x) => x.id);
  const commitName = () => {
    const v = name?.trim();
    if (v && v !== o.name) updateObjects(ids, { name: v } as Partial<FieldObj>);
    setName(null);
  };
  const required = selected.every((x) => x.required);
  return (
    <>
      <input
        className="input field-name-input"
        aria-label={o.kind === 'radio' ? 'Group name' : 'Field name'}
        data-tip={o.kind === 'radio' ? 'Group name' : 'Field name'}
        value={name ?? o.name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commitName();
          if (e.key === 'Escape') setName(null);
        }}
      />
      <IconButton tip={required ? 'Required' : 'Optional'} active={required} onClick={() => updateObjects(ids, { required: !required } as Partial<FieldObj>)}>
        <Asterisk size={16} />
      </IconButton>
      <IconButton tip="Field properties" onClick={() => actions.set({ dialog: { kind: 'field', id: o.id } })}>
        <Settings2 size={16} />
      </IconButton>
      <IconButton tip="Make fields fillable now" onClick={() => void makeFieldsFillable()}>
        <FormInput size={16} />
      </IconButton>
    </>
  );
}
