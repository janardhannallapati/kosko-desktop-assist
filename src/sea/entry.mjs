// The single executable's entry (Kosko 538): bundled by scripts/sea-bundle.mjs into one CommonJS file. The warning
// filter is imported first, so its body runs before cli.mjs's; cli.mjs reaches node:sqlite only through import().
import '../quiet-sqlite-warning.mjs';
import { main } from '../cli.mjs';

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
