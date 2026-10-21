import type { GeminiModelSettings, ModelState } from './gemini-model-settings';
import type { GeminiLoginState } from './gemini-login';
import type { TaskCounts } from '../lib/task-list';

export type Gem = {
  id: string;
  name: string;
  description: string;
  content: string;
  is_default: number;
  updated_at: string;
};

export type Product = {
  id: string;
  external_id: string;
  name: string;
  features: string;
  image_key?: string | null;
  image_name?: string | null;
  images: Array<{
    id: string;
    object_key: string;
    file_name: string;
    content_type: string;
    sort_order: number;
  }>;
  created_at: string;
};

export type Task = {
  has_prompt?: number;
  updated_at?: string;
  gemini_model_info?: string | null;
  id: string;
  product_id: string;
  product_external_id?: string;
  product_image_key?: string | null;
  gem_id: string;
  title: string;
  status: string;
  prompt?: string;
  provider: string;
  duration: number;
  region: string;
  shooting_style: string;
  provider_job_id?: string | null;
  progress: number;
  output_url?: string | null;
  provider_status_url?: string | null;
  error?: string | null;
  product_name?: string;
  gem_name?: string;
  image_count?: number;
  gemini_account_id?: string | null;
  tiktok_account_name: string;
  archive_directory?: string;
  download_path?: string | null;
  review_status?: string;
  approved_path?: string | null;
  segment_progress?: string | null;
  download_error?: string | null;
  created_at: string;
  task_role?: string | null;
  batch_parent_id?: string | null;
  batch_index?: number | null;
  batch_round?: number | null;
  batch_size?: number | null;
  merged_into_task_id?: string | null;
  prompt_note?: string | null;
  variant_mode?: number;
  gemini_raw_reply?: string | null;
  variant_request_text?: string | null;
  children?: Task[];
};

export type TikTokAccount = {
  archive_directory?: string;
  id: string;
  name: string;
  created_at: string;
};

export type Schedule = {
  id: string;
  task_id: string;
  account_name: string;
  scheduled_at: string;
  caption: string;
  status: string;
  task_title?: string;
};

export type ReferenceRemixAsset = {
  id: string;
  kind: "reference_video" | "product_image";
  object_key: string;
  file_name: string;
  content_type: string;
  file_size: number;
  sort_order: number;
};

export type ReferenceRemixTask = {
  gemini_model_info?: string | null;
  id: string;
  title: string;
  status: string;
  progress: number;
  duration: number;
  region: string;
  product_name: string;
  product_external_id: string;
  save_to_library: number;
  product_id?: string | null;
  gemini_account_id?: string | null;
  tiktok_account_name: string;
  auto_queue: number;
  reference_analysis: string;
  prompt: string;
  provider: string;
  output_url?: string | null;
  archive_directory?: string;
  download_path?: string | null;
  download_error?: string | null;
  error?: string | null;
  created_at: string;
  assets: ReferenceRemixAsset[];
};

export type ScriptPromptGroup = {
  index: number;
  rawDuration: number;
  targetDuration: number;
  shotNumbers: number[];
  rawPrompt: string;
  optimizedPrompt?: string;
};

export type ScriptPipelineTask = {
  gemini_model_info?: string | null;
  id: string;
  title: string;
  status: string;
  progress: number;
  source_script: string;
  project_context: string;
  rewritten_script: string;
  extraction_json: string;
  storyboard_json: string;
  raw_groups_json: string;
  optimized_groups_json: string;
  gemini_account_id?: string | null;
  error?: string | null;
  created_at: string;
};

export type Workspace = {
  taskCounts?: TaskCounts;
  gems: Gem[];
  products: Product[];
  tasks: Task[];
  schedules: Schedule[];
  tiktokAccounts: TikTokAccount[];
  referenceRemixTasks: ReferenceRemixTask[];
  referenceRemixSettings: { duration: number; region: string };
  scriptPipelineTasks: ScriptPipelineTask[];
  integrations: {
    gemini: boolean;
    geminiMode?: "web" | "api";
    geminiRuntime?: {
      online: boolean;
      authenticated?: boolean;
      queueRunning?: boolean;
      maxConcurrent?: number;
      activeCount?: number;
      activeJobs?: Array<{ taskId: string; accountName?: string; stage?: string; startedAt?: string }>;
      workerId?: string;
      version?: string;
      updatedAt?: string;
      defaultAccountId?: string;
      accounts?: Array<{
        id: string;
        name: string;
        authenticated: boolean;
        enabled?: boolean;
        busy?: boolean;
      }>;
    };
    seedance: boolean;
    seedanceMode?: "local-api" | "webhook" | "async-api";
    seedanceRuntime?: {
      online: boolean;
      authenticated?: boolean;
      queueRunning?: boolean;
      maxConcurrent?: number;
      activeCount?: number;
      activeJobs?: Array<{ taskId: string; accountName?: string; stage?: string; startedAt?: string }>;
      workerId?: string;
      version?: string;
      updatedAt?: string;
      downloadDirectory?: string;
    };
    tiktok: boolean;
  };
};

export type Page = "dashboard" | "scripts" | "remix" | "fission" | "products" | "gems" | "tasks" | "calendar" | "settings" | "publisher";

export type SeedanceRuntime = {
  status: "checking" | "ready" | "missing-key" | "offline" | "blocked";
  label: string;
  detail: string;
};

export type UpdateState = {
  status:
    | "local"
    | "idle"
    | "development"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "downloaded"
    | "error";
  currentVersion: string;
  availableVersion: string;
  percent: number;
  message: string;
  checkedAt?: string | null;
};

export type FlowCutDesktopBridge = {
  readGeminiModels?: () => Promise<ModelState>;
  saveGeminiModel?: (settings: GeminiModelSettings) => Promise<ModelState>;
  openReviewVideo?: (id: string) => Promise<boolean>;
  openReviewFolder?: (id?: string) => Promise<boolean>;
  deletePendingReviewVideo?: (id: string, confirmed: boolean) => Promise<boolean>;
  approveReviewVideo?: (id: string, confirmed: boolean) => Promise<{file:string;alreadyApproved?:boolean}>;
  discardReviewVideo?: (id: string, replacementId: string) => Promise<boolean>;
  concatReviewVideos?: (groupId: string, ids: string[], confirmed: boolean) => Promise<{ id: string; file: string }>;
  listGemBindings?: (gem: Gem) => Promise<Array<{ id: string; name: string; authenticated: boolean; binding: { url?: string; status: string; name?: string } | null }>>;
  configureGem?: (options: { accountId: string; gem: Gem; action: "create" | "bind" | "open"; url?: string }) => Promise<unknown>;
  seedanceSetPreferredModel?: (id: string, model: string) => Promise<SeedanceDesktopState>;
  seedanceDecideFastFallback?: (id: string, choice: string, date: string) => Promise<SeedanceDesktopState>;
  seedanceReconnectLogin?: (id: string) => Promise<SeedanceDesktopState>;
  getState?: () => Promise<{ geminiLogin?: GeminiLoginState | null; update?: UpdateState; accounts?: NonNullable<Workspace["integrations"]["geminiRuntime"]>["accounts"]; defaultAccountId?: string; bridge?: { activeJobs: Array<{ accountId: string }> } }>;
  updateState?: () => Promise<UpdateState>;
  chooseArchiveDirectory?: () => Promise<string | null>;
  setQueueRunning?: (running: boolean) => Promise<unknown>;
  clearAllTasks?: () => Promise<{ deleted: number }>;
  publisherStart?: () => Promise<{ origin: string }>;
  publisherOpenExtension?: () => Promise<boolean>;
  publisherImport?: (rows: unknown[]) => Promise<{ total: number; added: number; results: Array<{ warning?: string }> }>;
  publisherRelease?: (taskId: string, confirmed: boolean) => Promise<{ alreadyReleased?: boolean; file: string }>;
  updateCheck?: () => Promise<UpdateState>;
  updateInstall?: () => Promise<unknown>;
  onState?: (
    callback: (state: { geminiLogin?: GeminiLoginState | null; update?: UpdateState; seedance?: SeedanceDesktopState }) => void
  ) => (() => void);
  addAccount: (name: string) => Promise<unknown>;
  openLogin: (id: string) => Promise<unknown>;
  openGeminiAccountWindow?: (id: string) => Promise<unknown>;
  hideLogin: (id: string) => Promise<unknown>;
  openGeminiLoginBrowser?: () => Promise<unknown>;
  importGeminiLogin?: () => Promise<{ geminiLoginResult?: string }>;
  cancelGeminiLogin?: () => Promise<unknown>;
  checkAccount: (id: string) => Promise<unknown>;
  removeAccount: (id: string) => Promise<unknown>;
  renameAccount: (id: string, name: string) => Promise<unknown>;
  setAccountEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  setDefaultAccount: (id: string) => Promise<unknown>;
  seedanceState: () => Promise<SeedanceDesktopState | null>;
  seedanceAddAccount: (name: string) => Promise<SeedanceDesktopState>;
  seedanceOpenLogin: (id: string) => Promise<unknown>;
  seedanceSaveLogin: (id: string) => Promise<SeedanceDesktopState>;
  seedanceRemoveAccount: (id: string) => Promise<SeedanceDesktopState>;
  seedanceRenameAccount: (id: string, name: string) => Promise<SeedanceDesktopState>;
  seedanceSetAccountEnabled: (id: string, enabled: boolean) => Promise<SeedanceDesktopState>;
  seedanceSetRunning: (running: boolean) => Promise<SeedanceDesktopState>;
  seedanceChooseDownloadDirectory: () => Promise<SeedanceDesktopState>;
  seedanceOpenDownloadDirectory: () => Promise<unknown>;
};

export type SeedanceDesktopState = {
  ready: boolean;
  authenticated: boolean;
  settings: {
    running: boolean;
    downloadDirectory: string;
  };
  accountState: {
    activeAccountId: string;
    allFastExhausted?: boolean;
    items: Array<{
      id: string;
      name: string;
      enabled: boolean;
      authenticated: boolean;
      exhaustedToday: boolean;
      error?: string;
      maxConcurrent?: number;
      generatingCount?: number;
      active?: boolean;
      preferredModel?: string;
      effectiveModel?: string;
      fastExhaustedToday?: boolean;
      standardExhaustedToday?: boolean;
      quotaDate?: string;
      quotaReason?: string;
      needsModelDecision?: boolean;
      fallbackDecision?: string;
      loginNetworkError?: string;
    }>;
  };
  tasks: Array<{ id: string; status: string }>;
  bridge?: { online?: boolean; error?: string };
};
