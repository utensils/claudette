use std::time::Duration;

pub(crate) fn adaptive_tail_delay(active_delay: Duration, empty_reads: u32) -> Duration {
    match empty_reads {
        0..=2 => active_delay,
        3..=9 => Duration::from_millis(250),
        10..=29 => Duration::from_millis(500),
        _ => Duration::from_secs(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_delay_stays_fast_while_output_is_active() {
        assert_eq!(
            adaptive_tail_delay(Duration::from_millis(33), 0),
            Duration::from_millis(33)
        );
        assert_eq!(
            adaptive_tail_delay(Duration::from_millis(100), 2),
            Duration::from_millis(100)
        );
    }

    #[test]
    fn tail_delay_backs_off_after_empty_reads() {
        assert_eq!(
            adaptive_tail_delay(Duration::from_millis(33), 3),
            Duration::from_millis(250)
        );
        assert_eq!(
            adaptive_tail_delay(Duration::from_millis(33), 10),
            Duration::from_millis(500)
        );
        assert_eq!(
            adaptive_tail_delay(Duration::from_millis(33), 30),
            Duration::from_secs(1)
        );
    }
}
