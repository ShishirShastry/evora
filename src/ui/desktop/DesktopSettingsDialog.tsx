import { useEffect, useState } from 'react';
import { normalizeServerUrl, type DesktopSettings, type EvoraDesktop, type HostStatus } from '../../persistence/desktopContract';
import { Dialog } from '../components/Dialog';

/**
 * The desktop app's collaboration settings: which server to work with (none
 * means everything stays on this computer), and a team server hosted by this
 * computer for others on the network. Free, with no limits.
 */
export function DesktopSettingsDialog({ bridge, onClose }: { bridge: EvoraDesktop; onClose: () => void }) {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [address, setAddress] = useState('');
  const [checking, setChecking] = useState(false);
  const [serverMessage, setServerMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [port, setPort] = useState('8787');
  const [useHere, setUseHere] = useState(true);
  const [hostBusy, setHostBusy] = useState(false);

  useEffect(() => {
    void bridge.settings().then((loaded) => {
      setSettings(loaded);
      setAddress(loaded.serverUrl ?? '');
      setPort(String(loaded.hostPort));
    });
    void bridge.hostStatus().then(setHost);
    return bridge.onHostStatus(setHost);
  }, [bridge]);

  /** Changing the server reloads the window (its security policy names the server), after saving what is open. */
  const applyServer = async (origin: string | null): Promise<void> => {
    const next = await bridge.setSettings({ serverUrl: origin });
    setSettings(next);
  };

  const connect = async (): Promise<void> => {
    const origin = normalizeServerUrl(address);
    if (!origin) {
      setServerMessage({ ok: false, text: 'Write the server’s address, for example http://192.168.1.20:8787.' });
      return;
    }
    setChecking(true);
    setServerMessage(null);
    const check = await bridge.checkServer(origin);
    setChecking(false);
    if (!check.ok) {
      setServerMessage({ ok: false, text: `No Evora server answered at ${origin}. ${check.message ?? ''}` });
      return;
    }
    await applyServer(origin);
  };

  const startHost = async (): Promise<void> => {
    const wanted = Number(port);
    if (!Number.isInteger(wanted) || wanted < 1024 || wanted > 65535) {
      setHost((current) => (current ? { ...current, state: 'error', message: 'Choose a port from 1024 to 65535.' } : current));
      return;
    }
    setHostBusy(true);
    const status = await bridge.startHost(wanted);
    setHost(status);
    setHostBusy(false);
    if (status.state === 'running' && useHere && status.port !== null) await applyServer(`http://127.0.0.1:${status.port}`);
  };

  const stopHost = async (): Promise<void> => {
    setHostBusy(true);
    setHost(await bridge.stopHost());
    setHostBusy(false);
  };

  const running = host?.state === 'running';
  return (
    <Dialog
      title="Collaboration"
      onClose={onClose}
      width={560}
      footer={
        <button type="button" className="ev-button" onClick={onClose}>
          Done
        </button>
      }
    >
      <section aria-labelledby="desktop-server-heading" className="flex flex-col gap-2">
        <h3 id="desktop-server-heading" className="m-0 text-[13px] font-semibold text-ink">
          Collaboration server
        </h3>
        <p className="m-0 leading-relaxed text-dim">
          {settings?.serverUrl
            ? <>Shared files, accounts and comments are on <strong className="font-semibold text-ink">{settings.serverUrl}</strong>.</>
            : 'None: Evora works with the files on this computer only. Connect to a team’s Evora server to share files and work on them together.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Server address"
            className="ev-field min-w-0 flex-1"
            placeholder="http://192.168.1.20:8787"
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void connect();
            }}
          />
          <button type="button" className="ev-button ev-button-primary" disabled={checking} onClick={() => void connect()}>
            {checking ? 'Checking…' : 'Connect'}
          </button>
          {settings?.serverUrl && (
            <button
              type="button"
              className="ev-button"
              onClick={() => {
                setAddress('');
                void applyServer(null);
              }}
            >
              Use this computer only
            </button>
          )}
        </div>
        {serverMessage && (
          <p role="alert" className={`m-0 ${serverMessage.ok ? 'text-dim' : 'text-danger'}`}>
            {serverMessage.text}
          </p>
        )}
      </section>

      <section aria-labelledby="desktop-host-heading" className="mt-5 flex flex-col gap-2">
        <h3 id="desktop-host-heading" className="m-0 text-[13px] font-semibold text-ink">
          Host a team server from this computer
        </h3>
        <p className="m-0 leading-relaxed text-dim">
          Runs Evora’s collaboration server here, for the people on your network. It runs while Evora is open. Its accounts and files are kept in{' '}
          <span className="break-all text-ink">{host?.dataDir ?? '…'}</span>.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-dim">
            Port
            <input
              aria-label="Port"
              className="ev-field w-24"
              inputMode="numeric"
              value={port}
              disabled={running}
              onChange={(event) => setPort(event.currentTarget.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-dim">
            <input type="checkbox" checked={useHere} disabled={running} onChange={(event) => setUseHere(event.currentTarget.checked)} />
            Use it in this app
          </label>
          {running ? (
            <button type="button" className="ev-button" disabled={hostBusy} onClick={() => void stopHost()}>
              Stop the server
            </button>
          ) : (
            <button type="button" className="ev-button ev-button-primary" disabled={hostBusy || host?.state === 'starting'} onClick={() => void startHost()}>
              {host?.state === 'starting' || hostBusy ? 'Starting…' : 'Start the server'}
            </button>
          )}
        </div>
        <div role="status" aria-label="Team server" className="leading-relaxed text-dim">
          {host?.state === 'running' && (
            <>
              <p className="m-0 text-ink">Running on port {host.port}. Others on your network open Evora at, or connect their Evora app to:</p>
              <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                {host.addresses.map((url) => (
                  <li key={url} className="select-text font-mono text-[12px] text-ink">
                    {url}
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-1">Your system may ask whether Evora may accept connections from the network.</p>
            </>
          )}
          {host?.state === 'stopped' && <p className="m-0">Not running.</p>}
          {host?.state === 'error' && <p className="m-0 text-danger">{host.message}</p>}
        </div>
      </section>
    </Dialog>
  );
}
