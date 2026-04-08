export type SoundEvent = "task_complete" | "input_needed";

export interface SoundPackDefinition {
  id: string;
  name: string;
  author?: string;
  description?: string;
  sounds: Partial<Record<SoundEvent, string>>;
  resolvedUrls?: Partial<Record<SoundEvent, string>>;
}
