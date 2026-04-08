import { BUILTIN_SOUND_PACKS, DEFAULT_SOUND_PACK_ID } from "../sounds";
import { listUserSoundPacks, readSoundFile } from "../services/tauri";
import type { SoundPackDefinition, SoundEvent } from "../types/sound";

let audioCtx: AudioContext | null = null;
const audioBufferCache = new Map<string, AudioBuffer>();

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
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

async function resolveUrl(
  pack: SoundPackDefinition,
  event: SoundEvent
): Promise<string | undefined> {
  // Built-in packs have pre-resolved URLs.
  const existing = pack.resolvedUrls?.[event];
  if (existing) return existing;

  // Custom packs: read the file via Tauri command and cache the data URI.
  const filename = pack.sounds[event];
  if (!filename) return undefined;

  const userPack = pack as UserSoundPack;
  if (!userPack.basePath) return undefined;

  const dataUri = await readSoundFile(userPack.basePath, filename);
  if (!pack.resolvedUrls) pack.resolvedUrls = {};
  pack.resolvedUrls[event] = dataUri;
  return dataUri;
}

export async function playSound(
  pack: SoundPackDefinition,
  event: SoundEvent,
  volume: number
): Promise<void> {
  const url = await resolveUrl(pack, event);
  if (!url) return;

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
