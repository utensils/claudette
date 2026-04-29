import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import styles from "./CodeBlock.module.css";

export function CodeBlock({
  children,
  ...props
}: {
  children?: React.ReactNode;
  [key: string]: unknown;
}) {
  const { t } = useTranslation("chat");
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const text =
      preRef.current?.querySelector("code")?.textContent ??
      preRef.current?.textContent ??
      "";
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((err) => console.error("Copy code failed:", err));
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <pre ref={preRef} {...props}>
      {children}
      <button
        type="button"
        className={`${styles.copyButton} ${copied ? styles.copied : ""}`}
        onClick={handleCopy}
        title={copied ? t("code_block_copied") : t("code_block_copy")}
        aria-label={t("code_block_copy")}
      >
        {copied ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </pre>
  );
}
