import { FileClock } from 'lucide-react';
import { useStore } from '../store';
import { discardRecovered, restoreRecovered, useRecovery } from '../lib/recovery';
import { Button, Modal } from './ui';

/** Closing a tab with unsaved changes. */
export function UnsavedDialog({ name, resolve }: { name: string; resolve: (choice: 'save' | 'discard' | 'cancel') => void }) {
  return (
    <Modal
      title="Save changes?"
      onClose={() => resolve('cancel')}
      width={420}
      footer={
        <>
          <Button variant="danger" onClick={() => resolve('discard')}>
            Don't save
          </Button>
          <span className="spacer" />
          <Button onClick={() => resolve('cancel')}>Cancel</Button>
          <Button variant="primary" onClick={() => resolve('save')}>
            Save
          </Button>
        </>
      }
    >
      <p>
        <strong>{name}</strong> has unsaved changes. Save them before closing?
      </p>
    </Modal>
  );
}

function when(t: number) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** Offered at startup when the last session ended without saving or discarding its changes. */
export function RecoveryPrompt() {
  const found = useRecovery((s) => s.found);
  const blocked = useStore((s) => !!s.dialog || !!s.busy);
  if (!found.length || blocked) return null;
  const n = found.length;
  return (
    <Modal
      title="Restore unsaved changes?"
      onClose={() => useRecovery.setState({ found: [] })}
      width={460}
      footer={
        <>
          <Button variant="danger" onClick={() => void discardRecovered()}>
            Discard
          </Button>
          <span className="spacer" />
          <Button onClick={() => useRecovery.setState({ found: [] })}>Later</Button>
          <Button variant="primary" onClick={() => void restoreRecovered()}>
            Restore {n === 1 ? 'document' : `${n} documents`}
          </Button>
        </>
      }
    >
      <p>Folio closed before {n === 1 ? 'this document was' : 'these documents were'} saved. The changes were kept on this device.</p>
      <ul className="recovery-list">
        {found.map((r) => (
          <li key={r.id}>
            <FileClock size={16} />
            <span className="recovery-name">{r.fileName}</span>
            <span className="muted small">{when(r.savedAt)}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
