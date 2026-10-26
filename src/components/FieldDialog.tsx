import { useState } from 'react';
import type { FieldObj } from '../types';
import { actions, commit, useStore } from '../store';
import { Button, Field, Modal, Toggle } from './ui';
import { FIELD_LABEL } from './labels';

const close = () => actions.set({ dialog: null });

/** Properties of a form field being designed. Applying them is one undo step. */
export function FieldDialog({ id }: { id: string }) {
  const o = useStore((s) => s.objects.find((x): x is FieldObj => x.id === id && x.type === 'field'));
  if (!o) return null;
  return <FieldForm o={o} />;
}

function FieldForm({ o }: { o: FieldObj }) {
  const [name, setName] = useState(o.name);
  const [tooltip, setTooltip] = useState(o.tooltip ?? '');
  const [required, setRequired] = useState(!!o.required);
  const [value, setValue] = useState(o.value ?? '');
  const [checked, setChecked] = useState(!!o.checked);
  const [choice, setChoice] = useState(o.choice ?? '');
  const [options, setOptions] = useState((o.options ?? []).join('\n'));
  const [autoSize, setAutoSize] = useState(!o.fontSize);
  const [fontSize, setFontSize] = useState(o.fontSize || 10);
  const isText = o.kind === 'text' || o.kind === 'multiline';
  const optionList = options
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  const valid = !!name.trim() && (o.kind !== 'radio' || !!choice.trim()) && (o.kind !== 'dropdown' || optionList.length > 0);

  const apply = () => {
    if (!valid) return;
    const group = o.kind === 'radio' ? o.name : null;
    const patch: Partial<FieldObj> = {
      name: name.trim(),
      tooltip: tooltip.trim() || undefined,
      required: required || undefined,
    };
    if (isText) patch.value = value || undefined;
    if (o.kind === 'dropdown') {
      patch.options = optionList;
      patch.value = optionList.includes(value) ? value : undefined;
    }
    if (isText || o.kind === 'dropdown') patch.fontSize = autoSize ? 0 : Math.max(4, Math.min(72, fontSize));
    if (o.kind === 'checkbox') patch.checked = checked || undefined;
    if (o.kind === 'radio') {
      patch.choice = choice.trim();
      patch.checked = checked || undefined;
    }
    commit((s) => ({
      objects: s.objects.map((x) => {
        if (x.id === o.id) return { ...x, ...patch } as FieldObj;
        // The group's name, tooltip and "required" belong to all its buttons; only one starts selected.
        if (group && x.type === 'field' && x.kind === 'radio' && x.name === group) {
          return { ...x, name: patch.name!, tooltip: patch.tooltip, required: patch.required, checked: checked ? undefined : x.checked };
        }
        return x;
      }),
    }));
    close();
  };

  return (
    <Modal
      title={`${FIELD_LABEL[o.kind]} properties`}
      onClose={close}
      width={440}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={!valid}>
            Apply
          </Button>
        </>
      }
    >
      <div className="row">
        <Field label={o.kind === 'radio' ? 'Group name' : 'Name'} hint={o.kind === 'radio' ? 'Buttons with the same group name are one choice.' : undefined}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        {o.kind === 'radio' && (
          <Field label="Value of this button">
            <input className="input" value={choice} onChange={(e) => setChoice(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Tooltip" hint="Shown when the pointer is over the field; also read out by screen readers.">
        <input className="input" value={tooltip} onChange={(e) => setTooltip(e.target.value)} />
      </Field>
      {o.kind === 'text' && (
        <Field label="Default value">
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}
      {o.kind === 'multiline' && (
        <Field label="Default value">
          <textarea className="input textarea" rows={3} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      )}
      {o.kind === 'dropdown' && (
        <>
          <Field label="Choices" hint="One per line.">
            <textarea className="input textarea" rows={4} value={options} onChange={(e) => setOptions(e.target.value)} />
          </Field>
          <Field label="Default value">
            <select className="select" value={optionList.includes(value) ? value : ''} onChange={(e) => setValue(e.target.value)}>
              <option value="">(none)</option>
              {optionList.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      {(isText || o.kind === 'dropdown') && (
        <div className="row field-size-row">
          <Toggle checked={autoSize} onChange={setAutoSize} label="Fit text to the field" />
          {!autoSize && (
            <div className="input-suffix field-size">
              <input className="input" type="number" min={4} max={72} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value) || 10)} aria-label="Font size" />
              <span>pt</span>
            </div>
          )}
        </div>
      )}
      {o.kind === 'checkbox' && <Toggle checked={checked} onChange={setChecked} label="Checked by default" />}
      {o.kind === 'radio' && <Toggle checked={checked} onChange={setChecked} label="Selected by default" />}
      <Toggle checked={required} onChange={setRequired} label="Required" />
    </Modal>
  );
}
