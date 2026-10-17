// Kosko 537 rule 3 — writes src/mcp/shapes-baseline.json: the shape check's recording of the fake MCP server W4 was
// proved on (test/fake-mcp/shapes-fixture.mjs). Run it after any change to what the fake answers, and commit the two
// together; shapes-baseline.test.mjs fails until you do. Never edit the JSON by hand.
import { writeFileSync } from 'node:fs';
import { baselineFromFake } from '../test/fake-mcp/shapes-fixture.mjs';

const file = new URL('../src/mcp/shapes-baseline.json', import.meta.url);
writeFileSync(file, `${JSON.stringify(await baselineFromFake(), null, 2)}\n`);
console.log(`wrote ${file.pathname}`);
