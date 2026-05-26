import { useEffect, useState } from "react";
import { getScmProvider } from "../services/tauri";

/// Resolve the SCM provider plugin name for a repo. Used by the
/// project-view sections (Issues / Pull Requests) to hide themselves
/// for repos with no configured provider — same gate as today's
/// sidebar PR badge.
///
/// Returns `undefined` while the lookup is in flight, `null` when no
/// provider matches, or the plugin name string when one resolves.
/// Tracking the three states lets callers avoid rendering a transient
/// "no provider" message during the brief async window between mount
/// and first response.
export function useScmProvider(repoId: string | null): string | null | undefined {
  const [provider, setProvider] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!repoId) {
      setProvider(null);
      return;
    }
    let cancelled = false;
    setProvider(undefined);
    getScmProvider(repoId)
      .then((name) => {
        if (!cancelled) setProvider(name ?? null);
      })
      .catch(() => {
        if (!cancelled) setProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  return provider;
}
