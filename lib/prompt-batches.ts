import { buildGemRequest } from './gem-request';

export const PROMPT_BATCH_SETTINGS_KEY = 'flowcut-prompt-batch-settings-v1';
export function promptBatchRequest(region: string, description: string) {
  return buildGemRequest(`${region}，${description}`, { region, duration: 30, shooting_style: '', spoken_language: 'auto' });
}

export type PromptItem = {
  id: string; title: string; status: string; prompt: string; error: string | null;
  batch_index: number; batch_size: number; prompt_copied_at: string | null;
  image_keys_snapshot: string; product_external_id_snapshot: string;
  created_at: string; gemini_request_text: string; region: string;
  product_name: string; gem_name: string;
};
export type PromptBatch = {
  id: string; created_at: string; items: PromptItem[];
};
