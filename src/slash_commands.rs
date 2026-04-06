use std::path::Path;

use serde::Serialize;

/// A discovered slash command or skill.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    /// Where the command was found: "user", "project", or "plugin".
    pub source: String,
}

/// Discover all available slash commands by scanning known Claude Code directories.
///
/// Commands are deduplicated by name with priority: project > user > plugin.
pub fn discover_slash_commands(project_path: Option<&Path>) -> Vec<SlashCommand> {
    let mut commands: Vec<SlashCommand> = Vec::new();

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return commands,
    };

    let claude_dir = home.join(".claude");

    // Plugin commands and skills (lowest priority — collected first, deduped later).
    let marketplaces = claude_dir.join("plugins/marketplaces");
    if let Ok(entries) = std::fs::read_dir(&marketplaces) {
        for marketplace in entries.flatten() {
            let plugins_dir = marketplace.path().join("plugins");
            if let Ok(plugins) = std::fs::read_dir(&plugins_dir) {
                for plugin in plugins.flatten() {
                    collect_commands_from_dir(
                        &plugin.path().join("commands"),
                        "plugin",
                        &mut commands,
                    );
                    collect_skills_from_dir(&plugin.path().join("skills"), "plugin", &mut commands);
                }
            }
        }
    }

    // User-level commands and skills (medium priority).
    collect_commands_from_dir(&claude_dir.join("commands"), "user", &mut commands);
    collect_skills_from_dir(&claude_dir.join("skills"), "user", &mut commands);

    // Project-level commands (highest priority).
    if let Some(project) = project_path {
        collect_commands_from_dir(&project.join(".claude/commands"), "project", &mut commands);
    }

    // Sort by name for consistent ordering.
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
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
