use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde::Serialize;

/// Kind of native slash command. Only set for entries produced by the native
/// registry; file-based commands (user/project/plugin) leave this as `None`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeKind {
    /// Mutates local UI state without contacting the agent.
    LocalAction,
    /// Opens a settings route/panel.
    SettingsRoute,
    /// Expands into seeded prompt text that then flows through the agent pipeline.
    PromptExpansion,
}

/// A discovered slash command or skill.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    /// Where the command was found: "builtin", "user", "project", or "plugin".
    pub source: String,
    /// Alternative names that resolve to this same canonical command.
    /// Always empty for file-based entries.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Short hint describing the expected argument shape, e.g. `[add|remove] <source>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// Native command kind. `None` for file-based commands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<NativeKind>,
}

impl SlashCommand {
    fn file_based(name: String, description: String, source: &str) -> Self {
        SlashCommand {
            name,
            description,
            source: source.to_string(),
            aliases: Vec::new(),
            argument_hint: None,
            kind: None,
        }
    }
}

/// Build the registry of native slash commands.
///
/// Each entry is fully described here (canonical name, aliases, argument hint, kind).
/// The matching frontend `NATIVE_HANDLERS` table binds handler functions to these
/// canonical names.
pub fn native_command_registry(plugin_management_enabled: bool) -> Vec<SlashCommand> {
    let mut commands = Vec::new();
    if plugin_management_enabled {
        commands.push(SlashCommand {
            name: "plugin".to_string(),
            description: "Browse and manage plugins in settings".to_string(),
            source: "builtin".to_string(),
            aliases: vec!["plugins".to_string()],
            argument_hint: Some(
                "[install|enable|disable|uninstall|update|manage|browse|marketplace …]".to_string(),
            ),
            kind: Some(NativeKind::SettingsRoute),
        });
        commands.push(SlashCommand {
            name: "marketplace".to_string(),
            description: "Manage plugin marketplaces in settings".to_string(),
            source: "builtin".to_string(),
            aliases: Vec::new(),
            argument_hint: Some("[add|remove|update] <source>".to_string()),
            kind: Some(NativeKind::SettingsRoute),
        });
    }
    commands.push(SlashCommand {
        name: "review".to_string(),
        description: "Seed a code review of the current branch against its base".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: Some("[extra focus areas]".to_string()),
        kind: Some(NativeKind::PromptExpansion),
    });
    commands.push(SlashCommand {
        name: "security-review".to_string(),
        description: "Seed a security-focused review of the current branch".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: Some("[extra focus areas]".to_string()),
        kind: Some(NativeKind::PromptExpansion),
    });
    commands.push(SlashCommand {
        name: "pr-comments".to_string(),
        description: "Summarize PR comments for the current branch".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: Some("[PR number or extra guidance]".to_string()),
        kind: Some(NativeKind::PromptExpansion),
    });
    commands.push(SlashCommand {
        name: "config".to_string(),
        description: "Open Claudette settings".to_string(),
        source: "builtin".to_string(),
        aliases: vec!["configure".to_string()],
        argument_hint: Some(
            "[general|models|usage|appearance|notifications|git|plugins|experimental]".to_string(),
        ),
        kind: Some(NativeKind::SettingsRoute),
    });
    commands.push(SlashCommand {
        name: "usage".to_string(),
        description: "Open the Claude Code usage panel".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: None,
        kind: Some(NativeKind::SettingsRoute),
    });
    commands.push(SlashCommand {
        name: "extra-usage".to_string(),
        description: "Manage extra usage on claude.ai".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: None,
        kind: Some(NativeKind::SettingsRoute),
    });
    commands.push(SlashCommand {
        name: "release-notes".to_string(),
        description: "Open Claudette release notes".to_string(),
        source: "builtin".to_string(),
        aliases: vec!["changelog".to_string()],
        argument_hint: None,
        kind: Some(NativeKind::LocalAction),
    });
    commands.push(SlashCommand {
        name: "version".to_string(),
        description: "Show the current Claudette version".to_string(),
        source: "builtin".to_string(),
        aliases: vec!["about".to_string()],
        argument_hint: None,
        kind: Some(NativeKind::LocalAction),
    });
    commands.push(SlashCommand {
        name: "clear".to_string(),
        description: "Clear the current workspace conversation".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: None,
        kind: Some(NativeKind::LocalAction),
    });
    commands.push(SlashCommand {
        name: "plan".to_string(),
        description: "Show, toggle, or open the current plan".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: Some("[on|off|toggle|open]".to_string()),
        kind: Some(NativeKind::LocalAction),
    });
    commands.push(SlashCommand {
        name: "model".to_string(),
        description: "Show or change the workspace model".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: Some("[<model>]".to_string()),
        kind: Some(NativeKind::LocalAction),
    });
    commands.push(SlashCommand {
        name: "permissions".to_string(),
        description: "Show or change the workspace permission mode".to_string(),
        source: "builtin".to_string(),
        aliases: vec!["allowed-tools".to_string()],
        argument_hint: Some("[readonly|standard|full]".to_string()),
        kind: Some(NativeKind::LocalAction),
    });
    commands.push(SlashCommand {
        name: "status".to_string(),
        description: "Show a summary of the current workspace".to_string(),
        source: "builtin".to_string(),
        aliases: Vec::new(),
        argument_hint: None,
        kind: Some(NativeKind::LocalAction),
    });
    commands
}

/// Resolve an input token (command name without the leading `/`) against the native registry,
/// matching canonical names and aliases case-insensitively.
pub fn resolve_native<'a>(token: &str, natives: &'a [SlashCommand]) -> Option<&'a SlashCommand> {
    let needle = token.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return None;
    }
    natives.iter().find(|cmd| {
        cmd.name.to_ascii_lowercase() == needle
            || cmd
                .aliases
                .iter()
                .any(|alias| alias.to_ascii_lowercase() == needle)
    })
}

/// Discover all available slash commands by scanning known Claude Code directories.
///
/// Commands are deduplicated by name with priority: builtin > project > user > plugin.
pub fn discover_slash_commands(
    project_path: Option<&Path>,
    plugin_management_enabled: bool,
) -> Vec<SlashCommand> {
    let mut commands: Vec<SlashCommand> = Vec::new();

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return commands,
    };

    let claude_dir = home.join(".claude");

    // Plugin commands and skills (lowest priority — collected first, deduped later).
    for install_path in crate::plugin::enabled_plugin_install_paths(project_path) {
        collect_plugin_commands(&install_path, &mut commands);
    }

    // User-level commands and skills (medium priority).
    collect_commands_from_dir(&claude_dir.join("commands"), "user", &mut commands);
    collect_skills_from_dir(&claude_dir.join("skills"), "user", &mut commands);

    // Project-level commands (highest priority).
    if let Some(project) = project_path {
        collect_commands_from_dir(&project.join(".claude/commands"), "project", &mut commands);
    }

    // Native app commands must always win.
    collect_native_commands(&mut commands, plugin_management_enabled);

    // Sort by name for consistent ordering.
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginManifestFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    commands: Option<serde_json::Value>,
    #[serde(default)]
    skills: Option<serde_json::Value>,
}

#[derive(Debug)]
struct PluginCommandSpec {
    base_dir: std::path::PathBuf,
    path: std::path::PathBuf,
    explicit_name: Option<String>,
    explicit_description: Option<String>,
}

/// Native command names that always win against file-based commands.
///
/// `plugin`/`marketplace` control plugin management and cannot be shadowed —
/// their aliases are also reserved so the picker never exposes an unreachable
/// duplicate. Other native commands (`config`, `usage`, `version`, `review`, …)
/// use plausible names that users may already have defined as local markdown
/// commands, so they yield to file-based entries when a collision exists.
fn is_reserved_native_name(name: &str) -> bool {
    matches!(name, "plugin" | "plugins" | "marketplace")
}

fn collect_native_commands(commands: &mut Vec<SlashCommand>, plugin_management_enabled: bool) {
    let natives = native_command_registry(plugin_management_enabled);
    // For reserved natives (plugin/marketplace), drop any file-based command
    // whose name collides with the native canonical name or alias: the native
    // registry owns those slots outright.
    commands.retain(|cmd| !is_reserved_native_name(&cmd.name.to_ascii_lowercase()));
    for native in natives {
        let lowered = native.name.to_ascii_lowercase();
        if !is_reserved_native_name(&lowered)
            && commands.iter().any(|existing| {
                existing.name.eq_ignore_ascii_case(&native.name)
                    && matches!(existing.source.as_str(), "user" | "project")
            })
        {
            // A user/project markdown command already owns this slot; the
            // native is non-reserved, so let the custom command win. Plugin
            // commands do NOT get this precedence — only humans editing
            // `.claude/commands/*.md` should be able to override built-ins.
            continue;
        }
        upsert_command(commands, native);
    }
}

/// Scan a directory of `*.md` command files.
fn collect_commands_from_dir(dir: &Path, source: &str, commands: &mut Vec<SlashCommand>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "md")
            && let Some(cmd) = parse_command_file(&path, source)
        {
            upsert_command(commands, cmd);
        }
    }
}

/// Scan a directory of skill subdirectories, each containing `SKILL.md`.
fn collect_skills_from_dir(dir: &Path, source: &str, commands: &mut Vec<SlashCommand>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let skill_file = entry.path().join("SKILL.md");
        if skill_file.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Ok(contents) = std::fs::read_to_string(&skill_file) {
                let description = parse_description(&contents);
                upsert_command(
                    commands,
                    SlashCommand::file_based(name, description, source),
                );
            }
        }
    }
}

fn collect_plugin_commands(install_path: &Path, commands: &mut Vec<SlashCommand>) {
    let manifest = load_plugin_manifest(install_path);
    let plugin_name = manifest
        .as_ref()
        .and_then(|manifest| manifest.name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            install_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "plugin".to_string())
        });

    let mut command_specs = Vec::new();
    let default_commands_dir = install_path.join("commands");
    if default_commands_dir.exists() {
        command_specs.push(PluginCommandSpec {
            base_dir: default_commands_dir.clone(),
            path: default_commands_dir,
            explicit_name: None,
            explicit_description: None,
        });
    }
    if let Some(manifest) = manifest.as_ref() {
        command_specs.extend(parse_manifest_command_specs(install_path, manifest));
    }
    for spec in command_specs {
        collect_plugin_command_path(
            &plugin_name,
            &spec.base_dir,
            &spec.path,
            spec.explicit_name.as_deref(),
            spec.explicit_description.as_deref(),
            commands,
        );
    }

    let mut skill_paths = Vec::new();
    let default_skills_dir = install_path.join("skills");
    if default_skills_dir.exists() {
        skill_paths.push((default_skills_dir.clone(), default_skills_dir));
    }
    if let Some(manifest) = manifest.as_ref() {
        skill_paths.extend(parse_manifest_skill_paths(install_path, manifest));
    }
    for (base_dir, path) in skill_paths {
        collect_plugin_skill_path(&plugin_name, &base_dir, &path, commands);
    }
}

fn load_plugin_manifest(install_path: &Path) -> Option<PluginManifestFile> {
    for path in crate::plugin::plugin_manifest_candidate_paths(install_path) {
        if let Ok(contents) = std::fs::read_to_string(&path)
            && let Ok(manifest) = serde_json::from_str::<PluginManifestFile>(&contents)
        {
            return Some(manifest);
        }
    }
    None
}

fn parse_manifest_command_specs(
    install_path: &Path,
    manifest: &PluginManifestFile,
) -> Vec<PluginCommandSpec> {
    match manifest.commands.as_ref() {
        Some(serde_json::Value::String(path)) => vec![PluginCommandSpec {
            base_dir: install_path.to_path_buf(),
            path: resolve_plugin_relative_path(install_path, path),
            explicit_name: None,
            explicit_description: None,
        }],
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(|path| PluginCommandSpec {
                base_dir: install_path.to_path_buf(),
                path: resolve_plugin_relative_path(install_path, path),
                explicit_name: None,
                explicit_description: None,
            })
            .collect(),
        Some(serde_json::Value::Object(entries)) => entries
            .iter()
            .filter_map(|(name, value)| {
                let value = value.as_object()?;
                let source = value.get("source")?.as_str()?;
                let description = value
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned);
                Some(PluginCommandSpec {
                    base_dir: install_path.to_path_buf(),
                    path: resolve_plugin_relative_path(install_path, source),
                    explicit_name: Some(name.clone()),
                    explicit_description: description,
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_manifest_skill_paths(
    install_path: &Path,
    manifest: &PluginManifestFile,
) -> Vec<(std::path::PathBuf, std::path::PathBuf)> {
    match manifest.skills.as_ref() {
        Some(serde_json::Value::String(path)) => vec![(
            install_path.to_path_buf(),
            resolve_plugin_relative_path(install_path, path),
        )],
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(|path| {
                (
                    install_path.to_path_buf(),
                    resolve_plugin_relative_path(install_path, path),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn resolve_plugin_relative_path(install_path: &Path, raw_path: &str) -> std::path::PathBuf {
    let trimmed = raw_path.strip_prefix("./").unwrap_or(raw_path);
    install_path.join(trimmed)
}

fn collect_plugin_command_path(
    plugin_name: &str,
    base_dir: &Path,
    path: &Path,
    explicit_name: Option<&str>,
    explicit_description: Option<&str>,
    commands: &mut Vec<SlashCommand>,
) {
    if path.is_file() {
        if path.extension().is_some_and(|ext| ext == "md")
            && let Some(mut command) = parse_command_file(path, "plugin")
        {
            command.name = explicit_name
                .map(|name| format!("{plugin_name}:{name}"))
                .unwrap_or_else(|| plugin_markdown_name(plugin_name, base_dir, path));
            if let Some(description) = explicit_description {
                command.description = description.to_string();
            }
            upsert_command(commands, command);
        }
        return;
    }

    if !path.is_dir() {
        return;
    }

    let skill_file = path.join("SKILL.md");
    if skill_file.is_file() {
        if let Ok(contents) = std::fs::read_to_string(&skill_file) {
            let description = explicit_description
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| parse_description(&contents));
            let name = explicit_name
                .map(|name| format!("{plugin_name}:{name}"))
                .unwrap_or_else(|| plugin_skill_name(plugin_name, base_dir, path));
            upsert_command(
                commands,
                SlashCommand::file_based(name, description, "plugin"),
            );
        }
        return;
    }

    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        collect_plugin_command_path(plugin_name, base_dir, &entry.path(), None, None, commands);
    }
}

fn collect_plugin_skill_path(
    plugin_name: &str,
    base_dir: &Path,
    path: &Path,
    commands: &mut Vec<SlashCommand>,
) {
    if !path.exists() {
        return;
    }
    collect_plugin_command_path(plugin_name, base_dir, path, None, None, commands);
}

fn plugin_markdown_name(plugin_name: &str, base_dir: &Path, file_path: &Path) -> String {
    let relative = file_path
        .strip_prefix(base_dir)
        .unwrap_or(file_path)
        .to_path_buf();
    let mut components: Vec<String> = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let filename = components
        .pop()
        .unwrap_or_else(|| "command.md".to_string())
        .trim_end_matches(".md")
        .to_string();
    let mut parts = vec![plugin_name.to_string()];
    parts.extend(components);
    parts.push(filename);
    parts.join(":")
}

fn plugin_skill_name(plugin_name: &str, base_dir: &Path, skill_dir: &Path) -> String {
    let relative = skill_dir
        .strip_prefix(base_dir)
        .unwrap_or(skill_dir)
        .to_path_buf();
    let components: Vec<String> = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let mut parts = vec![plugin_name.to_string()];
    parts.extend(components);
    parts.join(":")
}

/// Parse a `.md` command file into a `SlashCommand`.
fn parse_command_file(path: &Path, source: &str) -> Option<SlashCommand> {
    let name = path.file_stem()?.to_string_lossy().into_owned();
    let contents = std::fs::read_to_string(path).ok()?;
    let description = parse_description(&contents);
    Some(SlashCommand::file_based(name, description, source))
}

/// Extract a description from file contents.
///
/// Checks for YAML frontmatter `description:` field first, then falls back
/// to the first non-empty line of the body.
fn parse_description(contents: &str) -> String {
    if contents.starts_with("---\n") || contents.starts_with("---\r\n") {
        // Find the closing `---`.
        if let Some(end) = contents[3..].find("\n---") {
            let frontmatter = &contents[3..3 + end];
            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("description:") {
                    let desc = rest.trim().trim_matches('"').trim_matches('\'');
                    if !desc.is_empty() {
                        return desc.to_string();
                    }
                }
            }
        }
    }

    // Fallback: first non-empty line of the file body (skip frontmatter if present).
    let body = skip_frontmatter(contents);
    for line in body.lines() {
        let trimmed = line.trim().trim_start_matches('#').trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    String::new()
}

/// Skip YAML frontmatter if present, returning the body text.
fn skip_frontmatter(contents: &str) -> &str {
    if (contents.starts_with("---\n") || contents.starts_with("---\r\n"))
        && let Some(end) = contents[3..].find("\n---")
    {
        let after = 3 + end + 4; // skip past "\n---"
        if after < contents.len() {
            return &contents[after..];
        }
        return "";
    }
    contents
}

/// Re-sort commands by usage frequency (descending), with unused commands sorted alphabetically.
pub fn sort_commands_by_usage(commands: &mut [SlashCommand], usage: &HashMap<String, i64>) {
    commands.sort_by(|a, b| {
        let count_a = usage.get(&a.name).copied().unwrap_or(0);
        let count_b = usage.get(&b.name).copied().unwrap_or(0);
        count_b.cmp(&count_a).then_with(|| a.name.cmp(&b.name))
    });
}

/// Insert or replace a command by name (higher priority sources replace lower).
fn upsert_command(commands: &mut Vec<SlashCommand>, cmd: SlashCommand) {
    if let Some(existing) = commands.iter_mut().find(|c| c.name == cmd.name) {
        *existing = cmd;
    } else {
        commands.push(cmd);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_parse_description_with_frontmatter() {
        let contents =
            "---\ndescription: Create a git commit\nallowed-tools: Bash\n---\n\nBody text";
        assert_eq!(parse_description(contents), "Create a git commit");
    }

    #[test]
    fn test_parse_description_quoted_frontmatter() {
        let contents = "---\ndescription: \"Build apps with Claude API\"\n---\n\nBody";
        assert_eq!(parse_description(contents), "Build apps with Claude API");
    }

    #[test]
    fn test_parse_description_no_frontmatter() {
        let contents = "Review all uncommitted changes and create a commit.\n\n## Steps\n...";
        assert_eq!(
            parse_description(contents),
            "Review all uncommitted changes and create a commit."
        );
    }

    #[test]
    fn test_parse_description_heading_first_line() {
        let contents = "# My Command\n\nDoes stuff.";
        assert_eq!(parse_description(contents), "My Command");
    }

    #[test]
    fn test_parse_description_empty() {
        assert_eq!(parse_description(""), String::new());
    }

    #[test]
    fn test_discover_from_temp_dirs() {
        let home = tempfile::tempdir().unwrap();
        let claude_dir = home.path().join(".claude");

        // Create user commands.
        let cmds_dir = claude_dir.join("commands");
        fs::create_dir_all(&cmds_dir).unwrap();
        fs::write(
            cmds_dir.join("my-cmd.md"),
            "---\ndescription: My custom command\n---\n",
        )
        .unwrap();

        // Create user skill.
        let skill_dir = claude_dir.join("skills/my-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: my-skill\ndescription: A test skill\n---\n",
        )
        .unwrap();

        // We can't easily override home_dir, so test the helper functions directly.
        let mut commands = Vec::new();
        collect_commands_from_dir(&cmds_dir, "user", &mut commands);
        collect_skills_from_dir(&claude_dir.join("skills"), "user", &mut commands);

        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, "my-cmd");
        assert_eq!(commands[0].description, "My custom command");
        assert_eq!(commands[0].source, "user");
        assert_eq!(commands[1].name, "my-skill");
        assert_eq!(commands[1].description, "A test skill");
    }

    #[test]
    fn test_upsert_replaces_by_name() {
        let mut commands = vec![SlashCommand::file_based(
            "commit".into(),
            "Plugin commit".into(),
            "plugin",
        )];

        upsert_command(
            &mut commands,
            SlashCommand::file_based("commit".into(), "User commit".into(), "user"),
        );

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].description, "User commit");
        assert_eq!(commands[0].source, "user");
    }

    #[test]
    fn test_collect_native_commands_injects_plugin_and_marketplace() {
        let mut commands = Vec::new();
        collect_native_commands(&mut commands, true);
        let names: Vec<_> = commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"plugin"));
        assert!(names.contains(&"marketplace"));
        let plugin = commands.iter().find(|c| c.name == "plugin").unwrap();
        assert_eq!(plugin.source, "builtin");
        assert_eq!(plugin.aliases, vec!["plugins".to_string()]);
        assert_eq!(plugin.kind, Some(NativeKind::SettingsRoute));
        assert!(plugin.argument_hint.is_some());
    }

    #[test]
    fn test_collect_native_commands_skips_plugin_entries_when_disabled() {
        let mut commands = Vec::new();
        collect_native_commands(&mut commands, false);
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert!(!names.contains(&"plugin"));
        assert!(!names.contains(&"marketplace"));
        // Review workflow entries are always present regardless of the plugin flag.
        assert!(names.contains(&"review"));
        assert!(names.contains(&"security-review"));
        assert!(names.contains(&"pr-comments"));
        // Non-plugin native settings/version commands are still registered.
        assert!(names.contains(&"config"));
        assert!(names.contains(&"usage"));
        assert!(names.contains(&"extra-usage"));
        assert!(names.contains(&"release-notes"));
        assert!(names.contains(&"version"));
        // Workspace-control commands are unconditional too.
        assert!(names.contains(&"clear"));
        assert!(names.contains(&"plan"));
        assert!(names.contains(&"model"));
        assert!(names.contains(&"permissions"));
        assert!(names.contains(&"status"));
    }

    #[test]
    fn test_native_command_registry_includes_workspace_control_commands() {
        let natives = native_command_registry(false);
        for name in ["clear", "plan", "model", "permissions", "status"] {
            let cmd = natives
                .iter()
                .find(|c| c.name == name)
                .unwrap_or_else(|| panic!("missing native command {name}"));
            assert_eq!(cmd.source, "builtin");
            assert_eq!(cmd.kind, Some(NativeKind::LocalAction));
        }
    }

    #[test]
    fn test_permissions_exposes_allowed_tools_alias() {
        let natives = native_command_registry(false);
        let permissions = natives
            .iter()
            .find(|c| c.name == "permissions")
            .expect("missing permissions command");
        assert_eq!(permissions.aliases, vec!["allowed-tools".to_string()]);
        assert_eq!(
            resolve_native("allowed-tools", &natives).map(|c| c.name.as_str()),
            Some("permissions")
        );
        assert_eq!(
            resolve_native("Allowed-Tools", &natives).map(|c| c.name.as_str()),
            Some("permissions")
        );
    }

    #[test]
    fn test_workspace_control_commands_have_argument_hints() {
        let natives = native_command_registry(false);
        // Commands that accept arguments advertise an argument hint.
        for name in ["plan", "model", "permissions"] {
            let cmd = natives.iter().find(|c| c.name == name).unwrap();
            assert!(
                cmd.argument_hint.is_some(),
                "{name} should have an argument hint"
            );
        }
        // /clear and /status take no arguments.
        for name in ["clear", "status"] {
            let cmd = natives.iter().find(|c| c.name == name).unwrap();
            assert!(
                cmd.argument_hint.is_none(),
                "{name} should not expose an argument hint"
            );
        }
    }

    #[test]
    fn test_collect_native_commands_yields_workspace_control_slots_to_user_markdown() {
        // Workspace-control natives (clear/plan/model/permissions/status) are
        // NOT on the reserved list — they share `is_reserved_native_name`'s
        // rules with config/usage/review: if a human has a `.claude/commands/
        // clear.md`, their version wins so Claudette does not silently displace
        // a custom workflow the user already relied on.
        let mut commands = vec![
            SlashCommand::file_based("clear".into(), "User custom clear".into(), "user"),
            SlashCommand::file_based("status".into(), "Project custom status".into(), "project"),
            SlashCommand::file_based("keep-me".into(), "Unrelated".into(), "user"),
        ];
        collect_native_commands(&mut commands, false);

        let clear = commands.iter().find(|c| c.name == "clear").unwrap();
        assert_eq!(clear.source, "user");
        assert_eq!(clear.description, "User custom clear");
        let status = commands.iter().find(|c| c.name == "status").unwrap();
        assert_eq!(status.source, "project");

        // Non-colliding workspace-control natives still register from the registry.
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"plan"));
        assert!(names.contains(&"model"));
        assert!(names.contains(&"permissions"));
        assert!(names.contains(&"keep-me"));
    }

    #[test]
    fn test_native_command_registry_includes_review_workflow_entries() {
        for enabled in [true, false] {
            let natives = native_command_registry(enabled);
            for name in ["review", "security-review", "pr-comments"] {
                let entry = natives
                    .iter()
                    .find(|c| c.name == name)
                    .unwrap_or_else(|| panic!("missing native entry `{name}` (enabled={enabled})"));
                assert_eq!(entry.source, "builtin");
                assert_eq!(entry.kind, Some(NativeKind::PromptExpansion));
                assert!(
                    entry.argument_hint.is_some(),
                    "argument hint missing for `{name}`"
                );
                assert!(
                    entry.aliases.is_empty(),
                    "review commands expose no aliases"
                );
            }
        }
    }

    #[test]
    fn test_native_command_registry_includes_settings_and_version_commands() {
        for enabled in [true, false] {
            let natives = native_command_registry(enabled);
            let by_name: HashMap<&str, &SlashCommand> =
                natives.iter().map(|c| (c.name.as_str(), c)).collect();

            let config = by_name.get("config").expect("config registered");
            assert_eq!(config.kind, Some(NativeKind::SettingsRoute));
            assert_eq!(config.aliases, vec!["configure".to_string()]);
            assert!(config.argument_hint.is_some());

            let usage = by_name.get("usage").expect("usage registered");
            assert_eq!(usage.kind, Some(NativeKind::SettingsRoute));
            assert!(usage.aliases.is_empty());

            let extra = by_name.get("extra-usage").expect("extra-usage registered");
            assert_eq!(extra.kind, Some(NativeKind::SettingsRoute));

            let release = by_name
                .get("release-notes")
                .expect("release-notes registered");
            assert_eq!(release.kind, Some(NativeKind::LocalAction));
            assert_eq!(release.aliases, vec!["changelog".to_string()]);

            let version = by_name.get("version").expect("version registered");
            assert_eq!(version.kind, Some(NativeKind::LocalAction));
            assert_eq!(version.aliases, vec!["about".to_string()]);
        }
    }

    #[test]
    fn test_resolve_native_resolves_new_command_aliases() {
        let natives = native_command_registry(false);
        assert_eq!(
            resolve_native("configure", &natives).unwrap().name,
            "config"
        );
        assert_eq!(
            resolve_native("CONFIGURE", &natives).unwrap().name,
            "config"
        );
        assert_eq!(
            resolve_native("changelog", &natives).unwrap().name,
            "release-notes"
        );
        assert_eq!(resolve_native("about", &natives).unwrap().name, "version");
    }

    #[test]
    fn test_collect_native_commands_yields_to_user_commands_for_non_reserved_slots() {
        // A user-defined `config`/`review` command should take priority over the
        // built-in natives — unlike plugin/marketplace, generic names like
        // `config`/`usage`/`version`/`review` must not silently displace
        // pre-existing custom workflows.
        let mut commands = vec![
            SlashCommand::file_based("config".into(), "User custom config".into(), "user"),
            SlashCommand::file_based("review".into(), "Project custom review".into(), "project"),
        ];
        collect_native_commands(&mut commands, true);

        let config = commands.iter().find(|c| c.name == "config").unwrap();
        assert_eq!(config.source, "user");
        assert_eq!(config.description, "User custom config");

        let review = commands.iter().find(|c| c.name == "review").unwrap();
        assert_eq!(review.source, "project");

        // Other natives still register when no collision exists.
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"usage"));
        assert!(names.contains(&"extra-usage"));
        assert!(names.contains(&"version"));
        assert!(names.contains(&"security-review"));
        assert!(names.contains(&"pr-comments"));
    }

    #[test]
    fn test_collect_native_commands_ignores_plugin_source_shadows() {
        // Plugin-provided commands must NOT override non-reserved natives:
        // the user/project markdown precedence applies to humans editing
        // `.claude/commands/*.md`, not to anything a plugin drops in.
        let mut commands = vec![
            SlashCommand::file_based("config".into(), "Plugin hostile config".into(), "plugin"),
            SlashCommand::file_based("usage".into(), "Plugin hostile usage".into(), "plugin"),
        ];
        collect_native_commands(&mut commands, true);

        // The natives own these slots: both the builtin entry wins via upsert,
        // and the plugin entries get replaced in place.
        let config = commands.iter().find(|c| c.name == "config").unwrap();
        assert_eq!(config.source, "builtin");
        let usage = commands.iter().find(|c| c.name == "usage").unwrap();
        assert_eq!(usage.source, "builtin");
    }

    #[test]
    fn test_collect_native_commands_drops_file_based_alias_collisions() {
        // Simulate the state of `commands` after file-based discovery has run:
        // three file-based entries, one of which shadows a native alias ("plugins")
        // and one that shadows a native canonical name ("plugin"). Both should be
        // removed so the native registry owns those slots exclusively.
        let mut commands = vec![
            SlashCommand::file_based("plugin".into(), "User plugin override".into(), "user"),
            SlashCommand::file_based("plugins".into(), "Project plugins cmd".into(), "project"),
            SlashCommand::file_based("commit".into(), "Commit changes".into(), "user"),
        ];
        collect_native_commands(&mut commands, true);

        // "commit" stays, file-based "plugin"/"plugins" are replaced by the
        // native entries, and no duplicate rows remain.
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"commit"));
        assert!(names.contains(&"plugin"));
        assert!(names.contains(&"marketplace"));
        // No file-based row survives under a reserved name.
        assert!(
            !commands
                .iter()
                .any(|c| c.source != "builtin" && (c.name == "plugin" || c.name == "plugins"))
        );
        let plugin = commands.iter().find(|c| c.name == "plugin").unwrap();
        assert_eq!(plugin.source, "builtin");
    }

    #[test]
    fn test_collect_native_commands_case_insensitive_collision() {
        let mut commands = vec![SlashCommand::file_based(
            "PLUGINS".into(),
            "Uppercase override".into(),
            "user",
        )];
        collect_native_commands(&mut commands, true);
        assert!(commands.iter().all(|c| c.name != "PLUGINS"));
    }

    #[test]
    fn test_resolve_native_matches_canonical_and_alias_case_insensitive() {
        let natives = native_command_registry(true);
        assert_eq!(resolve_native("plugin", &natives).unwrap().name, "plugin");
        assert_eq!(resolve_native("Plugin", &natives).unwrap().name, "plugin");
        assert_eq!(resolve_native("PLUGINS", &natives).unwrap().name, "plugin");
        assert_eq!(
            resolve_native("marketplace", &natives).unwrap().name,
            "marketplace"
        );
        assert!(resolve_native("unknown", &natives).is_none());
        assert!(resolve_native("", &natives).is_none());
    }

    #[test]
    fn test_native_command_registry_canonicals_are_unique() {
        let natives = native_command_registry(true);
        let mut names: Vec<_> = natives.iter().map(|c| c.name.clone()).collect();
        names.sort();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len());
    }

    #[test]
    fn test_native_kind_serializes_snake_case() {
        let json = serde_json::to_string(&NativeKind::SettingsRoute).unwrap();
        assert_eq!(json, "\"settings_route\"");
        let round: NativeKind = serde_json::from_str("\"prompt_expansion\"").unwrap();
        assert_eq!(round, NativeKind::PromptExpansion);
    }

    #[test]
    fn test_slash_command_serialization_skips_empty_native_fields_for_file_based() {
        let cmd = SlashCommand::file_based("commit".into(), "do it".into(), "user");
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(!json.contains("aliases"));
        assert!(!json.contains("argument_hint"));
        assert!(!json.contains("kind"));
    }

    #[test]
    fn test_collect_plugin_commands_uses_manifest_paths_and_namespaces() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_root = dir.path().join("demo-plugin");
        fs::create_dir_all(plugin_root.join(".claude-plugin")).unwrap();
        fs::create_dir_all(plugin_root.join("commands/nested")).unwrap();
        fs::create_dir_all(plugin_root.join("skills/group/skill-a")).unwrap();
        fs::write(
            plugin_root.join(".claude-plugin/plugin.json"),
            serde_json::json!({
                "name": "demo",
                "commands": {
                    "about": {
                        "source": "./README.md",
                        "description": "About this plugin"
                    }
                },
                "skills": ["./skills"]
            })
            .to_string(),
        )
        .unwrap();
        fs::write(plugin_root.join("commands/nested/run.md"), "# Run\n").unwrap();
        fs::write(plugin_root.join("README.md"), "# Readme\n").unwrap();
        fs::write(
            plugin_root.join("skills/group/skill-a/SKILL.md"),
            "---\ndescription: Skill A\n---\n",
        )
        .unwrap();

        let mut commands = Vec::new();
        collect_plugin_commands(&plugin_root, &mut commands);
        commands.sort_by(|a, b| a.name.cmp(&b.name));

        assert!(commands.iter().any(|command| command.name == "demo:about"));
        assert!(
            commands
                .iter()
                .any(|command| command.name == "demo:nested:run")
        );
        assert!(
            commands
                .iter()
                .any(|command| command.name == "demo:group:skill-a")
        );
    }

    #[test]
    fn test_sort_commands_by_usage() {
        let mut commands = vec![
            SlashCommand::file_based("alpha".into(), "".into(), "user"),
            SlashCommand::file_based("beta".into(), "".into(), "user"),
            SlashCommand::file_based("gamma".into(), "".into(), "user"),
        ];

        let mut usage = HashMap::new();
        usage.insert("gamma".to_string(), 5);
        usage.insert("alpha".to_string(), 2);

        sort_commands_by_usage(&mut commands, &usage);

        assert_eq!(commands[0].name, "gamma"); // 5 uses
        assert_eq!(commands[1].name, "alpha"); // 2 uses
        assert_eq!(commands[2].name, "beta"); // 0 uses
    }

    #[test]
    fn test_sort_commands_by_usage_alphabetical_tiebreaker() {
        let mut commands = vec![
            SlashCommand::file_based("zebra".into(), "".into(), "user"),
            SlashCommand::file_based("apple".into(), "".into(), "user"),
        ];

        let usage = HashMap::new(); // no usage
        sort_commands_by_usage(&mut commands, &usage);

        assert_eq!(commands[0].name, "apple");
        assert_eq!(commands[1].name, "zebra");
    }

    #[test]
    fn test_project_commands() {
        let project = tempfile::tempdir().unwrap();
        let cmds_dir = project.path().join(".claude/commands");
        fs::create_dir_all(&cmds_dir).unwrap();
        fs::write(
            cmds_dir.join("deploy.md"),
            "Deploy the app to production.\n",
        )
        .unwrap();

        let mut commands = Vec::new();
        collect_commands_from_dir(&cmds_dir, "project", &mut commands);

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "deploy");
        assert_eq!(commands[0].description, "Deploy the app to production.");
        assert_eq!(commands[0].source, "project");
    }
}
