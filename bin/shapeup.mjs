#!/usr/bin/env node
import { ShapeUpError } from '../src/domain.mjs';
import { main } from '../src/cli.mjs';

main().then(code => { process.exitCode = code; }, error => {
  console.error(error instanceof ShapeUpError ? error.message : `Internal error: ${error.message}`);
  process.exitCode = 2;
});
