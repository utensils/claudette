export type SoundEvent = "task_complete" | "input_needed";

/** A single filename or an array of filenames (one picked at random). */
export type SoundFileEntry = string | string[];

export interface SoundPackDefinition {
  id: string;
  name: string;
  author?: string;
  description?: string;
  sounds: Partial<Record<SoundEvent, SoundFileEntry>>;
  resolvedUrls?: Partial<Record<SoundEvent, string[]>>;
}
