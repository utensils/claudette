#![cfg(unix)]

//! End-to-end handshake test for the session-host's local-socket listener.
//!
//! Spawns the server pointed at a unique temp socket, connects a client,
//! sends `Request::Hello`, and asserts that the server replies with
//! `Response::HelloAck` for the current `PROTOCOL_VERSION`.

use claudette::agent::interactive_protocol::{
    InboundFrame, PROTOCOL_VERSION, Request, RequestEnvelope, Response, frame,
};
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

    // Hello is wrapped in a `RequestEnvelope` with the conventional
    // `request_id = 0`. The server echoes this in the matching
    // `InboundFrame::Response`.
    let env = RequestEnvelope {
        request_id: 0,
        request: Request::Hello {
            protocol_version: PROTOCOL_VERSION,
            claudette_version: "test".into(),
        },
    };
    let bytes = serde_json::to_vec(&env).unwrap();
    frame::write_frame(&mut w, &bytes).await.unwrap();

    let resp_bytes = frame::read_frame(&mut r).await.unwrap();
    let inbound: InboundFrame = serde_json::from_slice(&resp_bytes).unwrap();
    match inbound {
        InboundFrame::Response {
            request_id,
            response: Response::HelloAck {
                protocol_version, ..
            },
        } => {
            assert_eq!(request_id, 0, "handshake reply should echo request_id 0");
            assert_eq!(
                protocol_version, PROTOCOL_VERSION,
                "handshake should echo our protocol version"
            );
        }
        other => panic!("expected InboundFrame::Response(HelloAck), got {other:?}"),
    }

    server.abort();
    let _ = std::fs::remove_file(&socket_path);
}

#[tokio::test]
async fn handshake_rejects_unsupported_protocol_version() {
    let socket_path = std::env::temp_dir().join(format!(
        "claudette-handshake-mismatch-test-{}.sock",
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

    // Send a Hello with a protocol_version the server does not support.
    let env = RequestEnvelope {
        request_id: 0,
        request: Request::Hello {
            protocol_version: 999,
            claudette_version: "test".into(),
        },
    };
    let bytes = serde_json::to_vec(&env).unwrap();
    frame::write_frame(&mut w, &bytes).await.unwrap();

    let resp_bytes = frame::read_frame(&mut r).await.unwrap();
    let inbound: InboundFrame = serde_json::from_slice(&resp_bytes).unwrap();
    match inbound {
        InboundFrame::Response {
            request_id,
            response:
                Response::HelloNack {
                    supported_versions, ..
                },
        } => {
            assert_eq!(request_id, 0, "Nack reply should echo request_id 0");
            assert_eq!(
                supported_versions,
                vec![PROTOCOL_VERSION],
                "HelloNack should advertise only the server's supported protocol version"
            );
        }
        other => panic!("expected InboundFrame::Response(HelloNack), got {other:?}"),
    }

    server.abort();
    let _ = std::fs::remove_file(&socket_path);
}
