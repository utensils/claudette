use std::collections::HashMap;

use iced::widget::{Column, Space, center, column, container, markdown, text};
use iced::{Element, Fill};
use iced_term::Terminal;

use crate::message::{DividerDrag, Message};
use crate::model::diff::{DiffFile, DiffViewMode, FileDiff};
use crate::model::{AgentStatus, ChatMessage, Repository, TerminalTab, Workspace};
use crate::ui::{chat_panel, diff_viewer, divider, style, terminal_panel};

#[allow(clippy::too_many_arguments)]
pub fn view_main_content<'a>(
    repositories: &'a [Repository],
    workspaces: &'a [Workspace],
    selected_workspace: Option<&str>,
    chat_messages: &'a [ChatMessage],
    chat_input: &str,
    streaming_text: &'a str,
    markdown_items: &'a [Vec<markdown::Item>],
    // Diff state
    diff_files: &'a [DiffFile],
    diff_selected_file: Option<&'a str>,
    diff_content: Option<&'a FileDiff>,
    diff_view_mode: DiffViewMode,
    diff_loading: bool,
    diff_error: Option<&'a str>,
    // Terminal state
    terminals: &'a HashMap<u64, Terminal>,
    terminal_tabs: &[TerminalTab],
    active_terminal_tab: Option<u64>,
    terminal_panel_visible: bool,
    terminal_height: f32,
) -> Element<'a, Message> {
    let content: Element<'_, Message> = if let Some(ws_id) = selected_workspace {
        if let Some(ws) = workspaces.iter().find(|w| w.id == ws_id) {
            // Decide top content: diff content or chat
            let top_content: Element<'_, Message> = if diff_selected_file.is_some() {
                diff_viewer::view_diff_content_panel(
                    diff_files,
                    diff_selected_file,
                    diff_content,
                    diff_view_mode,
                    diff_loading,
                    diff_error,
                )
            } else {
                let is_running = ws.agent_status == AgentStatus::Running;
                chat_panel::view_chat_panel(
                    ws,
                    repositories,
                    chat_messages,
                    chat_input,
                    streaming_text,
                    markdown_items,
                    is_running,
                )
            };

            let terminal = terminal_panel::view_terminal_panel(
                terminals,
                terminal_tabs,
                active_terminal_tab,
                terminal_panel_visible,
                ws_id,
                terminal_height,
            );

            let mut col = Column::new()
                .push(container(top_content).width(Fill).height(Fill))
                .width(Fill)
                .height(Fill);

            // Add horizontal divider + terminal if terminal is visible and has tabs
            if terminal_panel_visible && !terminal_tabs.is_empty() {
                col = col
                    .push(divider::horizontal_divider(DividerDrag::Terminal))
                    .push(terminal);
            }

            col.into()
        } else {
            center(text("Workspace not found").size(16).color(style::FAINT)).into()
        }
    } else {
        center(
            column![
                text("Claudette").size(28),
                Space::new().height(8),
                text("Select a workspace to get started")
                    .size(16)
                    .color(style::FAINT),
            ]
            .align_x(iced::Alignment::Center),
        )
        .into()
    };

    container(content).width(Fill).height(Fill).into()
}
