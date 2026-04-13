import { useState, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { detectMcpServers, configureWorkspaceMcps } from '../../services/mcp';
import type { McpServer } from '../../types/mcp';
import { Modal } from './Modal';
import shared from './shared.module.css';

export function McpSelectionModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const [loading, setLoading] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const workspaceId = modalData.workspaceId as string;
  const repoId = modalData.repoId as string;

  console.log('[MCP Modal] Component rendered! workspaceId:', workspaceId, 'repoId:', repoId);

  useEffect(() => {
    console.log('[MCP Modal] Mounted, detecting servers for repo:', repoId);
    detectMcpServers(repoId)
      .then((detected) => {
        console.log('[MCP Modal] Detected servers:', detected);
        setServers(detected);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[MCP Modal] Detection error:', err);
        setError(`Failed to detect MCP servers: ${err}`);
        setLoading(false);
      });
  }, [repoId]);

  const toggleServer = (name: string) => {
    const newSelected = new Set(selectedNames);
    if (newSelected.has(name)) {
      newSelected.delete(name);
    } else {
      newSelected.add(name);
    }
    setSelectedNames(newSelected);
  };

  const handleConfigure = async () => {
    const selectedServers = servers.filter((s) => selectedNames.has(s.name));
    if (selectedServers.length === 0) {
      closeModal();
      return;
    }

    setConfiguring(true);
    try {
      await configureWorkspaceMcps(workspaceId, selectedServers);
      closeModal();
    } catch (err) {
      setError(`Failed to configure MCP servers: ${err}`);
      setConfiguring(false);
    }
  };

  const getScopeLabel = (scope: string) => {
    switch (scope) {
      case 'user':
        return 'user (global)';
      case 'project':
        return 'project';
      case 'local':
        return 'local';
      default:
        return scope;
    }
  };

  const getConfigPreview = (server: McpServer): string => {
    switch (server.config.type) {
      case 'stdio':
        return `Command: ${server.config.command} ${server.config.args.join(' ')}`;
      case 'http':
        return `URL: ${server.config.url}`;
      case 'sse':
        return `URL: ${server.config.url}`;
      default:
        return '';
    }
  };

  return (
    <Modal title="Configure MCP Servers for Workspace" onClose={closeModal}>
      {loading && (
        <div className={shared.field}>
          <p>Detecting MCP servers...</p>
        </div>
      )}

      {error && (
        <div className={shared.warning}>
          {error}
        </div>
      )}

      {!loading && !error && servers.length === 0 && (
        <div className={shared.field}>
          <p>No MCP servers detected in user, project, or local configurations.</p>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '8px' }}>
            You can configure MCP servers in:
            <br />
            • <code>~/.claude.json</code> (user scope)
            <br />
            • <code>.mcp.json</code> (project scope)
            <br />
            • <code>.claude.json</code> (local scope)
          </p>
        </div>
      )}

      {!loading && !error && servers.length > 0 && (
        <div className={shared.field}>
          <label className={shared.label}>
            Select which MCP servers to enable for this workspace:
          </label>
          <div
            style={{
              border: '1px solid var(--divider)',
              borderRadius: 6,
              maxHeight: 300,
              overflow: 'auto',
            }}
          >
            {servers.map((server) => (
              <div
                key={`${server.scope}-${server.name}`}
                style={{
                  padding: '12px',
                  borderBottom: '1px solid var(--divider)',
                  cursor: 'pointer',
                  background: selectedNames.has(server.name)
                    ? 'var(--chat-input-bg)'
                    : 'transparent',
                }}
                onClick={() => toggleServer(server.name)}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                  <input
                    type="checkbox"
                    checked={selectedNames.has(server.name)}
                    onChange={() => toggleServer(server.name)}
                    style={{ marginTop: '2px', cursor: 'pointer' }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, marginBottom: '4px' }}>
                      {server.name}{' '}
                      <span
                        style={{
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                          fontWeight: 'normal',
                        }}
                      >
                        ({server.config.type}, {getScopeLabel(server.scope)})
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: 'var(--text-secondary)',
                        fontFamily: 'monospace',
                      }}
                    >
                      {getConfigPreview(server)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal} disabled={configuring}>
          Skip
        </button>
        {servers.length > 0 && (
          <button
            className={shared.btnPrimary}
            onClick={handleConfigure}
            disabled={configuring || selectedNames.size === 0}
          >
            {configuring
              ? 'Configuring...'
              : selectedNames.size === 0
                ? 'Select Servers'
                : `Configure ${selectedNames.size} Server${selectedNames.size > 1 ? 's' : ''}`}
          </button>
        )}
      </div>
    </Modal>
  );
}
