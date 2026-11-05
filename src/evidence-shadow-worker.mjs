import { createEvidenceShadow } from './evidence-shadow.mjs';

let received = false;
process.on('message', message => {
  if (received) { process.exitCode = 1; process.disconnect(); return; }
  received = true;
  try {
    const result = createEvidenceShadow({ enabled: true }).observe(message?.query, message?.hits);
    process.send(result, error => { if (error) process.exitCode = 1; process.disconnect(); });
  } catch { process.exitCode = 1; process.disconnect(); }
});
