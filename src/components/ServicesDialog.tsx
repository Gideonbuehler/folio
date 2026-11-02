/** File > Signing services: where requests can be sent besides the user's own email. */
import { useState } from 'react';
import { CircleCheck, Loader2, TriangleAlert } from 'lucide-react';
import { actions } from '../store';
import { setServices, trimUrl, useServices } from '../lib/services';
import { checkFolioSign } from '../lib/foliosign';
import { checkDocumenso } from '../lib/documenso';
import { Button, Field, Modal } from './ui';

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; text: string } | { state: 'error'; text: string };

function CheckLine({ check }: { check: Check }) {
  if (check.state === 'idle') return null;
  if (check.state === 'checking')
    return (
      <p className="service-check">
        <Loader2 size={14} className="spin" /> Checking…
      </p>
    );
  return (
    <p className={`service-check ${check.state}`}>
      {check.state === 'ok' ? <CircleCheck size={14} /> : <TriangleAlert size={14} />} {check.text}
    </p>
  );
}

export function ServicesDialog({ back }: { back?: boolean }) {
  const sv = useServices();
  const [fsUrl, setFsUrl] = useState(sv.folioSign?.url ?? '');
  const [fsKey, setFsKey] = useState(sv.folioSign?.key ?? '');
  const [dUrl, setDUrl] = useState(sv.documenso?.url ?? 'https://app.documenso.com');
  const [dToken, setDToken] = useState(sv.documenso?.token ?? '');
  const [fsCheck, setFsCheck] = useState<Check>({ state: 'idle' });
  const [dCheck, setDCheck] = useState<Check>({ state: 'idle' });
  const close = () => actions.set({ dialog: back ? { kind: 'sendRequest' } : null });

  const testFs = async () => {
    setFsCheck({ state: 'checking' });
    try {
      const who = await checkFolioSign({ url: fsUrl, key: fsKey });
      setFsCheck({ state: 'ok', text: `Connected. The key belongs to ${who}.` });
    } catch (e) {
      setFsCheck({ state: 'error', text: (e as Error).message });
    }
  };
  const testD = async () => {
    setDCheck({ state: 'checking' });
    try {
      await checkDocumenso({ url: dUrl, token: dToken });
      setDCheck({ state: 'ok', text: 'Connected.' });
    } catch (e) {
      setDCheck({ state: 'error', text: (e as Error).message });
    }
  };
  const save = () => {
    setServices({
      folioSign: fsUrl.trim() && fsKey.trim() ? { url: trimUrl(fsUrl), key: fsKey.trim() } : null,
      documenso: dToken.trim() ? { url: trimUrl(dUrl) || 'https://app.documenso.com', token: dToken.trim() } : null,
    });
    close();
  };
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();

  return (
    <Modal
      title="Signing services"
      onClose={close}
      width={520}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <p className="muted small">
        Besides your own email, requests can go out through a signing service: it emails each signer a link to sign in their browser and keeps a record of
        who opened and signed it. Keys are kept on this device only.
      </p>
      <section className="service">
        <h3>Folio Sign</h3>
        <p className="muted small">Your own signing server (the server folder that comes with Folio). Ask whoever runs it for its address and an API key.</p>
        <Field label="Server address">
          <input className="input" placeholder="https://sign.example.com" value={fsUrl} onChange={(e) => setFsUrl(e.target.value)} onKeyDown={stop} />
        </Field>
        <Field label="API key">
          <input className="input" type="password" autoComplete="off" value={fsKey} onChange={(e) => setFsKey(e.target.value)} onKeyDown={stop} />
        </Field>
        <div className="service-actions">
          <Button disabled={!fsUrl.trim() || !fsKey.trim()} onClick={testFs}>
            Test connection
          </Button>
          <CheckLine check={fsCheck} />
        </div>
      </section>
      <section className="service">
        <h3>Documenso</h3>
        <p className="muted small">documenso.com or your own Documenso. Create an API token in Documenso under Settings, API tokens. Works from the desktop app.</p>
        <Field label="Address">
          <input className="input" value={dUrl} onChange={(e) => setDUrl(e.target.value)} onKeyDown={stop} />
        </Field>
        <Field label="API token">
          <input className="input" type="password" autoComplete="off" value={dToken} onChange={(e) => setDToken(e.target.value)} onKeyDown={stop} />
        </Field>
        <div className="service-actions">
          <Button disabled={!dToken.trim()} onClick={testD}>
            Test connection
          </Button>
          <CheckLine check={dCheck} />
        </div>
      </section>
    </Modal>
  );
}
