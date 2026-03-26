pub mod chat_panel;
mod diff_content;
mod diff_file_tree;
pub mod diff_viewer;
pub mod divider;
mod fuzzy_finder;
mod icon_picker;
mod main_content;
mod modal;
mod right_sidebar;
mod sidebar;
mod status_bar;
pub mod style;
pub mod terminal_panel;

pub use fuzzy_finder::view_fuzzy_finder;
pub use icon_picker::view_icon_picker;
pub use main_content::view_main_content;
pub use modal::{
    view_add_repo_modal, view_app_settings_modal, view_create_workspace_modal,
    view_delete_workspace_modal, view_relink_repo_modal, view_remove_repo_modal,
    view_repo_settings_modal, view_revert_file_modal,
};
pub use right_sidebar::view_right_sidebar;
pub use sidebar::view_sidebar;
pub use status_bar::view_status_bar;
