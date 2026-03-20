import { CronJob } from 'cron';
import cronstrue from 'cronstrue';
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { createLogger } from '../logger.js';
import {
  getEnabledScheduledTasks, getAllScheduledTasks, insertScheduledTask, upsertScheduledTask, deleteScheduledTask,
  updateScheduledTaskEnabled, updateScheduledTaskLastRun,
  getScheduledTasksForChannel, getScheduledTask,
  insertTaskHistory,
  type ScheduledTask,
} from '../state/store.js';

const log = createLogger('scheduler');

interface SchedulerDeps {
  /** Send a prompt to a channel's session (creates/resumes as needed). */
  sendMessage: (channelId: string, prompt: string) => Promise<string>;
  /** Post a notification to a channel (no LLM, just a message). */
  postMessage: (channelId: string, text: string) => Promise<void>;
}

// Active CronJob instances keyed by task ID
const activeJobs = new Map<string, CronJob>();

/**
 * Predefined prompts for built-in scheduled job types.
 * These are the "handlers" referenced in the scheduler config.
 */
export const JOB_PROMPTS: Readonly<Record<string, string>> = {
  'morning-briefing':
    'Please perform the morning briefing:\n' +
    '1. List today\'s calendar meetings with times\n' +
    '2. Summarize overnight emails (received since yesterday 5 PM) — filter to those sent directly TO me, not just CC\n' +
    '3. List any open tasks or unresolved action items from yesterday\n' +
    '4. For each meeting today, check whether an account match exists in accounts.json and provide a brief context note\n' +
    '\nIf any meetings start within the next 90 minutes, also perform meeting prep: match the meeting to an account, ' +
    'read the account note from Obsidian if available, pull recent emails and Teams messages about the account via WorkIQ, ' +
    'and include a prep brief in the summary.\n' +
    '\nFormat the output with clear sections: 📅 Calendar, 📧 Overnight Emails, ✅ Open Items, and 🤝 Meeting Prep.',

  'email-scan':
    'Please perform an email scan:\n' +
    '1. Using WorkIQ, retrieve emails received in the last 2 hours\n' +
    '2. Filter to emails sent directly TO me (not just CC or BCC)\n' +
    '3. For each email, provide: sender, subject, and a one-line summary\n' +
    '4. Flag any that appear urgent or require immediate action\n' +
    '\nAlso check the calendar for any meetings starting in the next 90 minutes. ' +
    'If an upcoming meeting matches an account in accounts.json, include a quick meeting prep note.\n' +
    '\nFormat the output with sections: 🚨 Urgent / Action Required, 📬 New Emails, and 🤝 Upcoming Meeting Prep (if applicable).',

  'meeting-prep':
    'Please perform meeting preparation for upcoming meetings:\n' +
    '1. Check the calendar for meetings starting in the next 90 minutes\n' +
    '2. For each upcoming meeting, match the title and attendees to an account in accounts.json\n' +
    '3. If a match is found:\n' +
    '   a. Read the account note from Obsidian\n' +
    '   b. Pull recent emails about the account via WorkIQ\n' +
    '   c. Pull recent Teams messages about the account via WorkIQ\n' +
    '   d. Read pipeline data from accounts.json\n' +
    '   e. Compile a meeting prep brief\n' +
    '4. If no account match is found, note the meeting with any available context\n' +
    '\nIf no meetings are starting in the next 90 minutes, reply: "No meetings in the next 90 minutes."\n' +
    'Post the prep brief to #account-prep.',

  'evening-recap':
    'Please perform the evening recap:\n' +
    '1. Summarize what was accomplished today based on calendar, emails, and tasks\n' +
    '2. List any unresolved items, open action items, or pending follow-ups\n' +
    '3. Preview tomorrow\'s calendar — list meetings and flag any that need prep\n' +
    '\nFormat the output with sections: ✅ Accomplished Today, 📋 Open Items, and 📅 Tomorrow\'s Preview.',

  'weekly-pipeline':
    'Please perform the weekly pipeline review:\n' +
    '1. Read all accounts from accounts.json\n' +
    '2. For each account, summarize: name, motion status, priority, and monthly potential\n' +
    '3. Identify accounts with renewals due in the next 90 days\n' +
    '4. Flag any accounts with risk indicators: stalled motion, missed follow-up, or urgent priority\n' +
    '5. Highlight any accounts that need immediate attention this week\n' +
    '\nFormat the output with sections: 📊 Active Pipeline, 🔄 Upcoming Renewals, and 🚨 Risk Flags.',
};

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

/**
 * Load (or reload) config-defined scheduled jobs.
 * - Creates the job in the DB if it doesn't exist yet (using the `enabled` flag from config).
 * - Updates the cron/prompt/timezone if the config changed, preserving the user's enabled state.
 * - If a job ID has no built-in prompt handler, it is skipped with a warning.
 *
 * Call this after `initScheduler()` once config and channels are resolved.
 */
export function loadConfigJobs(
  jobs: ReadonlyArray<{
    id: string;
    cron: string;
    channelId: string;
    botName: string;
    enabled: boolean;
    timezone: string;
  }>,
): void {
  for (const jobDef of jobs) {
    const prompt = JOB_PROMPTS[jobDef.id];
    if (!prompt) {
      log.warn(`Scheduler: no built-in handler for job id "${jobDef.id}" — skipping. Known ids: ${Object.keys(JOB_PROMPTS).join(', ')}`);
      continue;
    }

    try {
      // Validate the cron expression and compute the next run time
      const probe = CronJob.from({ cronTime: jobDef.cron, onTick: () => {}, timeZone: jobDef.timezone, start: false });
      const nextRun = probe.nextDate().toISO() ?? undefined;

      const result = upsertScheduledTask({
        id: jobDef.id,
        channelId: jobDef.channelId,
        botName: jobDef.botName,
        prompt,
        cronExpr: jobDef.cron,
        timezone: jobDef.timezone,
        description: jobDef.id,
        enabled: jobDef.enabled,
        nextRun,
      });

      // Re-read from DB to get the actual enabled state (upsert preserves it on update)
      const stored = getScheduledTask(jobDef.id);
      if (stored?.enabled) {
        startJob({ ...stored, cronExpr: jobDef.cron, prompt, timezone: jobDef.timezone });
      } else if (activeJobs.has(jobDef.id)) {
        // Job was disabled by user — stop the active timer
        activeJobs.get(jobDef.id)!.stop();
        activeJobs.delete(jobDef.id);
      }

      log.info(`Config job "${jobDef.id}" ${result} (enabled=${stored?.enabled ?? false})`);
    } catch (err: any) {
      log.error(`Failed to load config job "${jobDef.id}": ${err?.message}`);
    }
  }
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

/** List all jobs across every channel (enabled + paused recurring). */
export function listAllJobs(): ScheduledTask[] {
  return getAllScheduledTasks();
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

