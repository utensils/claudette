export type VoiceProviderKind = "platform" | "local-model" | "external";

export type VoiceRecordingMode = "native" | "webview";

export type VoiceProviderStatus =
  | "ready"
  | "needs-setup"
  | "downloading"
  | "engine-unavailable"
  | "unavailable"
  | "error";

export interface VoiceProviderInfo {
  id: string;
  name: string;
  description: string;
  kind: VoiceProviderKind;
  recordingMode: VoiceRecordingMode;
  privacyLabel: string;
  offline: boolean;
  downloadRequired: boolean;
  modelSizeLabel: string | null;
  cachePath: string | null;
  acceleratorLabel: string | null;
  status: VoiceProviderStatus;
  statusLabel: string;
  enabled: boolean;
  selected: boolean;
  setupRequired: boolean;
  canRemoveModel: boolean;
  error: string | null;
}

export interface VoiceDownloadProgress {
  providerId: string;
  filename: string;
  downloadedBytes: number;
  totalBytes: number | null;
  overallDownloadedBytes: number;
  overallTotalBytes: number | null;
  percent: number | null;
}
