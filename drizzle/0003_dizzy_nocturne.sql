CREATE TABLE `tiktok_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tiktok_accounts_name_unique` ON `tiktok_accounts` (`name`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `gemini_account_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tiktok_account_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `download_path` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `download_error` text;