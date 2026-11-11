#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const distPath = path.join(__dirname, '..', 'dist', 'cli.js');
if (!fs.existsSync(distPath)) {
  console.error('ovtools is not built (dist/cli.js is missing). Run: npm run build');
  process.exit(1);
}

let cli;
try {
  cli = require(distPath);
} catch (err) {
  console.error('ovtools failed to load:', err && err.message ? err.message : err);
  process.exit(1);
}

const main = cli && typeof cli.main === 'function' ? cli.main : null;
if (!main) {
  console.error('ovtools is corrupted: dist/cli.js does not export main()');
  process.exit(1);
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = typeof code === 'number' ? code : 0;
}).catch(err => {
  console.error(`ERROR: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
