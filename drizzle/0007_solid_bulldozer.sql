CREATE TABLE `reference_remix_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reference_remix_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`duration` integer DEFAULT 15 NOT NULL,
	`region` text DEFAULT '马来西亚' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reference_remix_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'reference_queued' NOT NULL,
	`progress` integer DEFAULT 5 NOT NULL,
	`duration` integer DEFAULT 15 NOT NULL,
	`region` text DEFAULT '马来西亚' NOT NULL,
	`product_name` text DEFAULT '' NOT NULL,
	`product_external_id` text DEFAULT '' NOT NULL,
	`save_to_library` integer DEFAULT false NOT NULL,
	`product_id` text,
	`gemini_account_id` text,
	`tiktok_account_name` text DEFAULT '' NOT NULL,
	`auto_queue` integer DEFAULT true NOT NULL,
	`reference_analysis` text DEFAULT '' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'gemini-web' NOT NULL,
	`provider_job_id` text,
	`provider_status_url` text,
	`bridge_claimed_at` text,
	`bridge_worker_id` text,
	`gemini_failures` integer DEFAULT 0 NOT NULL,
	`gemini_retry_at` text,
	`output_url` text,
	`download_path` text,
	`download_error` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
