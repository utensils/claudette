use mdns_sd::{ServiceDaemon, ServiceInfo};

const SERVICE_TYPE: &str = "_claudette._tcp.local.";

/// Advertise this server via mDNS on the local network.
pub fn advertise(
    name: &str,
    port: u16,
    fingerprint_prefix: &str,
) -> Result<ServiceDaemon, Box<dyn std::error::Error>> {
    let mdns = ServiceDaemon::new()?;

    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let instance_name = format!("{name} ({hostname})");

    let properties = [
        ("version", env!("CARGO_PKG_VERSION")),
        ("name", name),
        ("fingerprint", fingerprint_prefix),
    ];

    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name,
        &format!("{hostname}.local."),
        "",
        port,
        &properties[..],
    )?;

    mdns.register(service)?;

    Ok(mdns)
}
