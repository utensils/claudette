import { CodeBlock } from "./CodeBlock";
import { shouldShowBanner } from "./cliInvocationBannerLogic";
import styles from "./CliInvocationBanner.module.css";

interface Props {
  invocation: string | null;
}

/**
 * The literal `claude` invocation that started this session, redacted of
 * sensitive flag values and with the prompt positional replaced by
 * `<prompt>`. Pinned above the message list so it's always the first block
 * in the tab.
 */
export function CliInvocationBanner({ invocation }: Props) {
  if (!shouldShowBanner(invocation)) return null;
  return (
    <div className={styles.banner}>
      <CodeBlock className={styles.codeBlock}>
        <code className={styles.code}>{invocation}</code>
      </CodeBlock>
    </div>
  );
}
