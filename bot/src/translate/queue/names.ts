const QUEUE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Queue names carry the environment so a test bot and the production bot (or a
 * worker pointed at the wrong one) can never consume each other's jobs:
 * translate-gemma4-prod, translate-gemma4-test.
 */
export function translationQueueName(model: string, envLabel: string): string {
  const clean = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const m = clean(model);
  const e = clean(envLabel);
  if (!m) throw new Error("queue model name is empty");
  if (!e) throw new Error("queue environment label is empty (set TRANSLATION_QUEUE_ENV)");
  const name = `translate-${m}-${e}`;
  if (!QUEUE_NAME.test(name)) throw new Error(`queue name "${name}" is not valid (max 64 chars, a-z 0-9 _ -)`);
  return name;
}
