#!/usr/bin/env node

import { executeCli } from "../entry/execute.js";

process.exitCode = await executeCli(process.argv.slice(2), process.env, {
  input: process.stdin,
  stderr: process.stderr,
  stdout: process.stdout,
});
