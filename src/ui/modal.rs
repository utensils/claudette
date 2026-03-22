use iced::widget::{
    Space, button, center, column, container, mouse_area, opaque, row, text, text_input,
};
use iced::{Background, Border, Element, Fill, Theme};

use crate::message::Message;
use crate::ui::style;

fn modal_backdrop<'a>(
    base: Element<'a, Message>,
    card: Element<'a, Message>,
    on_dismiss: Message,
) -> Element<'a, Message> {
    let backdrop: Element<'_, Message> = mouse_area(
        container(column![])
            .width(Fill)
            .height(Fill)
            .style(|_theme: &Theme| container::Style {
                background: Some(Background::Color(style::BACKDROP)),
                ..Default::default()
            }),
    )
    .on_press(on_dismiss)
    .into();

    let overlay = center(opaque(card)).width(Fill).height(Fill);

    iced::widget::stack![base, backdrop, overlay].into()
}

fn modal_card(content: Element<'_, Message>) -> Element<'_, Message> {
    container(content)
        .width(460)
        .padding(24)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::MODAL_BG)),
            border: Border {
                radius: 8.0.into(),
                width: 1.0,
                color: style::MODAL_BORDER,
            },
            ..Default::default()
        })
        .into()
}

pub fn view_add_repo_modal<'a>(
    base: Element<'a, Message>,
    path_input: &str,
    error: Option<&String>,
) -> Element<'a, Message> {
    let mut content = column![
        text("Add Repository").size(20),
        row![
            text_input("Repository path", path_input)
                .on_input(Message::AddRepoPathChanged)
                .on_submit(Message::ConfirmAddRepo)
                .padding(10)
                .size(16)
                .width(Fill),
            Space::new().width(8),
            button(text("Browse").size(14))
                .on_press(Message::BrowseRepoPath)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([10, 16]),
        ]
        .align_y(iced::Alignment::Center),
    ]
    .spacing(12);

    if let Some(err) = error {
        content = content.push(text(err.clone()).size(14).color(style::ERROR));
    }

    content = content.push(
        row![
            button(text("Cancel").size(14))
                .on_press(Message::HideAddRepo)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
            Space::new().width(8),
            button(text("Add").size(14))
                .on_press(Message::ConfirmAddRepo)
                .style(|theme: &Theme, status| {
                    let mut s = button::primary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
        ]
        .align_y(iced::Alignment::Center),
    );

    modal_backdrop(base, modal_card(content.into()), Message::HideAddRepo)
}

pub fn view_create_workspace_modal<'a>(
    base: Element<'a, Message>,
    repo_name: &str,
    name_input: &str,
    error: Option<&String>,
) -> Element<'a, Message> {
    let branch_preview = if name_input.trim().is_empty() {
        "claudette/<name>".to_string()
    } else {
        format!("claudette/{}", name_input.trim())
    };

    let mut content = column![
        text("New Workspace").size(20),
        text(format!("Repository: {repo_name}"))
            .size(14)
            .color(style::DIM),
        row![
            text_input("Workspace name", name_input)
                .on_input(Message::CreateWorkspaceNameChanged)
                .on_submit(Message::ConfirmCreateWorkspace)
                .padding(10)
                .size(16)
                .width(Fill),
            Space::new().width(8),
            button(text("\u{21BB}").size(16).color(style::MUTED))
                .on_press(Message::RegenerateWorkspaceName)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([10, 12]),
        ]
        .align_y(iced::Alignment::Center),
        text(format!("Branch: {branch_preview}"))
            .size(12)
            .color(style::FAINT),
    ]
    .spacing(12);

    if let Some(err) = error {
        content = content.push(text(err.clone()).size(14).color(style::ERROR));
    }

    content = content.push(
        row![
            button(text("Cancel").size(14))
                .on_press(Message::HideCreateWorkspace)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
            Space::new().width(8),
            button(text("Create").size(14))
                .on_press(Message::ConfirmCreateWorkspace)
                .style(|theme: &Theme, status| {
                    let mut s = button::primary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
        ]
        .align_y(iced::Alignment::Center),
    );

    modal_backdrop(
        base,
        modal_card(content.into()),
        Message::HideCreateWorkspace,
    )
}

pub fn view_delete_workspace_modal<'a>(
    base: Element<'a, Message>,
    ws_name: &str,
) -> Element<'a, Message> {
    let content = column![
        text("Delete Workspace").size(20),
        text(format!(
            "Are you sure you want to delete \"{ws_name}\"? The git branch will be kept if it has unmerged commits."
        ))
        .size(14)
        .color(style::DIM),
        row![
            button(text("Cancel").size(14))
                .on_press(Message::HideDeleteWorkspace)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
            Space::new().width(8),
            button(text("Delete").size(14).color(style::ERROR))
                .on_press(Message::ConfirmDeleteWorkspace)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
        ]
        .align_y(iced::Alignment::Center),
    ]
    .spacing(12);

    modal_backdrop(
        base,
        modal_card(content.into()),
        Message::HideDeleteWorkspace,
    )
}

pub fn view_relink_repo_modal<'a>(
    base: Element<'a, Message>,
    repo_name: &str,
    path_input: &str,
    error: Option<&String>,
) -> Element<'a, Message> {
    let mut content = column![
        text("Re-link Repository").size(20),
        text(format!(
            "The path for \"{repo_name}\" is no longer valid. Enter the new location:"
        ))
        .size(14)
        .color(style::DIM),
        row![
            text_input("New repository path", path_input)
                .on_input(Message::RelinkRepoPathChanged)
                .on_submit(Message::ConfirmRelinkRepo)
                .padding(10)
                .size(16)
                .width(Fill),
            Space::new().width(8),
            button(text("Browse").size(14))
                .on_press(Message::BrowseRelinkPath)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([10, 16]),
        ]
        .align_y(iced::Alignment::Center),
    ]
    .spacing(12);

    if let Some(err) = error {
        content = content.push(text(err.clone()).size(14).color(style::ERROR));
    }

    content = content.push(
        row![
            button(text("Cancel").size(14))
                .on_press(Message::HideRelinkRepo)
                .style(|theme: &Theme, status| {
                    let mut s = button::secondary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
            Space::new().width(8),
            button(text("Re-link").size(14))
                .on_press(Message::ConfirmRelinkRepo)
                .style(|theme: &Theme, status| {
                    let mut s = button::primary(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([8, 16]),
        ]
        .align_y(iced::Alignment::Center),
    );

    modal_backdrop(base, modal_card(content.into()), Message::HideRelinkRepo)
}
