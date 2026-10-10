// The tool's version, from package.json. A JSON import, so a bundle (Kosko 538) carries the value instead of reading
// a file next to a module that, inside a single executable, is not on disk.
import pkg from '../package.json' with { type: 'json' };

export const TOOL_VERSION = pkg.version;
