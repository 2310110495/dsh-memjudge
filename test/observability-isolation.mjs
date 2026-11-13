// Preload before ANY plugin/config imports in regression worker processes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-observability-regression-'));
process.env.DSH_HOME = isolatedHome;
process.on('exit', () => fs.rmSync(isolatedHome, { recursive: true, force: true }));
