# ovtools

Deploy, migrate and manage Octra validators from one Node.js CLI and web console.

## Features

- **Deploy** a fresh VPS as an observer or validator.
- **Migrate** a running validator to a new VPS with no manual copying.
- **Manage** an active node: bond, exit, update, diagnose, recover, prune, and
  deploy the read-only monitoring dashboard.
- **Web console** with live logs, node status, precondition checks and guided
  enrollment/activation/exit steps.
- **Resumable** operations: long steps keep running on the VPS and a retry
  continues where the last one stopped.

## Requirements

- Node.js 18 or newer on your computer (Windows, Linux or macOS).
- A Debian/Ubuntu VPS with root SSH access.

No extra SSH client or runtime is required on your computer.

## Install

```bash
npm install -g ovtools
ovtools              # start the console and open the browser
ovtools --version
ovtools help
```

Running `ovtools` with no arguments starts the web console on
`http://127.0.0.1:9091` and opens your browser. It first checks npm for a newer
release. If one exists, it asks whether to update or continue to the web GUI.
Choosing update exits the app and prints the `npm install -g` command to run
manually; choosing continue opens the console as usual. Piped or scripted runs
cannot prompt and continue to the console after printing the notice.

## Quick start

```bash
# Deploy a fresh validator
ovtools deploy --ip <vps-ip> --password '<root-password>' --bond-oct 1

# Deploy an observer
ovtools deploy --ip <vps-ip> --key ~/.ssh/id_ed25519 --role observer

# Migrate an existing validator
ovtools migrate --old-ip <old-ip> --new-ip <new-ip> \
  --old-password '<old-password>' --new-password '<new-password>'

# Manage a running node
ovtools manage --ip <vps-ip> --password '<root-password>' --phase status
ovtools manage --ip <vps-ip> --password '<root-password>' --phase bond --amount 100
ovtools manage --ip <vps-ip> --password '<root-password>' --phase dashboard
ovtools upgrade --ip <vps-ip> --password '<root-password>' --phase upgrade
```

Run `ovtools help` for all options and phases.

## Web console

```bash
ovtools web              # start and open the browser
ovtools web --no-open    # start without opening a browser
# http://127.0.0.1:9091
```

The console listens on localhost by default. If port 9091 is busy it picks the
next free port. To require an API token:

```bash
OVTOOLS_TOKEN='<secret>' ovtools web
```

## Where data lives

`~/.ovtools` holds run logs, resumable step state, downloaded identity backups,
pasted keys/certificates and pinned SSH host keys.

Passwords are kept in memory only and are never written to disk.

## Assets on the VPS

The console copies its deployment scripts to the VPS automatically. By default it
clones this repository (`https://github.com/m-tq/ovtools.git`) on the VPS and uses
only the task it needs. If cloning is not possible, it falls back to a local
transfer automatically.

To use a fork:

```bash
ovtools config --assets-repo https://github.com/<you>/ovtools.git
ovtools config
```

## Development

```bash
npm install
npm run build
npm test
```

Two terminals for the web console:

```bash
npm run dev       # rebuild on save
npm run dev:web   # restart the console on http://127.0.0.1:9099
```

## Security

- Passwords stay in memory; keys and certificates are stored with restricted
  permissions.
- Deployment assets run as root on the target VPS. Only point `--assets-repo`
  at a repository you control.
- SSH host keys are pinned. A reinstalled VPS is accepted once, logged and re-pinned.
- The web console binds to `127.0.0.1` unless you choose another host.
- One runtime dependency: `ssh2`.

## License

MIT
