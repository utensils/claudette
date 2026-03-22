use iced::Color;

// Sidebar
pub const SIDEBAR_BG: Color = Color::from_rgb(0.1, 0.1, 0.12);
pub const SIDEBAR_BORDER: Color = Color::from_rgb(0.18, 0.18, 0.22);
pub const SIDEBAR_WIDTH: f32 = 260.0;

// Text
pub const TEXT: Color = Color::from_rgb(0.9, 0.9, 0.92);
pub const MUTED: Color = Color::from_rgb(0.5, 0.5, 0.55);
pub const DIM: Color = Color::from_rgb(0.45, 0.45, 0.5);
pub const FAINT: Color = Color::from_rgb(0.4, 0.4, 0.45);
pub const SEPARATOR: Color = Color::from_rgb(0.35, 0.35, 0.4);
pub const DIVIDER: Color = Color::from_rgb(0.2, 0.2, 0.24);

// Interactive
pub const HOVER_BG: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.05);
pub const HOVER_BG_SUBTLE: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.04);
pub const SELECTED_BG: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.08);

// Filter tabs
pub const FILTER_ACTIVE: Color = Color::from_rgb(0.8, 0.8, 0.85);
pub const FILTER_ACTIVE_BG: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.08);

// Modal
pub const BACKDROP: Color = Color::from_rgba(0.0, 0.0, 0.0, 0.6);
pub const MODAL_BG: Color = Color::from_rgb(0.15, 0.15, 0.18);
pub const MODAL_BORDER: Color = Color::from_rgb(0.25, 0.25, 0.3);

// Agent status
pub const STATUS_RUNNING: Color = Color::from_rgb(0.2, 0.8, 0.3);
pub const STATUS_IDLE: Color = Color::from_rgb(0.5, 0.5, 0.5);
pub const STATUS_STOPPED: Color = Color::from_rgb(0.8, 0.2, 0.2);

// Error / Warning
pub const ERROR: Color = Color::from_rgb(0.9, 0.3, 0.3);
pub const WARNING: Color = Color::from_rgb(0.9, 0.7, 0.2);

// Tooltip
pub const TOOLTIP_BG: Color = Color::from_rgb(0.2, 0.2, 0.24);
pub const TOOLTIP_BORDER: Color = Color::from_rgb(0.3, 0.3, 0.35);

use iced::{Background, Border, Theme};

pub fn tooltip_style(_theme: &Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(Background::Color(TOOLTIP_BG)),
        border: Border {
            radius: 4.0.into(),
            width: 1.0,
            color: TOOLTIP_BORDER,
        },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

use crate::model::AgentStatus;

pub fn agent_status_color(status: &AgentStatus) -> Color {
    match status {
        AgentStatus::Running => STATUS_RUNNING,
        AgentStatus::Idle => STATUS_IDLE,
        AgentStatus::Stopped => STATUS_STOPPED,
    }
}
