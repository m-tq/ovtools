import type { JobStep, StepPlan } from './types';

const DEPLOY: Record<string, JobStep> = {
  prep: {
    id: 'prep',
    label: 'Prepare host',
    goal: '8 GB swap, the 1 TB data store and the base tools are ready.',
  },
  toolchain: {
    id: 'toolchain',
    label: 'Build runtime',
    goal: 'The OCaml/dune toolchain is installed and usable.',
  },
  setup: {
    id: 'setup',
    label: 'Configure node',
    goal: 'Identity and node.env are written; the node is built and the chain is synced.',
  },
  start: {
    id: 'start',
    label: 'Start node',
    goal: 'The node process is online and its RPC answers.',
  },
  verify: {
    id: 'verify',
    label: 'Verify node',
    goal: 'The node follows the chain with the correct role and peers.',
  },
  enroll: {
    id: 'enroll',
    label: 'Enroll validator',
    goal: 'The bond is accepted and enrollment is ready on chain.',
  },
  promote: {
    id: 'promote',
    label: 'Promote validator',
    goal: 'The set fold admits the validator and voting becomes active.',
  },
  dashboard: {
    id: 'dashboard',
    label: 'Deploy monitor',
    goal: 'The read-only monitoring dashboard is online.',
  },
};

const MIGRATE: Record<string, JobStep> = {
  backup: {
    id: 'backup',
    label: 'Backup identity',
    goal: 'Wallet and validator keys are archived on the source and copied locally.',
  },
  prep: {
    id: 'prep',
    label: 'Prepare target',
    goal: 'Swap, the target data store and the migration tooling are ready.',
  },
  pull: {
    id: 'pull',
    label: 'Pull state',
    goal: 'The chain state is copied while the source keeps voting.',
  },
  switch: {
    id: 'switch',
    label: 'Switch',
    goal: 'The source is stopped and the target has the final delta.',
  },
  finalize: {
    id: 'finalize',
    label: 'Finalize target',
    goal: 'The target identity matches the source and is ready to start.',
  },
  verify: {
    id: 'verify',
    label: 'Start + verify',
    goal: 'The target runs, syncs, and is admitted to the active set.',
  },
};

const MANAGE: Record<string, JobStep> = {
  bond: {
    id: 'bond',
    label: 'Increase bond',
    goal: 'The added bond is signed and visible in the registry.',
  },
  exit: {
    id: 'exit',
    label: 'Exit validator',
    goal: 'The validator leaves the set and the stake returns to the wallet.',
  },
  preflight: {
    id: 'preflight',
    label: 'Update preflight',
    goal: 'The update preflight checks pass on the running node.',
  },
  upgrade: {
    id: 'upgrade',
    label: 'Update node',
    goal: 'The node is updated, online, and voting (or a synced observer).',
  },
  manual: {
    id: 'manual',
    label: 'Manual update',
    goal: 'The manual pull/build/restart path completes and the node is healthy.',
  },
  storage: {
    id: 'storage',
    label: 'Prune states',
    goal: 'Preserved states of previous epochs are removed.',
  },
  dashboard: {
    id: 'dashboard',
    label: 'Deploy monitor',
    goal: 'The read-only monitoring dashboard is online.',
  },
  diagnose: {
    id: 'diagnose',
    label: 'Diagnose node',
    goal: 'The read-only diagnosis explains why the node is not voting.',
  },
  recover: {
    id: 'recover',
    label: 'Recover node',
    goal: 'The node is back in sync and re-admitted to the active set.',
  },
  status: {
    id: 'status',
    label: 'Read status',
    goal: 'Identity, bond and membership are reported.',
  },
};

const DEPLOY_ORDER = ['prep', 'toolchain', 'setup', 'start', 'verify'];
const MIGRATE_ORDER = ['backup', 'prep', 'pull', 'switch', 'finalize', 'verify'];

function stepsFrom(order: string[], table: Record<string, JobStep>): JobStep[] {
  return order.map(id => table[id]).filter(Boolean);
}

export function buildStepPlan(
  program: string,
  phase: string,
  options: { role?: string; bond?: number; dashboard?: boolean } = {}
): StepPlan | null {
  if (program === 'deploy') {
    const validator = options.role === 'validator';
    if (phase === 'deploy' || phase === 'all' || phase === 'auto') {
      const order = DEPLOY_ORDER.slice();
      if (validator) {
        order.push('enroll');
        if ((options.bond || 0) > 0) order.push('promote');
      }
      if (options.dashboard) order.push('dashboard');
      return {
        goal: validator
          ? 'Node is a validator, active and voting.'
          : 'Node is online, synced and reachable.',
        steps: stepsFrom(order, DEPLOY),
      };
    }
    const step = DEPLOY[phase];
    return step ? { goal: step.goal, steps: [step] } : null;
  }

  if (program === 'migrate') {
    if (phase === 'all' || phase === 'auto') {
      return {
        goal: 'Validator moved to the target and voting again.',
        steps: stepsFrom(MIGRATE_ORDER, MIGRATE),
      };
    }
    const step = MIGRATE[phase];
    return step ? { goal: step.goal, steps: [step] } : null;
  }

  if (program === 'manage') {
    if (phase === 'upgrade') {
      return {
        goal: 'Node updated, online, and voting (or a synced observer).',
        steps: [MANAGE.preflight, MANAGE.upgrade],
      };
    }
    const step = MANAGE[phase];
    return step ? { goal: step.goal, steps: [step] } : null;
  }

  return null;
}
