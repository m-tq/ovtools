export interface HostAuth {
  method: 'password' | 'key';
  password?: string;
  keyPath?: string;
}

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  auth: HostAuth;
  hostKeyFingerprint?: string;
  strictHostKey?: boolean;
  ignorePinnedHostKey?: boolean;
}

export interface RemoteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  lines: string[];
  timedOut: boolean;
}

export interface StepResult {
  success: boolean;
  output: RemoteResult;
  error?: string;
}

export interface PhaseState {
  phase: string;
  started: Date;
  completed?: Date;
  success?: boolean;
  error?: string;
}

export interface AllState {
  pair: string;
  steps: string[];
  updated: string;
}

export interface DeployConfig {
  ip: string;
  auth: HostAuth;
  nodeName?: string;
  role: 'observer' | 'validator';
  bond: number;
  domain?: string;
  swapGB: number;
  dataDevice: string;
  dataMinGB: number;
  skipDashboard?: boolean;
  apiPort?: number;
  samples?: number;
  interval?: number;
  peerWaitSec?: number;
  voteWaitSec?: number;
  reset?: boolean;
  wipeVolume?: boolean;
  keepData?: boolean;
  allowFormat?: boolean;
  phase?: string;
}

export interface MigrateConfig {
  oldIp: string;
  oldAuth: HostAuth;
  newIp: string;
  newAuth: HostAuth;
  wipeTargetVolume: boolean;
  keepTargetData: boolean;
  allowFormat?: boolean;
  phase?: string;
  samples?: number;
  interval?: number;
  statusTimeoutMin?: number;
  reset?: boolean;
}

export type ManagePhase =
  | 'status'
  | 'bond'
  | 'exit'
  | 'dashboard'
  | 'diagnose'
  | 'recover'
  | 'upgrade'
  | 'manual'
  | 'storage';

export interface ManageConfig {
  ip: string;
  auth: HostAuth;
  phase: ManagePhase;
  amount?: string;
  newBond?: boolean;
  domain?: string;
  sslMode?: 'auto' | 'cloudflare' | 'certbot';
  certDir?: string;
  email?: string;
  testOnly?: boolean;
  noRestart?: boolean;
  reset?: boolean;
  waitSeconds?: number;
  extra?: string;
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'step' | 'remote' | 'data';

export interface LogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  line: string;
  host?: string;
  program?: string;
}

export interface JobRequest {
  program: 'deploy' | 'migrate' | 'manage';
  phase: string;
  oldIp?: string;
  newIp?: string;
  oldPassword?: string;
  newPassword?: string;
  oldAuth?: string;
  newAuth?: string;
  oldKey?: string;
  newKey?: string;
  sameAuth?: boolean;
  role?: string;
  bondOct?: number;
  bond?: number;
  amount?: string;
  newBond?: boolean;
  domain?: string;
  sslMode?: string;
  certDir?: string;
  email?: string;
  testOnly?: boolean;
  noRestart?: boolean;
  reset?: boolean;
  waitSeconds?: number;
  extra?: string;
  approved?: boolean;
  confirm?: string;
  funded?: boolean;
  nodeName?: string;
  wipeVolume?: boolean;
  keepData?: boolean;
  wipeTargetVolume?: boolean;
  keepTargetData?: boolean;
  allowFormat?: boolean;
}

export interface JobProgress {
  pct: number;
  bytes: string;
  rate: string;
  eta?: string;
}

export interface JobLabel {
  ip: string;
  label: string;
}

export interface JobWaiting {
  action: 'enroll';
  ip: string;
  address?: string;
  bond: number;
}

export interface JobActivation {
  id: string;
  ip: string;
  epoch?: number;
  bond?: number;
}

export interface JobWatching {
  ip: string;
  since: number;
  phase?: string;
  activation?: boolean;
  state?: string;
  detail?: string;
  checkedAt?: number;
  reachable?: boolean;
  epoch?: number | null;
  headEpoch?: number | null;
  enrollment?: string | null;
  active?: boolean;
  scheduled?: boolean;
  problem?: string | null;
}

export interface DiskPlan {
  action: 'format' | 'keep' | 'fallback' | 'none';
  program: string;
  ip: string;
  device: string | null;
  disk: string | null;
  sizeGB: number | null;
  fstype: string | null;
  label: string | null;
  mountpoint: string | null;
  systemDisk: boolean;
  hasDataset: boolean;
  hasChain: boolean;
  model: string | null;
  reason: string;
  lsblk: string;
}

export interface JobStep {
  id: string;
  label: string;
  goal: string;
}

export interface StepPlan {
  goal: string;
  steps: JobStep[];
}

export interface JobStepInfo extends StepPlan {
  index: number;
  status: 'running' | 'waiting' | 'done' | 'failed';
}

export interface JobState {
  running: boolean;
  program?: string;
  phase?: string;
  step?: string;
  label?: JobLabel | null;
  progress?: JobProgress | null;
  status?: { state: string; detail: string } | null;
  idleSec?: number;
  exitCode?: number | null;
  startedAt?: number;
  elapsedSec?: number;
  lastSeq?: number;
  newIp?: string;
  oldIp?: string;
  domain?: string;
  awaiting?: JobWaiting | null;
  activation?: JobActivation | null;
  watching?: JobWatching | null;
  stepInfo?: JobStepInfo | null;
  exitWatching?: { ip: string } | null;
  exitInfo?: {
    id: string;
    ip: string;
    done: boolean;
    exit_epoch?: string;
    withdraw_epoch?: string;
    remaining?: number | null;
    eta?: string;
    active?: boolean;
    scheduled?: boolean;
  } | null;
}

export interface NodeSummary {
  ip: string;
  state: string;
  reachable: boolean;
  error?: string | null;
  epoch?: number | null;
  head_epoch?: number | null;
  accounts?: number | null;
  network?: string | null;
  address?: string | null;
  bond?: string | number | null;
  bondOct?: number | null;
  enrollment?: string | null;
  active?: boolean;
  scheduled?: boolean;
  next_set_epoch?: number | null;
  duty_automatic?: boolean;
  ts: number;
}

export interface CheckRow {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
}

export interface CheckResult {
  ready: boolean;
  readyManage?: boolean;
  readyUpgrade?: boolean;
  program: string;
  sourceIp?: string;
  targetIp?: string;
  items: CheckRow[];
  counts: { ok: number; warn: number; fail: number };
  durationMs: number;
  checkedAt: number;
  needsTrust?: string[];
}

export interface CheckEnvelope {
  key: string;
  ts: number;
  age: number;
  result: CheckResult;
}

export interface Settings {
  swapGB: number;
  dataDevice: string;
  dataMinGB: number;
  dashboardDomain: string;
  assetsRepo?: string;
  assetsRef?: string;
}

export interface PhaseMeta {
  id: string;
  label: string;
  desc: string;
  risk: 'safe' | 'critical' | 'readonly';
  confirm: string | null;
}

export interface ProgramMeta {
  id: string;
  label: string;
  desc: string;
  hosts: 'single' | 'pair';
  phases: PhaseMeta[];
  orchestrator: string;
  orchestratorPresent: boolean;
}
