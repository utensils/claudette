import { icons } from "lucide-react";

interface RepoIconProps {
  icon: string;
  size?: number;
  className?: string;
}

export function RepoIcon({ icon, size = 14, className }: RepoIconProps) {
  const pascalName = icon
    .trim()
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  const LucideIcon = icons[pascalName as keyof typeof icons];

  if (LucideIcon) {
    return <LucideIcon size={size} className={className} />;
  }
  return <span className={className}>{icon}</span>;
}
