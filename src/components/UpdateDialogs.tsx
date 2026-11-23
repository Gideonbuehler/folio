import { CircleArrowDown } from 'lucide-react';
import { actions, useStore } from '../store';
import { isDesktop } from '../lib/native';
import { APP_VERSION, checkForUpdates, installOnNextStart, saveAndInstall, useUpdates } from '../lib/updates';
import { Button, Modal } from './ui';
import { BrandMark } from './BrandMark';
import '../updates.css';

const close = () => actions.set({ dialog: null });

/** In the header once an update is found; the only sign of it until the user asks. */
export function UpdateButton() {
  const update = useUpdates((s) => s.update);
  if (!update) return null;
  return (
    <button type="button" className="update-btn" onClick={() => actions.set({ dialog: { kind: 'update' } })} data-tip={`Folio ${update.version} is available`}>
      <CircleArrowDown size={15} />
      <span>Update</span>
    </button>
  );
}

export function UpdateDialog() {
  const update = useUpdates((s) => s.update);
  const pending = useUpdates((s) => s.pending);
  const unsaved = useStore((s) => s.tabs.filter((t) => (t.saved ?? s).dirty).length);
  if (!update) return null;
  const date = update.date ? new Date(update.date) : null;
  return (
    <Modal
      title="Update available"
      onClose={close}
      width={480}
      footer={
        <>
          <Button onClick={close}>Later</Button>
          <span className="spacer" />
          {pending !== update.version && <Button onClick={installOnNextStart}>Install on next start</Button>}
          <Button variant="primary" onClick={() => void saveAndInstall()}>
            {unsaved ? 'Save and install' : 'Install and restart'}
          </Button>
        </>
      }
    >
      <p>
        <strong>Folio {update.version}</strong> is available. You have {APP_VERSION}.
        {date && !Number.isNaN(date.getTime()) && <span className="muted"> Released {date.toLocaleDateString([], { dateStyle: 'medium' })}.</span>}
      </p>
      {update.body?.trim() && <div className="update-notes">{update.body.trim()}</div>}
      <p className="muted">
        {unsaved
          ? `${unsaved === 1 ? 'A document has' : `${unsaved} documents have`} unsaved changes. Folio saves ${unsaved === 1 ? 'it' : 'them'} first, then restarts to install the update and reopens your documents.`
          : 'Folio restarts to install the update and reopens your documents.'}
        {pending === update.version && ' It will also be installed the next time you start Folio.'}
      </p>
    </Modal>
  );
}

export function AboutDialog() {
  return (
    <Modal
      title="About Folio"
      onClose={close}
      width={420}
      footer={
        <>
          {isDesktop && (
            <Button
              onClick={() => {
                close();
                void checkForUpdates();
              }}
            >
              Check for updates…
            </Button>
          )}
          <span className="spacer" />
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <div className="about">
        <BrandMark size={52} />
        <div>
          <div className="about-name">Folio</div>
          <div>Version {APP_VERSION}</div>
          <div className="muted small">{isDesktop ? 'Desktop app for Windows' : 'Web version'}</div>
        </div>
      </div>
      <p className="muted">Edit, annotate, sign, organize and protect PDF files. Everything runs on your computer; documents are never uploaded.</p>
    </Modal>
  );
}
