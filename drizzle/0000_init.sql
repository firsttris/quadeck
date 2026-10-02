CREATE TABLE `groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_unique` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `layouts` (
	`breakpoint` text NOT NULL,
	`widget_id` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	PRIMARY KEY(`breakpoint`, `widget_id`)
);
--> statement-breakpoint
CREATE TABLE `manual_services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`icon` text,
	`group` text,
	`health_check` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metric_samples` (
	`ts` integer NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `metric_samples_metric_ts` ON `metric_samples` (`metric`,`ts`);--> statement-breakpoint
CREATE TABLE `service_overrides` (
	`service_key` text PRIMARY KEY NOT NULL,
	`name` text,
	`icon` text,
	`group` text,
	`url` text,
	`hidden` integer DEFAULT false NOT NULL,
	`pinned` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`csrf` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL
);
