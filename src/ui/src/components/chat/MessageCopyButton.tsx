import { useTranslation } from "react-i18next";
import { CopyButton } from "../shared/CopyButton";

export function MessageCopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");

  return (
    <CopyButton
      variant="bare"
      className={className}
      source={text}
      tooltip={{ copy: t("message_copy"), copied: t("message_copied") }}
      ariaLabel={t("message_copy")}
      stopPropagation
    />
  );
}
