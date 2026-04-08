import { BUILTIN_SOUND_PACKS, DEFAULT_SOUND_PACK_ID } from "../sounds";
import { listUserSoundPacks, readSoundFile } from "../services/tauri";
import type { SoundPackDefinition, SoundEvent } from "../types/sound";

let audioCtx: AudioContext | null = null;
const audioBufferCache = new Map<string, AudioBuffer>();

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface UserSoundPack extends SoundPackDefinition {
  basePath: string;
}

export async function loadAllSoundPacks(): Promise<SoundPackDefinition[]> {
  let userPacks: SoundPackDefinition[] = [];
  try {
    const rawPacks = await listUserSoundPacks();
    userPacks = rawPacks.map((info) => {
      const pack: UserSoundPack = {
        ...info.manifest,
        resolvedUrls: {},
        basePath: info.base_path,
      };
      return pack;
    });
  } catch (e) {
    console.error("Failed to load user sound packs:", e);
  }

  const packsById = new Map<string, SoundPackDefinition>();
  for (const pack of BUILTIN_SOUND_PACKS) {
    packsById.set(pack.id, pack);
  }
  for (const pack of userPacks) {
    packsById.set(pack.id, pack);
  }
  return Array.from(packsById.values());
}

export function findSoundPack(
  packs: SoundPackDefinition[],
  id: string
): SoundPackDefinition {
  const requested = packs.find((p) => p.id === id);
  if (requested) return requested;

  const fallback = packs.find((p) => p.id === DEFAULT_SOUND_PACK_ID);
  if (fallback) return fallback;

  if (packs[0]) return packs[0];

  return { id: "silent", name: "Silent", sounds: {}, resolvedUrls: {} };
}

/** Normalize a sound entry (string or string[]) to a string array. */
function normalizeFilenames(entry: string | string[]): string[] {
  return Array.isArray(entry) ? entry : [entry];
}

/**
 * Resolve all URLs for a sound event, loading custom pack files lazily.
 * Returns an array of playable URLs (cached after first resolution).
 */
async function resolveUrls(
  pack: SoundPackDefinition,
  event: SoundEvent
): Promise<string[]> {
  // Already resolved — return cached URLs.
  const existing = pack.resolvedUrls?.[event];
  if (existing && existing.length > 0) return existing;

  // Get the filenames for this event.
  const entry = pack.sounds[event];
  if (!entry) return [];

  const filenames = normalizeFilenames(entry);
  if (filenames.length === 0) return [];

  const userPack = pack as UserSoundPack;
  if (!userPack.basePath) return [];

  // Custom packs: read each file via Tauri command.
  const urls: string[] = [];
  for (const filename of filenames) {
    try {
      const dataUri = await readSoundFile(userPack.basePath, filename);
      urls.push(dataUri);
    } catch (e) {
      console.error(`[sound] Failed to read ${filename}:`, e);
    }
  }

  if (!pack.resolvedUrls) pack.resolvedUrls = {};
  pack.resolvedUrls[event] = urls;
  return urls;
}

export async function playSound(
  pack: SoundPackDefinition,
  event: SoundEvent,
  volume: number
): Promise<void> {
  const urls = await resolveUrls(pack, event);
  if (urls.length === 0) return;

  const url = pickRandom(urls);

  const ctx = getAudioContext();
  let buffer = audioBufferCache.get(url);
  if (!buffer) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    buffer = await ctx.decodeAudioData(arrayBuffer);
    audioBufferCache.set(url, buffer);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start();
}
