import { CronJob } from 'cron';
import cronstrue from 'cronstrue';
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { createLogger } from '../logger.js';
import {
  getEnabledScheduledTasks, insertScheduledTask, deleteScheduledTask,
  updateScheduledTaskEnabled, updateScheduledTaskLastRun, updateScheduledTask,
  getScheduledTasksForChannel, getScheduledTask,
  insertTaskHistory,
  type ScheduledTask,
} from '../state/store.js';
import type { SchedulerConfig } from '../types.js';

const log = createLogger('scheduler');

interface SchedulerDeps {
  /** Send a prompt to a channel's session (creates/resumes as needed). */
  sendMessage: (channelId: string, prompt: string) => Promise<string>;
  /** Post a notification to a channel (no LLM, just a message). */
  postMessage: (channelId: string, text: string) => Promise<void>;
}

// Active CronJob instances keyed by task ID
const activeJobs = new Map<string, CronJob>();

/** Format a timestamp (ISO or SQLite datetime) in the given IANA timezone for display. */
export function formatInTimezone(timestamp: string, timezone: string): string {
  // SQLite datetime('now') produces "2026-03-08 22:57:06" — normalize to ISO
  const normalized = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + 'Z';
  const dt = DateTime.fromISO(normalized, { zone: 'utc' }).setZone(timezone);
  return dt.toLocaleString(DateTime.DATETIME_FULL);
}

/** Convert a cron expression to a human-readable description. */
export function describeCron(cronExpr: string): string {
  try {
    return cronstrue.toString(cronExpr, { use24HourTimeFormat: false });
  } catch {
    return cronExpr;
  }
}

let deps: SchedulerDeps | null = null;

/** Initialize the scheduler — load persisted jobs and start them. */
export function initScheduler(schedulerDeps: SchedulerDeps): void {
  deps = schedulerDeps;
  const tasks = getEnabledScheduledTasks();
  let started = 0;
  let missed = 0;
  const missedByChannel = new Map<string, string[]>();

  for (const task of tasks) {
    // One-off jobs with run_at in the past — notify instead of executing
    if (task.runAt && new Date(task.runAt) <= new Date()) {
      missed++;
      const list = missedByChannel.get(task.channelId) ?? [];
      list.push(task.description ?? task.prompt.slice(0, 60));
      missedByChannel.set(task.channelId, list);
      // Delete the one-off (it won't run again)
      deleteScheduledTask(task.id);
      continue;
    }

    try {
      startJob(task);
      started++;
    } catch (err: any) {
      log.error(`Failed to start job ${task.id}: ${err?.message}`);
    }
  }

  // Notify channels and log one consolidated history entry per channel
  for (const [channelId, descriptions] of missedByChannel) {
    const summary = descriptions.length === 1
      ? descriptions[0]
      : `${descriptions.length} tasks: ${descriptions.join(', ')}`;
    insertTaskHistory({
      taskId: 'system', channelId,
      prompt: summary, description: `Missed while offline`,
      timezone: 'UTC',
      status: 'error', error: `Bridge was offline — ${summary}`,
    });
    const msg = `⏰ **Missed ${descriptions.length} scheduled task(s)** while offline:\n${descriptions.map(d => `- ${d}`).join('\n')}`;
    deps.postMessage(channelId, msg).catch(err =>
      log.error(`Failed to notify channel about missed jobs:`, err)
    );
  }

  log.info(`Scheduler initialized: ${started} job(s) started, ${missed} missed`);
}

/** Create and persist a new scheduled task. */
export function addJob(opts: {
  channelId: string;
  botName: string;
  prompt: string;
  cronExpr?: string;
  runAt?: string;
  timezone?: string;
  createdBy?: string;
  description?: string;
}): ScheduledTask {
  if (!opts.cronExpr && !opts.runAt) {
    throw new Error('Either cronExpr or runAt must be provided');
  }
  if (opts.cronExpr && opts.runAt) {
    throw new Error('Provide either cronExpr or runAt, not both');
  }

  // Short, human-friendly ID (6 alphanumeric chars)
  const id = crypto.randomBytes(4).toString('base64url').slice(0, 6);
  const timezone = opts.timezone ?? 'UTC';

  // Compute next run time (also validates cron expression / timezone)
  let nextRun: string | undefined;
  if (opts.runAt) {
    const parsed = new Date(opts.runAt);
    if (isNaN(parsed.getTime())) throw new Error(`Invalid run_at datetime: ${opts.runAt}`);
    if (parsed <= new Date()) throw new Error(`run_at must be in the future (got ${opts.runAt})`);
    nextRun = parsed.toISOString();
  } else if (opts.cronExpr) {
    // Throws if cron expression or timezone is invalid — before we persist anything
    const probe = CronJob.from({ cronTime: opts.cronExpr, onTick: () => {}, timeZone: timezone });
    nextRun = probe.nextDate().toISO() ?? undefined;
    probe.stop();
  }

  const task: ScheduledTask = {
    id,
    channelId: opts.channelId,
    botName: opts.botName,
    prompt: opts.prompt,
    cronExpr: opts.cronExpr,
    runAt: opts.runAt,
    timezone,
    createdBy: opts.createdBy,
    description: opts.description,
    enabled: true,
    nextRun,
    createdAt: new Date().toISOString(),
  };

  insertScheduledTask(task);
  startJob(task);
  log.info(`Job ${id} created: ${opts.description ?? opts.cronExpr ?? opts.runAt}`);
  return task;
}

/** Remove a job (stops and deletes from DB). Optionally scoped to a channel. */
export function removeJob(id: string, channelId?: string): boolean {
  const task = getScheduledTask(id);
  if (!task) return false;
  if (channelId && task.channelId !== channelId) return false;
  const existing = activeJobs.get(id);
  if (existing) {
    existing.stop();
    activeJobs.delete(id);
  }
  deleteScheduledTask(id);
  log.info(`Job ${id} removed`);
  return true;
}

/** Pause a job (stops timer, keeps in DB). Optionally scoped to a channel. */
export function pauseJob(id: string, channelId?: string): boolean {
  const task = getScheduledTask(id);
  if (!task) return false;
  if (channelId && task.channelId !== channelId) return false;
  const job = activeJobs.get(id);
  if (job) {
    job.stop();
    activeJobs.delete(id);
  }
  updateScheduledTaskEnabled(id, false);
  log.info(`Job ${id} paused`);
  return true;
}

/** Resume a paused job. Optionally scoped to a channel. */
export function resumeJob(id: string, channelId?: string): boolean {
  const task = getScheduledTask(id);
  if (!task) return false;
  if (channelId && task.channelId !== channelId) return false;
  updateScheduledTaskEnabled(id, true);
  try {
    startJob({ ...task, enabled: true });
    log.info(`Job ${id} resumed`);
    return true;
  } catch (err: any) {
    updateScheduledTaskEnabled(id, false);
    log.error(`Failed to resume job ${id}: ${err?.message}`);
    return false;
  }
}

/** List jobs for a channel (or all if no channelId). */
export function listJobs(channelId?: string): ScheduledTask[] {
  if (channelId) return getScheduledTasksForChannel(channelId);
  return getEnabledScheduledTasks();
}

/** Get a job by ID. */
export function getJob(id: string): ScheduledTask | null {
  return getScheduledTask(id);
}

/** Stop all active jobs (for shutdown). */
export function stopAll(): void {
  for (const [id, job] of activeJobs) {
    job.stop();
    log.debug(`Stopped job ${id}`);
  }
  activeJobs.clear();
}

/**
 * Sync config-defined jobs to the scheduler.
 *
 * Called after initScheduler on startup and again after a config reload.
 * - New config jobs (not in DB) are inserted and started.
 * - Existing config jobs get their cron/prompt/description/timezone updated in DB;
 *   the running timer is restarted only if the cron expression changed.
 * - The enabled/disabled state in DB is preserved for existing jobs so users can
 *   toggle jobs at runtime via `/schedule enable|disable <id>`.
 *
 * @param schedulerConfig  The "scheduler" block from config.json.
 * @param resolveChannelId Maps a channel name or ID string to an actual channel ID.
 *                         Return null to skip a job whose channel cannot be resolved.
 * @param defaultBotName   Bot name recorded on newly created tasks.
 */
export function loadConfigJobs(
  schedulerConfig: SchedulerConfig,
  resolveChannelId: (channel: string) => string | null,
  defaultBotName: string,
): void {
  const timezone = schedulerConfig.timezone ?? 'UTC';

  for (const configJob of schedulerConfig.jobs) {
    const channelId = resolveChannelId(configJob.channel);
    if (!channelId) {
      log.warn(`Config job "${configJob.id}": channel "${configJob.channel}" not found — skipping`);
      continue;
    }

    const jobTimezone = timezone;
    const description = configJob.description ?? configJob.id;
    const existing = getScheduledTask(configJob.id);

    if (!existing) {
      // First time this job appears — insert with config's initial enabled state.
      const enabled = configJob.enabled !== false;
      let nextRun: string | undefined;
      try {
        const probe = CronJob.from({ cronTime: configJob.cron, onTick: () => {}, timeZone: jobTimezone });
        nextRun = probe.nextDate().toISO() ?? undefined;
        probe.stop();
      } catch (err: any) {
        log.error(`Config job "${configJob.id}": invalid cron "${configJob.cron}" — ${err?.message}`);
        continue;
      }

      const task: ScheduledTask = {
        id: configJob.id,
        channelId,
        botName: defaultBotName,
        prompt: configJob.prompt,
        cronExpr: configJob.cron,
        timezone: jobTimezone,
        description,
        enabled,
        nextRun,
        createdAt: new Date().toISOString(),
      };
      insertScheduledTask(task);
      if (enabled) {
        try {
          startJob(task);
        } catch (err: any) {
          log.error(`Config job "${configJob.id}": failed to start — ${err?.message}`);
        }
      }
      log.info(`Config job "${configJob.id}" registered (enabled=${enabled})`);
    } else {
      // Job already in DB — update definition but preserve enabled state.
      const cronChanged = existing.cronExpr !== configJob.cron;
      const needsUpdate =
        cronChanged ||
        existing.prompt !== configJob.prompt ||
        existing.description !== description ||
        existing.timezone !== jobTimezone ||
        existing.channelId !== channelId;

      if (needsUpdate) {
        let nextRun: string | undefined = existing.nextRun;
        if (cronChanged) {
          try {
            const probe = CronJob.from({ cronTime: configJob.cron, onTick: () => {}, timeZone: jobTimezone });
            nextRun = probe.nextDate().toISO() ?? undefined;
            probe.stop();
          } catch (err: any) {
            log.error(`Config job "${configJob.id}": invalid updated cron "${configJob.cron}" — ${err?.message}`);
            continue;
          }
        }
        updateScheduledTask(configJob.id, {
          cronExpr: configJob.cron,
          prompt: configJob.prompt,
          description,
          timezone: jobTimezone,
          channelId,
          nextRun,
        });

        // Restart the live timer if cron changed and job is currently running.
        if (cronChanged && activeJobs.has(configJob.id)) {
          activeJobs.get(configJob.id)!.stop();
          activeJobs.delete(configJob.id);
          if (existing.enabled) {
            try {
              startJob({ ...existing, cronExpr: configJob.cron, timezone: jobTimezone, channelId, nextRun });
            } catch (err: any) {
              log.error(`Config job "${configJob.id}": failed to restart with new cron — ${err?.message}`);
            }
          }
        }
        log.info(`Config job "${configJob.id}" updated`);
      }
    }
  }
}

/** Start a CronJob for a task. */
function startJob(task: ScheduledTask): void {
  if (activeJobs.has(task.id)) {
    activeJobs.get(task.id)!.stop();
    activeJobs.delete(task.id);
  }

  const cronTime = task.cronExpr ?? new Date(task.runAt!);
  const isOneOff = !!task.runAt;

  const job = CronJob.from({
    cronTime,
    onTick: () => { executeJob(task.id, isOneOff).catch(e => log.error(`Job ${task.id} unhandled error:`, e)); },
    timeZone: task.cronExpr ? task.timezone : undefined,
    start: true,
  });

  activeJobs.set(task.id, job);
}

/** Execute a scheduled job — send the prompt to the channel. */
async function executeJob(taskId: string, isOneOff: boolean): Promise<void> {
  if (!deps) {
    log.error(`Scheduler deps not initialized, skipping job ${taskId}`);
    return;
  }

  const task = getScheduledTask(taskId);
  if (!task || !task.enabled) return;

  const now = new Date().toISOString();
  log.info(`Executing job ${taskId}: "${task.prompt.slice(0, 80)}"`);

  try {
    await deps.sendMessage(task.channelId, task.prompt);

    insertTaskHistory({
      taskId: task.id, channelId: task.channelId,
      prompt: task.prompt, description: task.description,
      timezone: task.timezone,
      status: 'success',
    });

    // Update last_run and next_run
    let nextRun: string | undefined;
    if (task.cronExpr) {
      const job = activeJobs.get(taskId);
      if (job) {
        nextRun = job.nextDate().toISO() ?? undefined;
      }
    }
    updateScheduledTaskLastRun(taskId, now, nextRun);
  } catch (err: any) {
    log.error(`Job ${taskId} execution failed: ${err?.message}`);
    try {
      insertTaskHistory({
        taskId: task.id, channelId: task.channelId,
        prompt: task.prompt, description: task.description,
        timezone: task.timezone,
        status: 'error', error: err?.message,
      });
    } catch (histErr: any) {
      log.error(`Failed to record task history for ${taskId}: ${histErr?.message}`);
    }
  }

  // One-off jobs: delete after execution (they won't run again)
  if (isOneOff) {
    const job = activeJobs.get(taskId);
    if (job) job.stop();
    activeJobs.delete(taskId);
    deleteScheduledTask(taskId);
    log.info(`One-off job ${taskId} completed and removed`);
  }
}
