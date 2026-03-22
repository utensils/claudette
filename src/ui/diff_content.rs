use iced::widget::{Space, column, container, row, scrollable, text};
use iced::{Background, Element, Fill, Length, Theme};

use crate::message::Message;
use crate::model::diff::{DiffLine, DiffLineType, DiffViewMode, FileDiff};
use crate::ui::style;

pub fn view_diff_content<'a>(diff: &'a FileDiff, view_mode: DiffViewMode) -> Element<'a, Message> {
    if diff.is_binary {
        return container(text("Binary file changed").size(14).color(style::MUTED))
            .width(Fill)
            .height(Fill)
            .center_x(Fill)
            .center_y(Fill)
            .into();
    }

    if diff.hunks.is_empty() {
        return container(text("No changes").size(14).color(style::MUTED))
            .width(Fill)
            .height(Fill)
            .center_x(Fill)
            .center_y(Fill)
            .into();
    }

    let content = match view_mode {
        DiffViewMode::Unified => view_unified(diff),
        DiffViewMode::SideBySide => view_side_by_side(diff),
    };

    scrollable(container(content).padding([0, 8]))
        .width(Fill)
        .height(Fill)
        .into()
}

fn view_unified(diff: &FileDiff) -> Element<'_, Message> {
    let mut lines = column![].spacing(0);

    for hunk in &diff.hunks {
        // Hunk header
        lines = lines.push(
            container(
                text(&hunk.header)
                    .size(12)
                    .color(style::DIFF_HUNK_HEADER)
                    .font(iced::Font::MONOSPACE),
            )
            .width(Fill)
            .padding([4, 8])
            .style(|_theme: &Theme| container::Style {
                background: Some(Background::Color(style::HOVER_BG_SUBTLE)),
                ..Default::default()
            }),
        );

        for line in &hunk.lines {
            lines = lines.push(view_unified_line(line));
        }
    }

    lines.into()
}

fn view_unified_line(line: &DiffLine) -> Element<'_, Message> {
    let old_ln = line
        .old_line_number
        .map(|n| format!("{n:>4}"))
        .unwrap_or_else(|| "    ".to_string());
    let new_ln = line
        .new_line_number
        .map(|n| format!("{n:>4}"))
        .unwrap_or_else(|| "    ".to_string());

    let (prefix, text_color, bg_color) = match line.line_type {
        DiffLineType::Added => ("+", style::DIFF_ADDED_TEXT, style::DIFF_ADDED_BG),
        DiffLineType::Removed => ("-", style::DIFF_REMOVED_TEXT, style::DIFF_REMOVED_BG),
        DiffLineType::Context => (" ", style::TEXT, iced::Color::TRANSPARENT),
    };

    let line_content = format!("{prefix}{}", line.content);

    container(
        row![
            text(old_ln)
                .size(12)
                .color(style::DIFF_LINE_NUMBER)
                .font(iced::Font::MONOSPACE)
                .width(Length::Fixed(40.0)),
            text(new_ln)
                .size(12)
                .color(style::DIFF_LINE_NUMBER)
                .font(iced::Font::MONOSPACE)
                .width(Length::Fixed(40.0)),
            Space::new().width(4),
            text(line_content)
                .size(13)
                .color(text_color)
                .font(iced::Font::MONOSPACE),
        ]
        .align_y(iced::Alignment::Center),
    )
    .width(Fill)
    .padding([1, 8])
    .style(move |_theme: &Theme| container::Style {
        background: Some(Background::Color(bg_color)),
        ..Default::default()
    })
    .into()
}

fn view_side_by_side(diff: &FileDiff) -> Element<'_, Message> {
    let mut rows = column![].spacing(0);

    for hunk in &diff.hunks {
        // Hunk header spanning full width
        rows = rows.push(
            container(
                text(&hunk.header)
                    .size(12)
                    .color(style::DIFF_HUNK_HEADER)
                    .font(iced::Font::MONOSPACE),
            )
            .width(Fill)
            .padding([4, 8])
            .style(|_theme: &Theme| container::Style {
                background: Some(Background::Color(style::HOVER_BG_SUBTLE)),
                ..Default::default()
            }),
        );

        let paired = pair_lines_for_side_by_side(&hunk.lines);
        for (left, right) in &paired {
            rows = rows.push(view_side_by_side_row(left, right));
        }
    }

    rows.into()
}

/// Pairs lines for side-by-side display.
/// Context lines appear on both sides. Removed lines go left, added lines go right.
/// Adjacent removed+added blocks are paired together.
fn pair_lines_for_side_by_side(lines: &[DiffLine]) -> Vec<(Option<&DiffLine>, Option<&DiffLine>)> {
    let mut result = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        match lines[i].line_type {
            DiffLineType::Context => {
                result.push((Some(&lines[i]), Some(&lines[i])));
                i += 1;
            }
            DiffLineType::Removed => {
                // Collect consecutive removed lines
                let mut removed = Vec::new();
                while i < lines.len() && lines[i].line_type == DiffLineType::Removed {
                    removed.push(&lines[i]);
                    i += 1;
                }
                // Collect consecutive added lines
                let mut added = Vec::new();
                while i < lines.len() && lines[i].line_type == DiffLineType::Added {
                    added.push(&lines[i]);
                    i += 1;
                }
                // Pair them up
                let max_len = removed.len().max(added.len());
                for j in 0..max_len {
                    let left = removed.get(j).copied();
                    let right = added.get(j).copied();
                    result.push((left, right));
                }
            }
            DiffLineType::Added => {
                // Added without preceding removed
                result.push((None, Some(&lines[i])));
                i += 1;
            }
        }
    }

    result
}

fn view_side_by_side_row<'a>(
    left: &Option<&'a DiffLine>,
    right: &Option<&'a DiffLine>,
) -> Element<'a, Message> {
    row![
        view_sbs_half(left, true),
        container(column![])
            .width(1)
            .height(Fill)
            .style(|_theme: &Theme| container::Style {
                background: Some(Background::Color(style::DIVIDER)),
                ..Default::default()
            }),
        view_sbs_half(right, false),
    ]
    .into()
}

fn view_sbs_half<'a>(line: &Option<&'a DiffLine>, is_left: bool) -> Element<'a, Message> {
    let (ln_text, content_text, text_color, bg_color) = match line {
        Some(l) => {
            let ln = if is_left {
                l.old_line_number
            } else {
                l.new_line_number
            };
            let ln_str = ln
                .map(|n| format!("{n:>4}"))
                .unwrap_or_else(|| "    ".to_string());

            let (tc, bg) = match l.line_type {
                DiffLineType::Added => (style::DIFF_ADDED_TEXT, style::DIFF_ADDED_BG),
                DiffLineType::Removed => (style::DIFF_REMOVED_TEXT, style::DIFF_REMOVED_BG),
                DiffLineType::Context => (style::TEXT, iced::Color::TRANSPARENT),
            };

            (ln_str, l.content.clone(), tc, bg)
        }
        None => (
            "    ".to_string(),
            String::new(),
            style::FAINT,
            style::HOVER_BG_SUBTLE,
        ),
    };

    container(
        row![
            text(ln_text)
                .size(12)
                .color(style::DIFF_LINE_NUMBER)
                .font(iced::Font::MONOSPACE)
                .width(Length::Fixed(40.0)),
            Space::new().width(4),
            text(content_text)
                .size(13)
                .color(text_color)
                .font(iced::Font::MONOSPACE),
        ]
        .align_y(iced::Alignment::Center),
    )
    .width(Fill)
    .padding([1, 4])
    .style(move |_theme: &Theme| container::Style {
        background: Some(Background::Color(bg_color)),
        ..Default::default()
    })
    .into()
}

/// Renders a placeholder when no file is selected, or while loading.
pub fn view_diff_placeholder(message: &str) -> Element<'_, Message> {
    container(text(message).size(14).color(style::MUTED))
        .width(Fill)
        .height(Fill)
        .center_x(Fill)
        .center_y(Fill)
        .into()
}
