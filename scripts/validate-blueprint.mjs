import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
const response = await fetch('https://render.com/schema/render.yaml.json', { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error('Cannot download Render Blueprint schema');
const schema = await response.json();
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(schema);
if (!validate(parse(await readFile('render.yaml', 'utf8')))) {
  console.error(validate.errors); process.exitCode = 1;
} else console.info('render.yaml matches the official Render Blueprint schema.');
