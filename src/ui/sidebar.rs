use std::collections::HashMap;

use iced::widget::{Column, Space, button, column, container, row, scrollable, text, tooltip};
use iced::{Background, Border, Element, Fill, Padding, Theme};

use crate::message::{Message, SidebarFilter};
use crate::model::{Repository, Workspace, WorkspaceStatus};
use crate::ui::style;

pub fn view_sidebar<'a>(
    repositories: &'a [Repository],
    workspaces: &'a [Workspace],
    selected_workspace: Option<&str>,
    filter: &'a SidebarFilter,
    repo_collapsed: &HashMap<String, bool>,
) -> Element<'a, Message> {
    let mut content = Column::new().spacing(4).padding([12, 0]);

    // Header
    content = content.push(
        container(text("Workspaces").size(12).color(style::MUTED)).padding(Padding {
            top: 0.0,
            right: 16.0,
            bottom: 4.0,
            left: 16.0,
        }),
    );

    // Filter tabs
    content = content.push(view_filter_tabs(filter));

    // Filter workspaces
    let filtered: Vec<&Workspace> = workspaces
        .iter()
        .filter(|ws| match filter {
            SidebarFilter::All => true,
            SidebarFilter::Active => ws.status == WorkspaceStatus::Active,
            SidebarFilter::Archived => ws.status == WorkspaceStatus::Archived,
        })
        .collect();

    // Repo groups
    for repo in repositories {
        let repo_workspaces: Vec<&&Workspace> = filtered
            .iter()
            .filter(|w| w.repository_id == repo.id)
            .collect();
        if !repo_workspaces.is_empty() || matches!(filter, SidebarFilter::All) {
            let collapsed = repo_collapsed.get(&repo.id).copied().unwrap_or(false);
            content = content.push(view_repo_group(
                repo,
                &repo_workspaces,
                selected_workspace,
                collapsed,
            ));
        }
    }

    // Spacer to push "Add Repo" to bottom
    content = content.push(Space::new().height(Fill));

    // Divider
    content = content.push(
        container(column![])
            .width(Fill)
            .height(1)
            .style(|_theme: &Theme| container::Style {
                background: Some(Background::Color(style::DIVIDER)),
                ..Default::default()
            }),
    );

    // Add repo button
    content = content.push(
        button(
            row![
                text("+").size(16),
                Space::new().width(6),
                text("Add repository").size(14),
            ]
            .align_y(iced::Alignment::Center),
        )
        .on_press(Message::ShowAddRepo)
        .style(|theme: &Theme, status| {
            let mut style = button::text(theme, status);
            style.text_color = style::MUTED;
            style
        })
        .padding([10, 16])
        .width(Fill),
    );

    container(scrollable(content).height(Fill))
        .width(style::SIDEBAR_WIDTH)
        .height(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::SIDEBAR_BG)),
            border: Border {
                width: 1.0,
                color: style::SIDEBAR_BORDER,
                ..Default::default()
            },
            ..Default::default()
        })
        .into()
}

fn view_filter_tabs<'a>(active: &'a SidebarFilter) -> Element<'a, Message> {
    let tab = |label: &'a str, filter: SidebarFilter| -> Element<'a, Message> {
        let is_active = matches!(
            (active, &filter),
            (SidebarFilter::All, SidebarFilter::All)
                | (SidebarFilter::Active, SidebarFilter::Active)
                | (SidebarFilter::Archived, SidebarFilter::Archived)
        );
        let color = if is_active {
            style::FILTER_ACTIVE
        } else {
            style::MUTED
        };
        button(text(label).size(11).color(color))
            .on_press(Message::SetSidebarFilter(filter))
            .style(move |theme: &Theme, status| {
                let mut s = button::text(theme, status);
                if is_active {
                    s.background = Some(Background::Color(style::FILTER_ACTIVE_BG));
                    s.border = Border {
                        radius: 4.0.into(),
                        ..Default::default()
                    };
                }
                s
            })
            .padding([4, 8])
            .into()
    };

    container(
        row![
            tab("All", SidebarFilter::All),
            tab("Active", SidebarFilter::Active),
            tab("Archived", SidebarFilter::Archived),
        ]
        .spacing(4),
    )
    .padding(Padding {
        top: 0.0,
        right: 16.0,
        bottom: 8.0,
        left: 16.0,
    })
    .into()
}

fn view_repo_group<'a>(
    repo: &'a Repository,
    workspaces: &[&&'a Workspace],
    selected_workspace: Option<&str>,
    collapsed: bool,
) -> Element<'a, Message> {
    let chevron = if collapsed { "\u{25B6}" } else { "\u{25BC}" };

    let repo_id = repo.id.clone();
    let repo_id_for_create = repo.id.clone();
    let header = row![
        button(
            row![
                text(chevron).size(10).color(style::MUTED),
                Space::new().width(6),
                text(&repo.name).size(14),
            ]
            .align_y(iced::Alignment::Center),
        )
        .on_press(Message::ToggleRepoCollapsed(repo_id))
        .style(|theme: &Theme, status| {
            let mut s = button::text(theme, status);
            if matches!(status, button::Status::Hovered) {
                s.background = Some(Background::Color(style::HOVER_BG));
            }
            s
        })
        .padding([6, 8])
        .width(Fill),
        tooltip(
            button(text("+").size(14).color(style::MUTED))
                .on_press(Message::ShowCreateWorkspace(repo_id_for_create))
                .style(|theme: &Theme, status| {
                    let mut s = button::text(theme, status);
                    if matches!(status, button::Status::Hovered) {
                        s.background = Some(Background::Color(style::HOVER_BG));
                    }
                    s.border = Border {
                        radius: 4.0.into(),
                        ..Default::default()
                    };
                    s
                })
                .padding([4, 8]),
            "New workspace",
            tooltip::Position::Bottom,
        )
        .style(style::tooltip_style),
    ]
    .padding(Padding {
        top: 0.0,
        right: 8.0,
        bottom: 0.0,
        left: 8.0,
    })
    .align_y(iced::Alignment::Center);

    let mut group = Column::new().push(header);

    if !collapsed {
        for ws in workspaces {
            group = group.push(view_workspace_entry(ws, selected_workspace));
        }
    }

    group.into()
}

fn view_workspace_entry<'a>(
    ws: &'a Workspace,
    selected_workspace: Option<&str>,
) -> Element<'a, Message> {
    let is_selected = selected_workspace == Some(ws.id.as_str());
    let is_archived = ws.status == WorkspaceStatus::Archived;

    let status_dot = text("\u{25CF}")
        .size(10)
        .color(style::agent_status_color(&ws.agent_status));

    let name_color = if is_archived { style::DIM } else { style::TEXT };

    let mut info = column![
        text(&ws.name).size(13).color(name_color),
        text(&ws.branch_name).size(11).color(style::DIM),
    ]
    .spacing(2);

    if !is_archived {
        info = info.push(row![
            text(ws.agent_status.label())
                .size(11)
                .color(style::agent_status_color(&ws.agent_status)),
            text(" \u{2022} ").size(11).color(style::SEPARATOR),
            text(&ws.status_line).size(11).color(style::FAINT),
        ]);
    } else {
        info = info.push(text("Archived").size(11).color(style::FAINT));
    }

    // Action buttons
    let ws_id = ws.id.clone();
    let action = if is_archived {
        row![
            tooltip(
                button(text("\u{21BB}").size(11).color(style::MUTED))
                    .on_press(Message::RestoreWorkspace(ws_id.clone()))
                    .style(|theme: &Theme, status| {
                        let mut s = button::text(theme, status);
                        if matches!(status, button::Status::Hovered) {
                            s.background = Some(Background::Color(style::HOVER_BG));
                        }
                        s.border = Border {
                            radius: 4.0.into(),
                            ..Default::default()
                        };
                        s
                    })
                    .padding([2, 6]),
                "Restore",
                tooltip::Position::Bottom,
            )
            .style(style::tooltip_style),
            tooltip(
                button(text("\u{2715}").size(11).color(style::MUTED))
                    .on_press(Message::DeleteWorkspace(ws_id.clone()))
                    .style(|theme: &Theme, status| {
                        let mut s = button::text(theme, status);
                        if matches!(status, button::Status::Hovered) {
                            s.background = Some(Background::Color(style::HOVER_BG));
                        }
                        s.border = Border {
                            radius: 4.0.into(),
                            ..Default::default()
                        };
                        s
                    })
                    .padding([2, 6]),
                "Delete",
                tooltip::Position::Bottom,
            )
            .style(style::tooltip_style),
        ]
        .spacing(2)
    } else {
        row![
            tooltip(
                button(text("\u{2193}").size(11).color(style::MUTED))
                    .on_press(Message::ArchiveWorkspace(ws_id.clone()))
                    .style(|theme: &Theme, status| {
                        let mut s = button::text(theme, status);
                        if matches!(status, button::Status::Hovered) {
                            s.background = Some(Background::Color(style::HOVER_BG));
                        }
                        s.border = Border {
                            radius: 4.0.into(),
                            ..Default::default()
                        };
                        s
                    })
                    .padding([2, 6]),
                "Archive",
                tooltip::Position::Bottom,
            )
            .style(style::tooltip_style),
        ]
        .spacing(2)
    };

    let entry_content = row![
        container(status_dot).padding(Padding {
            top: 2.0,
            right: 0.0,
            bottom: 0.0,
            left: 0.0,
        }),
        Space::new().width(8),
        column![info].width(Fill),
        action,
    ]
    .align_y(iced::Alignment::Start);

    let bg = if is_selected {
        Some(Background::Color(style::SELECTED_BG))
    } else {
        None
    };

    button(entry_content)
        .on_press(Message::SelectWorkspace(ws_id))
        .style(move |theme: &Theme, status| {
            let mut s = button::text(theme, status);
            if matches!(status, button::Status::Hovered) && !is_selected {
                s.background = Some(Background::Color(style::HOVER_BG_SUBTLE));
            } else {
                s.background = bg;
            }
            s
        })
        .padding(Padding {
            top: 8.0,
            right: 12.0,
            bottom: 8.0,
            left: 28.0,
        })
        .width(Fill)
        .into()
}
