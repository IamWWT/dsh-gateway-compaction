import fs from 'node:fs';
import { GROUPS } from '../ui-fields.js';
const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
const output = source.replace('/* FIELD_DEFINITIONS */', `const GROUPS = ${JSON.stringify(GROUPS)};`);
fs.writeFileSync(new URL('../client.js', import.meta.url), output);
