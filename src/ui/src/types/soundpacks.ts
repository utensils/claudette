export interface RegistryPack {
  name: string;
  display_name: string;
  description: string | null;
  language: string | null;
  source_repo: string;
  source_ref: string;
  source_path: string;
  categories: string[];
  sound_count: number;
  total_size_bytes: number;
}

export interface InstalledSoundPack {
  name: string;
  display_name: string;
  version: string;
  categories: string[];
  sound_count: number;
  update_available: boolean;
}
