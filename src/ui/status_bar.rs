use iced::widget::{Space, button, container, row};
use iced::{Background, Border, Color, Element, Fill, Length, Theme};

use crate::message::Message;
use crate::ui::style;

pub fn view_status_bar(
    left_sidebar_visible: bool,
    terminal_visible: bool,
    right_sidebar_visible: bool,
) -> Element<'static, Message> {
    let icons = row![
        panel_toggle_icon(
            PanelLayout::Left,
            left_sidebar_visible,
            Message::ToggleSidebar,
        ),
        panel_toggle_icon(
            PanelLayout::Bottom,
            terminal_visible,
            Message::TerminalTogglePanel,
        ),
        panel_toggle_icon(
            PanelLayout::Right,
            right_sidebar_visible,
            Message::ToggleRightSidebar,
        ),
    ]
    .spacing(4)
    .align_y(iced::Alignment::Center);

    let bar = row![Space::new().width(Fill), icons]
        .align_y(iced::Alignment::Center)
        .padding([0, 6]);

    container(bar)
        .width(Fill)
        .height(style::STATUS_BAR_HEIGHT)
        .center_y(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::STATUS_BAR_BG)),
            border: Border {
                width: 0.0,
                color: style::DIVIDER,
                radius: 0.0.into(),
            },
            ..Default::default()
        })
        .into()
}

enum PanelLayout {
    Left,
    Bottom,
    Right,
}

/// Builds a small ~18x14 icon using nested containers to mimic VS Code panel toggles.
/// The highlighted portion indicates which panel the icon controls.
fn panel_toggle_icon(
    layout: PanelLayout,
    is_active: bool,
    message: Message,
) -> Element<'static, Message> {
    let active_color = if is_active {
        style::TOGGLE_ICON_ACTIVE
    } else {
        style::TOGGLE_ICON_INACTIVE
    };
    let inactive_color = style::TOGGLE_ICON_INACTIVE;

    let icon: Element<'static, Message> = match layout {
        PanelLayout::Left => {
            // Left portion highlighted: [##|    ]
            let left = colored_block(active_color, 5.0, 10.0);
            let right = colored_block(inactive_color, 11.0, 10.0);
            row![left, right].spacing(1).into()
        }
        PanelLayout::Bottom => {
            // Bottom portion highlighted: [      ]
            //                             [######]
            let top = colored_block(inactive_color, 17.0, 5.0);
            let bottom = colored_block(active_color, 17.0, 4.0);
            iced::widget::column![top, bottom].spacing(1).into()
        }
        PanelLayout::Right => {
            // Right portion highlighted: [    |##]
            let left = colored_block(inactive_color, 11.0, 10.0);
            let right = colored_block(active_color, 5.0, 10.0);
            row![left, right].spacing(1).into()
        }
    };

    button(container(icon).style(|_theme: &Theme| container::Style {
        border: Border {
            width: 1.0,
            color: style::TOGGLE_ICON_BORDER,
            radius: 2.0.into(),
        },
        ..Default::default()
    }))
    .on_press(message)
    .padding([2, 3])
    .style(|_theme: &Theme, _status| button::Style {
        background: None,
        text_color: Color::TRANSPARENT,
        ..Default::default()
    })
    .into()
}

fn colored_block(color: Color, width: f32, height: f32) -> Element<'static, Message> {
    container(Space::new())
        .width(Length::Fixed(width))
        .height(Length::Fixed(height))
        .style(move |_theme: &Theme| container::Style {
            background: Some(Background::Color(color)),
            border: Border {
                radius: 1.0.into(),
                ..Default::default()
            },
            ..Default::default()
        })
        .into()
}
