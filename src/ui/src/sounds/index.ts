import defaultManifest from "./default/manifest.json";
import silentManifest from "./silent/manifest.json";
import type { SoundPackDefinition } from "../types/sound";

const defaultTaskComplete = new URL(
  "./default/task-complete.wav",
  import.meta.url
).href;
const defaultInputNeeded = new URL(
  "./default/input-needed.wav",
  import.meta.url
).href;

export const DEFAULT_SOUND_PACK_ID = "default";

export const BUILTIN_SOUND_PACKS: SoundPackDefinition[] = [
  {
    ...defaultManifest,
    resolvedUrls: {
      task_complete: [defaultTaskComplete],
      input_needed: [defaultInputNeeded],
    },
  },
  {
    ...silentManifest,
    resolvedUrls: {},
  },
];
