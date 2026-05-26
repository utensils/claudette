import { useEffect, useState } from "react";
import {
  connectSaved,
  forgetConnection,
  listSavedConnections,
  pairWithConnectionString,
} from "../services/rpc";
import { isScannerAvailable, scanQr } from "../services/scanner";
import type { SavedConnection } from "../types";

interface Props {
  onConnected: (conn: SavedConnection) => void;
}

export function ConnectScreen({ onConnected }: Props) {
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannerOk, setScannerOk] = useState(false);

  useEffect(() => {
    void listSavedConnections().then(setSaved).catch((e) => setError(String(e)));
    void isScannerAvailable().then(setScannerOk);
  }, []);

  const handlePair = async (connectionString: string) => {
    setError(null);
    setBusy(true);
    try {
      const result = await pairWithConnectionString(connectionString);
      onConnected(result.connection);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleScan = async () => {
    setError(null);
    const content = await scanQr();
    if (!content) {
      setError("No QR detected — try again or use Advanced > Paste connection string.");
      return;
    }
    void handlePair(content);
  };

  const handleReconnect = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const conn = await connectSaved(id);
      onConnected(conn);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleForget = async (id: string) => {
    setError(null);
    try {
      await forgetConnection(id);
      setSaved((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="connect-screen">
      <header className="connect-header">
        <h1>Claudette</h1>
        <p className="subtitle">Pair with your desktop or headless server</p>
      </header>

      {saved.length > 0 && (
        <section className="connect-section">
          <h2 className="section-title">Saved</h2>
          <ul className="conn-list">
            {saved.map((c) => (
              <li key={c.id} className="conn-row">
                <button
                  className="conn-row-main"
                  disabled={busy}
                  onClick={() => void handleReconnect(c.id)}
                >
                  <span className="conn-name">{c.name}</span>
                  <span className="conn-host">
                    {c.host}:{c.port}
                  </span>
                </button>
                <button
                  className="conn-forget"
                  aria-label={`Forget ${c.name}`}
                  onClick={() => void handleForget(c.id)}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="connect-section">
        <h2 className="section-title">Pair a new server</h2>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void handleScan()}
        >
          {scannerOk ? "Scan QR code" : "Scan QR (preview only on desktop)"}
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setShowPaste((v) => !v)}
        >
          {showPaste ? "Cancel" : "Paste connection string"}
        </button>
        {showPaste && (
          <div className="paste-row">
            <input
              className="paste-input"
              placeholder="claudette://host:7683/..."
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              className="primary"
              disabled={busy || !pasteValue.trim()}
              onClick={() => void handlePair(pasteValue.trim())}
            >
              {busy ? "Pairing…" : "Pair"}
            </button>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </section>

      <footer className="footnote">
        Pairing is encrypted with TLS + fingerprint pinning. The pairing
        token is one-time; the long-lived session token is stored in this
        app's sandboxed data directory.
      </footer>
    </div>
  );
}
