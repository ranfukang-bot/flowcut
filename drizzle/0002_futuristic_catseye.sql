CREATE TABLE `provider_runtime` (
	`provider` text PRIMARY KEY NOT NULL,
	`status_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `auto_queue` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `bridge_claimed_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `bridge_worker_id` text;