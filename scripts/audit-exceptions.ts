import { runAudit } from './lib/exceptions.ts';

process.exitCode = await runAudit(process.cwd(), (line) => {
  console.log(line);
});
