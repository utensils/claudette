#![cfg(unix)]

//! End-to-end handshake test for the session-host's local-socket listener.
//!
//! Spawns the server pointed at a unique temp socket, connects a client,
//! sends `Request::Hello`, and asserts that the server replies with
//! `Response::HelloAck` for the current `PROTOCOL_VERSION`.

use claudette::agent::interactive_protocol::{PROTOCOL_VERSION, Request, Response, frame};
use interprocess::local_socket::tokio::{Stream, prelude::*};
use interprocess::local_socket::{GenericFilePath, ToFsName};

#[tokio::test]
async fn handshake_round_trip() {
    let socket_path = std::env::temp_dir().join(format!(
        "claudette-handshake-test-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&socket_path);

    let server = tokio::spawn({
        let sp = socket_path.clone();
        async move {
            claudette_session_host::server::run_for_test(&sp)
                .await
                .unwrap()
        }
    });
    // Give the listener time to bind.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let name = socket_path
        .as_path()
        .to_fs_name::<GenericFilePath>()
        .unwrap();
    let s = Stream::connect(name).await.unwrap();
    let (mut r, mut w) = s.split();

    let req = serde_json::to_vec(&Request::Hello {
        protocol_version: PROTOCOL_VERSION,
        claudette_version: "test".into(),
    })
    .unwrap();
    frame::write_frame(&mut w, &req).await.unwrap();

    let resp_bytes = frame::read_frame(&mut r).await.unwrap();
    let resp: Response = serde_json::from_slice(&resp_bytes).unwrap();
    match resp {
        Response::HelloAck {
            protocol_version, ..
        } => assert_eq!(
            protocol_version, PROTOCOL_VERSION,
            "handshake should echo our protocol version"
        ),
        other => panic!("expected HelloAck, got {other:?}"),
    }

    server.abort();
    let _ = std::fs::remove_file(&socket_path);
}
