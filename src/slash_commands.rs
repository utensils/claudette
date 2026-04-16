use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use serde::Serialize;

/// A discovered slash command or skill.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    /// Where the command was found: "builtin", "user", "project", or "plugin".
    pub source: String,
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

    // Built-in app commands must always win.
    collect_builtin_commands(&mut commands, plugin_management_enabled);

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

fn collect_builtin_commands(commands: &mut Vec<SlashCommand>, plugin_management_enabled: bool) {
    if !plugin_management_enabled {
        return;
    }
    upsert_command(
        commands,
        SlashCommand {
            name: "plugin".to_string(),
            description: "Browse and manage plugins in settings".to_string(),
            source: "builtin".to_string(),
        },
    );
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
                    SlashCommand {
                        name,
                        description,
                        source: source.to_string(),
                    },
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
                SlashCommand {
                    name,
                    description,
                    source: "plugin".to_string(),
                },
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
    Some(SlashCommand {
        name,
        description,
        source: source.to_string(),
    })
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
        let mut commands = vec![SlashCommand {
            name: "commit".into(),
            description: "Plugin commit".into(),
            source: "plugin".into(),
        }];

        upsert_command(
            &mut commands,
            SlashCommand {
                name: "commit".into(),
                description: "User commit".into(),
                source: "user".into(),
            },
        );

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].description, "User commit");
        assert_eq!(commands[0].source, "user");
    }

    #[test]
    fn test_collect_builtin_commands_injects_plugin() {
        let mut commands = Vec::new();
        collect_builtin_commands(&mut commands, true);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "plugin");
        assert_eq!(commands[0].source, "builtin");
    }

    #[test]
    fn test_collect_builtin_commands_skips_plugin_when_disabled() {
        let mut commands = Vec::new();
        collect_builtin_commands(&mut commands, false);
        assert!(commands.is_empty());
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
            SlashCommand {
                name: "alpha".into(),
                description: "".into(),
                source: "user".into(),
            },
            SlashCommand {
                name: "beta".into(),
                description: "".into(),
                source: "user".into(),
            },
            SlashCommand {
                name: "gamma".into(),
                description: "".into(),
                source: "user".into(),
            },
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
            SlashCommand {
                name: "zebra".into(),
                description: "".into(),
                source: "user".into(),
            },
            SlashCommand {
                name: "apple".into(),
                description: "".into(),
                source: "user".into(),
            },
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
