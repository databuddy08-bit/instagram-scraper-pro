// Validates the .actor schema files before every push: `npm run validate-schema`
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2019.js';
import { validateInputSchema } from '@apify/input_schema';

const read = (p) => JSON.parse(readFileSync(new URL(`../.actor/${p}`, import.meta.url), 'utf8'));
const errors = [];

// 1. Input schema — official Apify validator
const input = read('input_schema.json');
try {
    validateInputSchema(new Ajv({ strict: false }), input);
} catch (e) {
    errors.push(`input_schema.json: ${e.message}`);
}
for (const [key, field] of Object.entries(input.properties)) {
    for (const req of ['title', 'type', 'description']) {
        if (!field[req]) errors.push(`input_schema.json: "${key}" is missing ${req}`);
    }
    if (field.default === undefined && field.prefill === undefined) errors.push(`input_schema.json: "${key}" has no default or prefill`);
}

// 2. actor.json references every schema
const actor = read('actor.json');
if (!actor.input) errors.push('actor.json: missing "input"');
if (!actor.output) errors.push('actor.json: missing "output"');
if (!actor.storages?.dataset) errors.push('actor.json: missing "storages.dataset"');

// 3. Dataset schema: fields {} + overview table listing every field it displays
const ds = read('dataset_schema.json');
if (!ds.fields || Object.keys(ds.fields).length !== 0) errors.push('dataset_schema.json: "fields" must be {}');
for (const [name, view] of Object.entries(ds.views ?? {})) {
    const listed = view.transformation?.fields ?? [];
    const props = Object.keys(view.display?.properties ?? {});
    const missing = listed.filter((f) => !props.includes(f));
    if (missing.length) errors.push(`dataset_schema.json: view "${name}" has no label for ${missing.join(', ')}`);
}
if (!ds.views?.overview) errors.push('dataset_schema.json: missing "overview" view');

// 4. Output schema links to dataset view and RUN_SUMMARY
const out = read('output_schema.json');
const templates = Object.values(out.properties ?? {}).map((p) => p.template).join(' ');
if (!templates.includes('view=overview')) errors.push('output_schema.json: no link to overview view');
if (!templates.includes('RUN_SUMMARY')) errors.push('output_schema.json: no link to RUN_SUMMARY');

if (errors.length) {
    console.error(`Schema check FAILED:\n- ${errors.join('\n- ')}`);
    process.exit(1);
}
console.log(`Schema check passed: ${Object.keys(input.properties).length} input fields, ${ds.views.overview.transformation.fields.length} overview columns, ${Object.keys(ds.views).length} views.`);
