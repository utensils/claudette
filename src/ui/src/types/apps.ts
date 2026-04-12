export type AppCategory = "editor" | "terminal" | "ide";

export interface DetectedApp {
  id: string;
  name: string;
  category: AppCategory;
  detected_path: string;
}
