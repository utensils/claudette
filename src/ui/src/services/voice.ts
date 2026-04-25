import { invoke } from "@tauri-apps/api/core";
import type { VoiceProviderInfo } from "../types/voice";

export function listVoiceProviders(): Promise<VoiceProviderInfo[]> {
  return invoke("voice_list_providers");
}

export function setSelectedVoiceProvider(
  providerId: string | null,
): Promise<void> {
  return invoke("voice_set_selected_provider", { providerId });
}

export function setVoiceProviderEnabled(
  providerId: string,
  enabled: boolean,
): Promise<void> {
  return invoke("voice_set_provider_enabled", { providerId, enabled });
}

export function prepareVoiceProvider(
  providerId: string,
): Promise<VoiceProviderInfo> {
  return invoke("voice_prepare_provider", { providerId });
}

export function removeVoiceProviderModel(
  providerId: string,
): Promise<VoiceProviderInfo> {
  return invoke("voice_remove_provider_model", { providerId });
}

export function startVoiceRecording(
  providerId?: string,
): Promise<void> {
  return invoke("voice_start_recording", { providerId: providerId ?? null });
}

export function stopAndTranscribeVoice(
  providerId?: string,
): Promise<string> {
  return invoke("voice_stop_and_transcribe", { providerId: providerId ?? null });
}

export function cancelVoiceRecording(providerId?: string): Promise<void> {
  return invoke("voice_cancel_recording", { providerId: providerId ?? null });
}
