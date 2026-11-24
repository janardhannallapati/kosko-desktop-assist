// @kosko-app/enex-core/anchor (0.6.2): finding a quote's passage in its source, without the editor schema or the
// ENEX reader. A bundler that cannot drop unused exports (Metro, for Kosko's phone app) loads only these files.
export { anchorText, makeAnchor } from './anchor-text.js';
export { findPassage, PASSAGE_PLACES_MAX } from './find-passage.js';
export { isLetterBoundary } from './letter-boundary.js';
export { readQuoteSource, readSourceAnchor } from '../leaves/quote-source.js';
