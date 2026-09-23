CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_configs` (
	`provider` text PRIMARY KEY NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`encrypted_secret` text,
	`secret_iv` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `provider_job_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `provider_status_url` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `callback_token` text;