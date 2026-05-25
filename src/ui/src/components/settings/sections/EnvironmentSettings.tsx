import { ShellEnvCard } from "./ShellEnvCard";

/// Global Environment settings section. Hosts the Shell environment card,
/// the captured shell-init env that's applied to every subprocess
/// Claudette spawns. Per-repo env-provider state (direnv, mise, dotenv,
/// nix-devshell) lives in Repository Settings under Environment, not here.
export function EnvironmentSettings() {
  return (
    <div>
      <ShellEnvCard />
    </div>
  );
}
