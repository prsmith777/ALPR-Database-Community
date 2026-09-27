// Only stage names and durations: never query parameters, plates, or credentials.
export function createQueryTiming(label, { clock = () => performance.now(), logger = console } = {}) {
  const started = clock();
  const stages = {};
  return {
    async measure(name, operation) {
      const start = clock();
      try { return await operation(); }
      finally { stages[name] = Math.round((clock() - start) * 10) / 10; }
    },
    finish() {
      const totalMs = Math.round((clock() - started) * 10) / 10;
      if (totalMs >= 500) logger.info(label, { totalMs, stages });
    },
  };
}
