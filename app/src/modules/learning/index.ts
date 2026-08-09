/**
 * Learning loop module — registers the `propose_skill` delivery action and
 * the curator's host-sweep task. See docs/webchat/design/learning-loop.md.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerSweepTask } from '../../host-sweep.js';
import { unguarded } from '../../guard/index.js';
import { handleProposeSkill } from './request.js';
import { handleRouteLearningReview } from './route-review.js';
import { sweepStaleScopedSkills } from './curator.js';

registerDeliveryAction(
  'propose_skill',
  handleProposeSkill,
  unguarded(
    'stages a draft for human review only — nothing executes or lands in agent context until an admin keeps it',
  ),
);

registerDeliveryAction(
  'route_learning_review',
  handleRouteLearningReview,
  unguarded(
    "forwards a /learn to the invoker's own session (their credential) or applies the decline/role policy — " +
      'writes one review-request message within the same agent group; no privileged state changes',
  ),
);

// Curator: archive scoped skills nothing has invoked in months (learning loop
// §6). Registered on the host-sweep seam (H7); self-gated to one real run per
// day inside sweepStaleScopedSkills.
registerSweepTask('learning-curator', async () => {
  await sweepStaleScopedSkills();
});

export * from './master.js';
