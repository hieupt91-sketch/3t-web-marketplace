/** Best-effort process termination for locally spawned demo/site servers. */
export function killPid(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000).unref?.();
  } catch {
    /* already gone */
  }
}
