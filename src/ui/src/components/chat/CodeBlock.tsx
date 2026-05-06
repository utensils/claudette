import { useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../shared/CopyButton";
import styles from "./CodeBlock.module.css";

export function CodeBlock({
  children,
  ...props
}: {
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const { t } = useTranslation("chat");
  const preRef = useRef<HTMLPreElement>(null);

  const readCodeText = useCallback((): string | null => {
    return (
      preRef.current?.querySelector("code")?.textContent ??
      preRef.current?.textContent ??
      null
    );
  }, []);

  return (
    <pre ref={preRef} {...props}>
      {children}
      <CopyButton
        variant="bare"
        className={styles.copyButton}
        source={readCodeText}
        tooltip={{ copy: t("code_block_copy"), copied: t("code_block_copied") }}
        ariaLabel={t("code_block_copy")}
        stopPropagation
      />
    </pre>
  );
}
