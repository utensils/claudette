use std::collections::HashMap;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use tauri::{AppHandle, Manager};

use crate::remote::DiscoveredServer;
use crate::state::AppState;

const SERVICE_TYPE: &str = "_claudette._tcp.local.";

/// Start an mDNS browser that discovers claudette-server instances on the LAN.
pub fn start_mdns_browser(app: &AppHandle) -> Result<(), String> {
    let mdns = ServiceDaemon::new().map_err(|e| format!("Failed to start mDNS daemon: {e}"))?;
    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("Failed to browse mDNS: {e}"))?;

    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        // Keep mdns alive for the lifetime of the task.
        let _mdns = mdns;

        // Track fullname → (host, port) for reliable removal.
        let mut fullname_map: HashMap<String, (String, u16)> = HashMap::new();

        while let Ok(event) = receiver.recv_async().await {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let name = info
                        .get_property_val_str("name")
                        .unwrap_or_default()
                        .to_string();
                    let fingerprint = info
                        .get_property_val_str("fingerprint")
                        .unwrap_or_default()
                        .to_string();
                    let host = info.get_hostname().trim_end_matches('.').to_string();
                    let port = info.get_port();
                    let fullname = info.get_fullname().to_string();

                    fullname_map.insert(fullname, (host.clone(), port));

                    let server = DiscoveredServer {
                        name,
                        host,
                        port,
                        cert_fingerprint_prefix: fingerprint,
                        // Filled in per request by `list_discovered_servers`.
                        is_paired: false,
                    };

                    let state = app_handle.state::<AppState>();
                    let mut servers = state.discovered_servers.write().await;
                    servers.retain(|s| s.host != server.host || s.port != server.port);
                    servers.push(server);
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    if let Some((host, port)) = fullname_map.remove(&fullname) {
                        let state = app_handle.state::<AppState>();
                        let mut servers = state.discovered_servers.write().await;
                        servers.retain(|s| s.host != host || s.port != port);
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}
