export type AppCategory = "editor" | "file_manager" | "terminal" | "ide";

export interface DetectedApp {
  id: string;
  name: string;
  category: AppCategory;
  detected_path: string;
}
