//! Availability checks for the supported interactive hosts.
//!
//! These checks cache their result for 30 seconds to avoid shelling out on
//! every operation.

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxAvailability {
    /// tmux >= 3.0 found on PATH.
    Available { version: String },
    /// tmux found but too old.
    TooOld { version: String, minimum: String },
    /// tmux not on PATH.
    NotFound,
}

const TTL: Duration = Duration::from_secs(30);

struct CachedTmux {
    at: Instant,
    value: TmuxAvailability,
}

static TMUX_CACHE: Mutex<Option<CachedTmux>> = Mutex::new(None);

/// Returns the cached `tmux` availability, refreshing it if the cached value is
/// older than the 30-second TTL.
///
/// # Panics
///
/// Panics if the internal cache mutex has been poisoned by a previous panic.
pub async fn check_tmux() -> TmuxAvailability {
    {
        let g = TMUX_CACHE.lock().expect("poisoned");
        if let Some(c) = g.as_ref()
            && c.at.elapsed() < TTL
        {
            return c.value.clone();
        }
    }
    let v = check_tmux_uncached().await;
    let mut g = TMUX_CACHE.lock().expect("poisoned");
    *g = Some(CachedTmux {
        at: Instant::now(),
        value: v.clone(),
    });
    v
}

async fn check_tmux_uncached() -> TmuxAvailability {
    let out = tokio::process::Command::new("tmux")
        .arg("-V")
        .output()
        .await;
    let Ok(out) = out else {
        return TmuxAvailability::NotFound;
    };
    if !out.status.success() {
        return TmuxAvailability::NotFound;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    // tmux -V prints e.g. "tmux 3.4"
    let ver = s.split_whitespace().nth(1).unwrap_or("").to_string();
    if version_at_least(&ver, 3, 0) {
        TmuxAvailability::Available { version: ver }
    } else {
        TmuxAvailability::TooOld {
            version: ver,
            minimum: "3.0".into(),
        }
    }
}

fn version_at_least(ver: &str, want_major: u32, want_minor: u32) -> bool {
    let mut parts = ver.split('.');
    let major = parts
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .unwrap_or(0);
    let minor = parts
        .next()
        .and_then(|p| {
            p.trim_end_matches(|c: char| !c.is_ascii_digit())
                .parse::<u32>()
                .ok()
        })
        .unwrap_or(0);
    (major, minor) >= (want_major, want_minor)
}

/// Clear the tmux cache (test-only helper).
#[cfg(test)]
pub fn clear_tmux_cache_for_test() {
    *TMUX_CACHE.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_at_least_examples() {
        assert!(version_at_least("3.4", 3, 0));
        assert!(version_at_least("3.0", 3, 0));
        assert!(!version_at_least("2.9", 3, 0));
        assert!(!version_at_least("", 3, 0));
        assert!(version_at_least("3.4a", 3, 0));
    }

    #[tokio::test]
    async fn check_tmux_cache_is_stable_within_ttl() {
        clear_tmux_cache_for_test();
        let a = check_tmux().await;
        let b = check_tmux().await;
        assert_eq!(a, b);
    }
}
