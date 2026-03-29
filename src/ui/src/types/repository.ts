export interface Repository {
  id: string;
  path: string;
  name: string;
  path_slug: string;
  icon: string | null;
  created_at: string;
  path_valid: boolean;
}
