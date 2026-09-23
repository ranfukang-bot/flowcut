CREATE TABLE `gems` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`duration` integer DEFAULT 15 NOT NULL,
	`locale` text DEFAULT 'id-ID' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`country` text DEFAULT 'ID' NOT NULL,
	`language` text DEFAULT 'id-ID' NOT NULL,
	`features` text DEFAULT '' NOT NULL,
	`image_key` text,
	`image_name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`account_name` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`gem_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'prompt_ready' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'seedance-browser' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`output_url` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
