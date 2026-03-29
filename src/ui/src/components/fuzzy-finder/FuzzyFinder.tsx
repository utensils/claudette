import { useState, useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./FuzzyFinder.module.css";

export function FuzzyFinder() {
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const toggleFuzzyFinder = useAppStore((s) => s.toggleFuzzyFinder);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const results = useMemo(() => {
    const q = query.toLowerCase();
    return workspaces.filter(
      (ws) =>
        ws.name.toLowerCase().includes(q) ||
        ws.branch_name.toLowerCase().includes(q)
    );
  }, [workspaces, query]);

  const handleSelect = (wsId: string) => {
    selectWorkspace(wsId);
    toggleFuzzyFinder();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      handleSelect(results[selectedIndex].id);
    } else if (e.key === "Escape") {
      toggleFuzzyFinder();
    }
  };

  return (
    <div className={styles.backdrop} onClick={toggleFuzzyFinder}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <input
          className={styles.input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search workspaces..."
          autoFocus
        />
        <div className={styles.results}>
          {results.length === 0 ? (
            <div className={styles.empty}>No matching workspaces</div>
          ) : (
            results.map((ws, i) => {
              const repo = repositories.find(
                (r) => r.id === ws.repository_id
              );
              return (
                <div
                  key={ws.id}
                  className={`${styles.result} ${i === selectedIndex ? styles.resultSelected : ""}`}
                  onClick={() => handleSelect(ws.id)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <div className={styles.resultName}>{ws.name}</div>
                  <div className={styles.resultMeta}>
                    {repo?.name} · {ws.branch_name}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
