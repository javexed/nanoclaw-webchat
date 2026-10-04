/**
 * Per-agent-group container env worked out asynchronously before a spawn.
 *
 * The container-env seam is sync, so a session prepare hook computes the env
 * and stages it, and the resolver reads what was staged. The staged value is
 * only replaced once the new one is ready: another spawn in the same group,
 * prepared meanwhile, reads the previous env rather than none.
 */
export interface StagedEnv {
  prepare(agentGroupId: string): Promise<void>;
  resolve(agentGroupId: string): Record<string, string>;
}

export function stagedEnv(compute: (agentGroupId: string) => Promise<Record<string, string>>): StagedEnv {
  const staged = new Map<string, Record<string, string>>();
  return {
    async prepare(agentGroupId) {
      let env: Record<string, string>;
      try {
        env = await compute(agentGroupId);
      } catch (err) {
        // Never spawn on an env this failure has made stale.
        staged.delete(agentGroupId);
        throw err;
      }
      staged.set(agentGroupId, env);
    },
    resolve: (agentGroupId) => staged.get(agentGroupId) ?? {},
  };
}
