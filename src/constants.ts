import * as path from 'path';
import * as os from 'os';
import type { PhaseMeta } from './types';

// Package layout. dist/constants.js -> package root (ovtools/).
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');
export const COMMON_ASSETS_DIR = path.join(ASSETS_DIR, 'common');
export const DASHBOARD_DIR = path.join(ASSETS_DIR, 'manage', 'dashboard_monitor');
export const TASK_ASSET_DIRS: Record<'deploy' | 'migrate' | 'manage' | 'upgrade', string> = {
  deploy: path.join(ASSETS_DIR, 'deploy'),
  migrate: path.join(ASSETS_DIR, 'migrate'),
  manage: path.join(ASSETS_DIR, 'manage'),
  upgrade: path.join(ASSETS_DIR, 'upgrade'),
};
export const DEFAULT_ASSETS_REPO = 'https://github.com/m-tq/ovtools.git';

// Writable state lives in the user's home so a global npm install works on
// Windows and Linux without touching the package directory.
export const OVTOOLS_HOME = process.env.OVTOOLS_HOME
  ? path.resolve(process.env.OVTOOLS_HOME)
  : path.join(os.homedir(), '.ovtools');
export const LOGS_DIR = path.join(OVTOOLS_HOME, 'logs');
export const BACKUP_DIR = path.join(OVTOOLS_HOME, 'backups');
export const TMP_DIR = path.join(OVTOOLS_HOME, 'tmp');
export const KEYS_DIR = path.join(TMP_DIR, 'keys');
export const CERTS_DIR = path.join(TMP_DIR, 'certs');
export const SETTINGS_FILE = path.join(OVTOOLS_HOME, 'settings.json');
export const HOST_KEYS_FILE = path.join(OVTOOLS_HOME, 'hostkeys.json');
export const KNOWN_HOSTS_FILE = path.join(OVTOOLS_HOME, 'known_hosts');

// VPS constants
export const NODE_API_PORT = 8080;
export const NODE_DATA_ROOT = '/var/lib/octra';
export const NODE_DATA_DIR = `${NODE_DATA_ROOT}/devnet`;
export const NODE_SRC_DIR = '/opt/octra/libv_litecore';
export const NODE_USER = 'octra';
export const NODE_WALLET_PATH = `${NODE_SRC_DIR}/.keys/validator/wallet.json`;
export const DATA_LABEL = 'octra-data';
export const DATA_MIN_GB = 1000;

// Token decimals
export const TOKEN_DECIMALS = 6;
export const TOKEN_UNIT = Math.pow(10, TOKEN_DECIMALS);

// Timeouts and intervals
export const PROBE_TTL_MS = 8000;
export const RETRY_PAUSE = 5;
export const VERIFY_SAMPLES = 3;
export const VERIFY_INTERVAL = 20;
export const DEFAULT_ROLE = 'validator';
export const DASHBOARD_DOMAIN_SUFFIX = 'example.com';

// SSH timeouts
export const SSH_CONNECT_TIMEOUT = 20000;
export const SSH_EXEC_TIMEOUT = 300000;
export const SSH_HEARTBEAT = 30000;

// Buffer limits
export const BUFFER_MAX = 6000;
export const LOG_BUFFER_MAX = 4000;

// Remote program state directories
export const REMOTE = {
  deploy: '/root/deploy',
  migrate: '/root/migration',
  manage: '/root/manage',
  upgrade: '/root/upgrade',
  dashboard: '/root/dashboard',
  dashboardInstall: '/opt/octra/dashboard',
} as const;

export const STATE_FILES = {
  deploy: path.join(LOGS_DIR, 'deploy-state.json'),
  migrate: path.join(LOGS_DIR, 'all-state.json'),
  manage: path.join(LOGS_DIR, 'manage-state.json'),
  upgrade: path.join(LOGS_DIR, 'upgrade-state.json'),
} as const;

export const MIGRATE_PHASES: PhaseMeta[] = [
  { id: 'auto', label: 'Migrate node', desc: 'check -> backup -> prep -> pull -> switch -> finalize -> verify, then watch the chain activate the migrated validator. The monitoring dashboard is a Manage active node action.', risk: 'critical', confirm: 'MIGRATE' },
  { id: 'backup', label: 'Backup identity', desc: 'Snapshot wallet/keys on the source and copy the archive here.', risk: 'safe', confirm: null },
  { id: 'prep', label: 'Prepare target', desc: 'pre-run.sh (8 GB swap + 1 TB volume) plus tooling on the new VPS.', risk: 'safe', confirm: null },
  { id: 'pull', label: 'Pull state', desc: 'Copy ~41 GB while the source keeps voting. No downtime.', risk: 'safe', confirm: null },
  { id: 'switch', label: 'Switch', desc: 'STOP the source node, then sync the delta. Downtime starts here.', risk: 'critical', confirm: 'STOP SOURCE' },
  { id: 'finalize', label: 'Finalize target', desc: 'Advertise endpoint, hash gate, pm2 install, --check-runtime.', risk: 'safe', confirm: null },
  { id: 'verify', label: 'Start + verify', desc: 'Start the node, wait for RPC + set-fold re-admission, assert voting.', risk: 'safe', confirm: null },
  { id: 'all', label: 'Run everything', desc: 'backup -> prep -> pull -> switch -> finalize -> verify, in order.', risk: 'critical', confirm: 'MIGRATE' },
  { id: 'rollback', label: 'Rollback', desc: 'Stop the target and bring the source validator back.', risk: 'critical', confirm: 'ROLLBACK' },
  { id: 'status', label: 'Status', desc: 'Read both hosts and print the migration status markers.', risk: 'readonly', confirm: null },
];

export const DEPLOY_PHASES: PhaseMeta[] = [
  { id: 'deploy', label: 'Deploy node', desc: 'check -> prep -> toolchain -> setup -> start -> verify, then the top-up popup and enroll/promote when funded.', risk: 'critical', confirm: 'DEPLOY' },
  { id: 'prep', label: 'Prepare host', desc: '8 GB swap + data store (pre-run.sh) + base tooling + directory layout.', risk: 'safe', confirm: null },
  { id: 'toolchain', label: 'Build runtime', desc: 'install-deps.sh: apt deps + OCaml/dune toolchain (15-30 min, detached).', risk: 'safe', confirm: null },
  { id: 'setup', label: 'Configure node', desc: 'node-setup.sh: wallet.json + node.env, build + ~38 GB chain sync.', risk: 'safe', confirm: null },
  { id: 'start', label: 'Start node', desc: 'Start via pm2 and wait until rpc = ready.', risk: 'safe', confirm: null },
  { id: 'verify', label: 'Verify node', desc: 'process/rpc/role/p2p + epoch advancing (validator: voting + active).', risk: 'safe', confirm: null },
  { id: 'enroll', label: 'Enroll validator', desc: 'controls/enroll.sh join --amount <raw> - needs a funded wallet. The chain then admits the validator at the set fold.', risk: 'critical', confirm: 'ENROLL' },
  { id: 'promote', label: 'Promote', desc: 'Wait for the set fold and the first duty epoch, then switch observer -> validator.', risk: 'critical', confirm: 'PROMOTE' },
  { id: 'status', label: 'Status', desc: 'Print the deploy status marker of the target.', risk: 'readonly', confirm: null },
];

export const MANAGE_PHASES: PhaseMeta[] = [
  { id: 'bond', label: 'Increase bond', desc: 'Run bond_inc.sh as the octra user (+OCT on the bond), then verify the registry. The first increase runs plain, every later one with --new (added automatically).', risk: 'critical', confirm: 'BOND' },
  { id: 'exit', label: 'Exit validator', desc: 'controls/enroll.sh exit -> wait for the set fold + unbonding -> withdraw -> wait until the stake is back in the wallet. The node is NOT deleted.', risk: 'critical', confirm: 'EXIT' },
  { id: 'upgrade', label: 'Update node', desc: 'controls/upgrade.sh (test run first, then --apply): pull, build, restart, wait and verify. The verdict is the tool\'s own: validator_active / observer_synced = done, pending = re-run later (never restart by hand), refused = see the reason.', risk: 'critical', confirm: 'UPGRADE' },
  { id: 'manual', label: 'Manual update (fallback)', desc: 'The README\'s manual path when the tool cannot run: git pull --ff-only, controls/check.sh, make -C mcl, dune build (5 targets), stop.sh, run.sh --rebind-runtime, stat.sh.', risk: 'critical', confirm: 'UPDATE' },
  { id: 'storage', label: 'Remove preserved states', desc: 'controls/storage.sh report -> --prune-prior --yes -> report: drops the states of the previous epochs.', risk: 'critical', confirm: 'PRUNE' },
  { id: 'dashboard', label: 'Deploy monitor (read-only)', desc: 'nginx + octra-dashboard, read-only: graphs, logs, wallet and consensus. The manage actions stay in this tab, never on the public page.', risk: 'safe', confirm: null },
  { id: 'diagnose', label: 'Diagnose node (why is it not voting?)', desc: 'Read-only evidence: pm2 state, /rpc vs /status, head_epoch moving or frozen, how far behind, last catch-up refusal, rejoin.sh --check and enrollment state.', risk: 'safe', confirm: null },
  { id: 'recover', label: 'Fix a stuck node (ready / outside set)', desc: 'Bounded repair path: clean pm2 restart when frozen, pm2 re-create when the data directory is used outside PM2, bounded catch-up wait, rejoin/join. Never signs a new bond, never exits, never replaces the store.', risk: 'critical', confirm: 'RECOVER' },
  { id: 'status', label: 'Read status', desc: 'Identity, membership, bond, wallet balance, the running version and the saved bond-increase record.', risk: 'readonly', confirm: null },
];

export const PROGRAMS = [
  { id: 'deploy' as const, label: 'Deploy fresh node', desc: 'Turn one fresh VPS into an Octra node, observer or validator.', hosts: 'single' as const, phases: DEPLOY_PHASES },
  { id: 'migrate' as const, label: 'Migrate node', desc: 'Move the running validator to a new VPS (source + target).', hosts: 'pair' as const, phases: MIGRATE_PHASES },
  { id: 'manage' as const, label: 'Manage active node', desc: 'Operate the node that already runs: increase the bond, exit it (stake back), update its software, prune preserved states, or deploy the read-only monitoring dashboard.', hosts: 'single' as const, phases: MANAGE_PHASES },
];

export function phaseMeta(program: string, phase: string): PhaseMeta | undefined {
  const p = PROGRAMS.find(x => x.id === program) || PROGRAMS[0];
  return p.phases.find(x => x.id === phase);
}
