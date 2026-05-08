import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";

type IconComponent = ComponentType<LucideProps>;

const EXT_TO_ICON: Record<string, IconComponent> = {
  // Code
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  py: FileCode,
  rb: FileCode,
  rs: FileCode,
  go: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cc: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cs: FileCode,
  php: FileCode,
  sh: FileCode,
  bash: FileCode,
  zsh: FileCode,
  fish: FileCode,
  lua: FileCode,
  pl: FileCode,
  scala: FileCode,
  dart: FileCode,
  vue: FileCode,
  svelte: FileCode,
  css: FileCode,
  scss: FileCode,
  sass: FileCode,
  less: FileCode,
  html: FileCode,
  htm: FileCode,
  sql: FileCode,
  // JSON
  json: FileJson,
  jsonc: FileJson,
  json5: FileJson,
  // Docs / config (text-shaped)
  md: FileText,
  markdown: FileText,
  mdx: FileText,
  txt: FileText,
  log: FileText,
  rst: FileText,
  adoc: FileText,
  yaml: FileText,
  yml: FileText,
  toml: FileText,
  ini: FileText,
  env: FileText,
  conf: FileText,
  cfg: FileText,
  pdf: FileText,
  // Images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  ico: FileImage,
  bmp: FileImage,
  // Archives
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  bz2: FileArchive,
  "7z": FileArchive,
  rar: FileArchive,
  // Spreadsheets
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
  // Audio
  mp3: FileAudio,
  wav: FileAudio,
  flac: FileAudio,
  ogg: FileAudio,
  m4a: FileAudio,
  aac: FileAudio,
  // Video
  mp4: FileVideo,
  mov: FileVideo,
  mkv: FileVideo,
  avi: FileVideo,
  webm: FileVideo,
};

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
  "apng",
]);

export function getFileIcon(filename: string): IconComponent {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return File;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_ICON[ext] ?? File;
}

export function isImagePath(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(filename.slice(dot + 1).toLowerCase());
}

export function imageMediaType(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "bmp":
      return "image/bmp";
    case "avif":
      return "image/avif";
    case "apng":
      return "image/apng";
    default:
      return null;
  }
}
