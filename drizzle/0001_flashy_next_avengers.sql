DROP INDEX `metric_samples_metric_ts`;--> statement-breakpoint
CREATE INDEX `metric_samples_metric_ts_value` ON `metric_samples` (`metric`,`ts`,`value`);