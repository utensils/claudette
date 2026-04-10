/// Debug-only commands and TCP eval server. Gated behind `#[cfg(debug_assertions)]`
/// — never compiled into release builds.
///
/// Architecture:
///   Terminal ──TCP:19432──▶ debug server ──eval()──▶ webview JS context
///                                                        │
///   Terminal ◀──TCP────── debug server ◀──event── webview (emit result)
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Port for the debug TCP server. Only binds to 127.0.0.1.
const DEBUG_PORT: u16 = 19432;

/// Tauri command: eval JS in the webview and return the result.
/// Called internally by the TCP server, but also registered as a Tauri command
/// for use from the webview console.
#[tauri::command]
pub async fn debug_eval_js(app: AppHandle, js: String) -> Result<String, String> {
    eval_in_webview(&app, &js).await
}

/// Core eval logic: wraps user JS to capture its return value, evals it in the
/// webview, waits for the result event, and returns the stringified result.
async fn eval_in_webview(app: &AppHandle, js: &str) -> Result<String, String> {
    let webview = app
        .get_webview_window("main")
        .ok_or("No main webview window found")?;

    let request_id = uuid::Uuid::new_v4().to_string();

    // Wrap user JS so it:
    //  1. Evaluates the code in an async IIFE
    //  2. Stringifies the result
    //  3. Calls back via window.__CLAUDETTE_INVOKE__ (set by services/tauri.ts in dev)
    let wrapped = format!(
        r#"(async () => {{
  const __invoke = window.__CLAUDETTE_INVOKE__;
  if (!__invoke) {{ console.error('[debug] __CLAUDETTE_INVOKE__ not set'); return; }}
  try {{
    const __r = await (async () => {{ {js} }})();
    const __s = (typeof __r === 'string') ? __r : JSON.stringify(__r, null, 2);
    await __invoke('debug_eval_result', {{ requestId: '{request_id}', data: __s ?? 'undefined' }});
  }} catch (__e) {{
    await __invoke('debug_eval_result', {{ requestId: '{request_id}', data: 'ERROR: ' + (__e.message || String(__e)) }});
  }}
}})()"#,
        js = js,
        request_id = request_id,
    );

    // Set up a oneshot channel to receive the result.
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));

    let rid = request_id.clone();
    let tx_clone = Arc::clone(&tx);
    let listener_id = app.listen(format!("debug-eval-result-{rid}"), move |event| {
        let payload = event.payload().to_string();
        if let Some(tx) = tx_clone.lock().unwrap().take() {
            let _ = tx.send(payload);
        }
    });

    webview
        .eval(&wrapped)
        .map_err(|e| format!("eval failed: {e}"))?;

    // Wait with timeout.
    let result = match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(result)) => {
            // Result arrives as a JSON string (quoted). Strip outer quotes if present.
            let trimmed = result.trim();
            if trimmed.starts_with('"') && trimmed.ends_with('"') {
                serde_json::from_str::<String>(trimmed).unwrap_or(result)
            } else {
                result
            }
        }
        Ok(Err(_)) => "ERROR: result channel closed".to_string(),
        Err(_) => "ERROR: timeout (10s) waiting for eval result".to_string(),
    };

    app.unlisten(listener_id);
    Ok(result)
}

/// Receives eval results from the webview. The wrapped JS calls this command
/// to send the result back, and it emits a targeted event that `eval_in_webview` listens for.
#[tauri::command]
pub async fn debug_eval_result(
    app: AppHandle,
    request_id: String,
    data: String,
) -> Result<(), String> {
    app.emit(&format!("debug-eval-result-{request_id}"), &data)
        .map_err(|e| format!("Failed to emit result: {e}"))?;
    Ok(())
}

/// Start the debug TCP eval server on 127.0.0.1:19432.
/// Call this from the Tauri `setup()` hook.
pub fn start_debug_server(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", DEBUG_PORT)).await {
            Ok(l) => {
                eprintln!("[debug] Eval server listening on 127.0.0.1:{DEBUG_PORT}");
                l
            }
            Err(e) => {
                eprintln!("[debug] Failed to start eval server: {e}");
                return;
            }
        };

        loop {
            let (mut stream, _addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    eprintln!("[debug] Accept failed: {e}");
                    continue;
                }
            };

            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // Simple line-based protocol:
                //   - Read all input until EOF (client closes write half)
                //   - Eval the JS
                //   - Write result back
                //   - Close
                let mut buf = Vec::with_capacity(4096);
                // Cap input at 1 MB to prevent accidental runaway allocations.
                if let Err(e) = (&mut stream).take(1024 * 1024).read_to_end(&mut buf).await {
                    eprintln!("[debug] Read failed: {e}");
                    return;
                }

                let js = String::from_utf8_lossy(&buf);
                let js = js.trim();
                if js.is_empty() {
                    let _ = stream.write_all(b"ERROR: empty input\n").await;
                    return;
                }

                match eval_in_webview(&app, js).await {
                    Ok(result) => {
                        let _ = stream.write_all(result.as_bytes()).await;
                        let _ = stream.write_all(b"\n").await;
                    }
                    Err(e) => {
                        let _ = stream.write_all(format!("ERROR: {e}\n").as_bytes()).await;
                    }
                }
            });
        }
    });
}
