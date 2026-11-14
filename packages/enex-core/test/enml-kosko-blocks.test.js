// @vitest-environment jsdom
//
// Kosko 726 / 728: reading the 0.5.0 blocks back from an Evernote file.
//
// Kosko's export marks its own blocks with custom CSS properties (`--kosko-callout:tip`), the way Evernote
// marks a code block with `--en-codeblock`. ENML allows `style` and nothing like `data-*`. The file is
// untrusted: a marker's value is matched to a fixed list, a width is parsed to a number, a cell colour is
// matched to the nearest shade NAME. Nothing from the file is copied into the note as a style.
import { describe, it, expect } from 'vitest';
import { conv, nodesOf, textOf, topTypes } from './support/convert-harness.js';
import { KOSKO_ENML, ENML_COLUMN_PX, NOTE_PALETTE, CELL_SHADES, cellShadeOfColour } from '../src/index.js';

const media = (extra = '') => `<en-media type="image/png" hash="0123456789abcdef0123456789abcdef"${extra}/>`;

describe('the markers are one fixed set, exported for Kosko\'s exporter', () => {
  it('names eight properties and the column width a pixel width is read against', () => {
    expect(KOSKO_ENML).toEqual({
      callout: '--kosko-callout', calloutLabel: '--kosko-callout-label',
      toggle: '--kosko-toggle', toggleSummary: '--kosko-toggle-summary', toggleBody: '--kosko-toggle-body',
      contents: '--kosko-contents', caption: '--kosko-caption', width: '--kosko-width'
    });
    expect(ENML_COLUMN_PX).toBe(720);
    expect(Object.keys(NOTE_PALETTE.cellLight)).toEqual(CELL_SHADES);
  });
});

describe('callout', () => {
  const callout = (kind, inner) =>
    `<div style="--kosko-callout:${kind}; background-color:#e7f9ed; padding:8px 12px;">` +
    `<div style="--kosko-callout-label:1; font-weight:bold;">Tip</div>${inner}</div>`;

  it('a marked div becomes a callout of that kind, and the label line is dropped', () => {
    const { doc } = conv(callout('tip', '<div>Carry cash.</div><ul><li><div>no ATM</div></li></ul>'));
    expect(topTypes(doc)).toEqual(['callout']);
    const [c] = nodesOf(doc, 'callout');
    expect(c.attrs).toEqual({ kind: 'tip' });
    expect(c.content.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(textOf(c)).toBe('Carry cash.no ATM');
  });

  it.each(['note', 'info', 'tip', 'warning', 'danger'])('reads the kind %s', (kind) => {
    expect(nodesOf(conv(callout(kind, '<div>x</div>')).doc, 'callout')[0].attrs.kind).toBe(kind);
  });

  it('an unknown kind reads as note; nothing of the value is stored', () => {
    const { doc } = conv(callout('party(onload)', '<div>x</div>'));
    expect(nodesOf(doc, 'callout')[0].attrs).toEqual({ kind: 'note' });
    expect(JSON.stringify(doc)).not.toContain('party');
  });

  it('copies no colour from the file', () => {
    const { doc } = conv(callout('tip', '<div>x</div>'));
    expect(JSON.stringify(doc)).not.toMatch(/e7f9ed|background|padding/);
  });

  it('a callout whose text sits directly in the div keeps it as one paragraph', () => {
    const { doc } = conv('<div style="--kosko-callout:info;">Trains run late on Sundays</div>');
    const [c] = nodesOf(doc, 'callout');
    expect(c.content.map((n) => n.type)).toEqual(['paragraph']);
    expect(textOf(c)).toBe('Trains run late on Sundays');
  });

  it('Telugu, Hindi and Kannada text survives', () => {
    const { doc } = conv(callout('warning', '<div>వర్షం పడితే జారుతుంది</div><div>बारिश में फिसलन</div><div>ಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ</div>'));
    expect(textOf(nodesOf(doc, 'callout')[0])).toBe('వర్షం పడితే జారుతుందిबारिश में फिसलनಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ');
  });

  it('a label line outside a callout is ordinary text (Evernote stripped the marker: the readable floor)', () => {
    const { doc } = conv('<div style="--kosko-callout-label:1; font-weight:bold;">Tip</div><div>Carry cash.</div>');
    expect(nodesOf(doc, 'callout')).toEqual([]);
    expect(textOf(doc)).toBe('TipCarry cash.');
  });

  it('a heading inside a marked div is not lost', () => {
    const { doc } = conv(callout('tip', '<h2>Money</h2><div>Carry cash.</div>'));
    expect(textOf(doc)).toContain('Money');
    expect(textOf(doc)).toContain('Carry cash.');
  });

  it('benign: a div with an ordinary style is a paragraph', () => {
    const { doc } = conv('<div style="color:#333;">plain</div>');
    expect(topTypes(doc)).toEqual(['paragraph']);
  });
});

describe('toggle', () => {
  const toggle = (state, summary, body) =>
    `<div style="--kosko-toggle:${state};"><div style="--kosko-toggle-summary:1; font-weight:bold;">${summary}</div>` +
    `<div style="--kosko-toggle-body:1; padding-left:24px;">${body}</div></div>`;

  it('a marked div becomes details > summary + content, closed', () => {
    const { doc } = conv(toggle('closed', 'Packing list', '<div>Torch</div><div>Rain cover</div>'));
    expect(topTypes(doc)).toEqual(['details']);
    const [d] = nodesOf(doc, 'details');
    expect(d.attrs).toEqual({ open: false });
    expect(d.content.map((n) => n.type)).toEqual(['detailsSummary', 'detailsContent']);
    expect(d.content[0].content).toEqual([{ type: 'text', text: 'Packing list' }]);
    expect(d.content[1].content.map((n) => n.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('open is read from the marker; any other value is closed', () => {
    expect(nodesOf(conv(toggle('open', 's', '<div>b</div>')).doc, 'details')[0].attrs.open).toBe(true);
    expect(nodesOf(conv(toggle('yes', 's', '<div>b</div>')).doc, 'details')[0].attrs.open).toBe(false);
  });

  it('the summary keeps its own marks and is not made bold by the export\'s bold line', () => {
    const { doc } = conv(toggle('closed', 'Plain and <i>slanted</i>', '<div>b</div>'));
    const summary = nodesOf(doc, 'detailsSummary')[0].content;
    expect(summary[0]).toEqual({ type: 'text', text: 'Plain and ' });
    expect(summary[1].marks).toEqual([{ type: 'italic' }]);
  });

  it('a toggle inside a toggle', () => {
    const { doc } = conv(toggle('open', 'outer', toggle('closed', 'inner', '<div>deep</div>')));
    expect(nodesOf(doc, 'details')).toHaveLength(2);
    expect(textOf(doc)).toBe('outerinnerdeep');
  });

  it('a toggle with no body gets an empty one', () => {
    const { doc } = conv('<div style="--kosko-toggle:closed;"><div style="--kosko-toggle-summary:1;">only a summary</div></div>');
    const [d] = nodesOf(doc, 'details');
    expect(d.content[1].content.map((n) => n.type)).toEqual(['paragraph']);
    expect(textOf(d)).toBe('only a summary');
  });

  it('a marked div with no summary line is not a toggle, and its text is kept', () => {
    const { doc } = conv('<div style="--kosko-toggle:open;"><div>just</div><div>lines</div></div>');
    expect(nodesOf(doc, 'details')).toEqual([]);
    expect(textOf(doc)).toBe('justlines');
  });

  it('a Hindi summary and a Kannada body survive', () => {
    const { doc } = conv(toggle('closed', 'सामान की सूची', '<div>ಟಾರ್ಚ್</div>'));
    expect(textOf(doc)).toBe('सामान की सूचीಟಾರ್ಚ್');
  });
});

describe('a marked line that is not the shape Kosko writes keeps its words', () => {
  it('a callout label longer than a label, or holding an element, is an ordinary line of the callout', () => {
    const long = 'A sentence somebody else put in the label line, far too long to be a kind name.';
    const a = conv(`<div style="--kosko-callout:tip;"><div style="--kosko-callout-label:1;">${long}</div><div>Carry cash.</div></div>`).doc;
    expect(nodesOf(a, 'callout')).toHaveLength(1);
    expect(textOf(a)).toBe(`${long}Carry cash.`);
    const b = conv('<div style="--kosko-callout:tip;"><div style="--kosko-callout-label:1;"><b>Tip</b></div><div>Carry cash.</div></div>').doc;
    expect(textOf(b)).toBe('TipCarry cash.');
  });
});

describe('contents block', () => {
  it('a marked div becomes the block, and the list written for Evernote is discarded', () => {
    const { doc } = conv('<h2>Packing list</h2><div style="--kosko-contents:1;"><div>Packing list</div><div style="padding-left:24px;">Route</div></div><div>after</div><h3>Route</h3>');
    expect(topTypes(doc)).toEqual(['heading', 'tableOfContents', 'paragraph', 'heading']);
    expect(textOf(doc)).toBe('Packing listafterRoute');
  });

  it('a marked div holding anything but the note\'s headings is not a contents block: its words are kept', () => {
    const { doc } = conv('<h2>Packing list</h2><div style="--kosko-contents:1;"><div>Packing list</div><div>my own paragraph</div></div>');
    expect(nodesOf(doc, 'tableOfContents')).toEqual([]);
    expect(textOf(doc)).toContain('my own paragraph');
    const loose = conv('<h2>Packing list</h2><div style="--kosko-contents:1;">loose words<div>Packing list</div></div>').doc;
    expect(nodesOf(loose, 'tableOfContents')).toEqual([]);
    expect(textOf(loose)).toContain('loose words');
  });

  it('any other marker value is not a contents block', () => {
    const { doc } = conv('<div style="--kosko-contents:0;"><ul><li>Route</li></ul></div>');
    expect(nodesOf(doc, 'tableOfContents')).toEqual([]);
    expect(textOf(doc)).toBe('Route');
  });
});

describe('picture: width, alignment, caption', () => {
  const image = (doc) => nodesOf(doc, 'noteImage')[0].attrs;

  const natural = (w) => ` style="--en-naturalWidth:${w}; --en-naturalHeight:900;"`;

  it('Kosko\'s own marker is the stored percentage, whatever the pixel width says', () => {
    expect(image(conv(`<div>${media(' width="360" style="--kosko-width:50"')}</div>`).doc).displayWidth).toBe(50);
    expect(image(conv(`<div>${media(' width="999" style="--kosko-width: 33;"')}</div>`).doc).displayWidth).toBe(33);
    expect(image(conv(`<div>${media(' style="--kosko-width:100"')}</div>`).doc).displayWidth).toBe(100);
  });

  it('a marker that is not a whole number from 10 to 100 is ignored', () => {
    for (const bad of ['5', '101', '50%', '33.5', 'auto', '5e1', 'calc(50)', '']) {
      expect(image(conv(`<div>${media(` style="--kosko-width:${bad}"`)}</div>`).doc).displayWidth, bad).toBeNull();
    }
  });

  it('every percentage Kosko can store comes back as itself', () => {
    for (let pct = 10; pct <= 100; pct += 1) {
      const px = Math.round((pct * ENML_COLUMN_PX) / 100);
      expect(image(conv(`<div>${media(` width="${px}" style="--kosko-width:${pct}"`)}</div>`).doc).displayWidth, `${pct}%`).toBe(pct);
    }
  });

  it('Evernote\'s resize: a width narrower than the natural width it wrote becomes a share of the 720 px column', () => {
    expect(image(conv(`<div>${media(` width="360"${natural(1440)}`)}</div>`).doc).displayWidth).toBe(50);
    expect(image(conv(`<div>${media(` width="238px"${natural(1440)}`)}</div>`).doc).displayWidth).toBe(33);
    expect(image(conv(`<div>${media(` width="12"${natural(1440)}`)}</div>`).doc).displayWidth).toBe(10);
  });

  it('a resize to the column or wider is null (the full column)', () => {
    expect(image(conv(`<div>${media(` width="720"${natural(1440)}`)}</div>`).doc).displayWidth).toBeNull();
    expect(image(conv(`<div>${media(` width="1000"${natural(1440)}`)}</div>`).doc).displayWidth).toBeNull();
  });

  it('benign: a width with no sign of a resize is the picture\'s own size and sets no display width', () => {
    expect(image(conv(`<div>${media(' width="40" height="30"')}</div>`).doc).displayWidth).toBeNull();
    expect(image(conv(`<div>${media(` width="300"${natural(300)}`)}</div>`).doc).displayWidth).toBeNull();
    expect(image(conv(`<div>${media()}</div>`).doc).displayWidth).toBeNull();
  });

  it('a width or natural width that is not a number sets nothing', () => {
    for (const bad of ['50%', 'auto', '3e2', '-40', 'calc(100px)']) expect(image(conv(`<div>${media(` width="${bad}"${natural(1440)}`)}</div>`).doc).displayWidth, bad).toBeNull();
    expect(image(conv(`<div>${media(' width="360" style="--en-naturalWidth:big"')}</div>`).doc).displayWidth).toBeNull();
  });

  it('beside Kosko\'s marker, the picture\'s own pixel size is read from the natural size, not from the shown size', () => {
    const { doc, media: manifest } = conv(`<div>${media(' width="360" height="240" style="--kosko-width:50; --en-naturalWidth:1440; --en-naturalHeight:960"')}</div>`);
    expect(image(doc)).toMatchObject({ displayWidth: 50, width: 1440, height: 960 });
    expect(manifest[0]).toMatchObject({ width: 1440, height: 960 });
  });

  it('benign: without Kosko\'s marker an Evernote note\'s width and height are read as they always were', () => {
    const { doc } = conv(`<div>${media(' width="360" height="240" style="--en-naturalWidth:1440; --en-naturalHeight:960"')}</div>`);
    expect(image(doc)).toMatchObject({ width: 360, height: 240, displayWidth: 50 });
  });

  it('a natural size that is not two whole numbers is ignored', () => {
    const { doc } = conv(`<div>${media(' width="360" height="240" style="--kosko-width:50; --en-naturalWidth:big; --en-naturalHeight:960"')}</div>`);
    expect(image(doc)).toMatchObject({ width: 360, height: 240 });
  });

  it('reads alignment from the wrapper\'s text-align or align, when the picture is alone in it', () => {
    expect(image(conv(`<div style="text-align:center;">${media()}</div>`).doc).align).toBe('center');
    expect(image(conv(`<div style="text-align: RIGHT">${media()}</div>`).doc).align).toBe('right');
    expect(image(conv(`<div align="left">${media()}</div>`).doc).align).toBe('left');
    expect(image(conv(`<div style="text-align:justify;">${media()}</div>`).doc).align).toBeNull();
    expect(image(conv(`<div>${media()}</div>`).doc).align).toBeNull();
  });

  it('does not align a picture that shares its line with text', () => {
    const { doc } = conv(`<div style="text-align:center;">words ${media()}</div>`);
    expect(image(doc).align).toBeNull();
    expect(textOf(doc)).toContain('words');
  });

  it('a marked line after the picture becomes its caption, and is not also a paragraph', () => {
    const { doc } = conv(`<div style="text-align:center;">${media(' width="360" style="--kosko-width:50"')}</div><div style="--kosko-caption:1; font-style:italic;">అరకు లోయ at dawn, 0123</div><div>next</div>`);
    expect(image(doc)).toMatchObject({ caption: 'అరకు లోయ at dawn, 0123', displayWidth: 50, align: 'center' });
    // The picture's wrapper line arrives as an empty paragraph before it, as it did before 0.5.0.
    expect(topTypes(doc).slice(-2)).toEqual(['noteImage', 'paragraph']);
    expect(textOf(doc)).toBe('next');
  });

  it('a caption of digits stays a string; a line too long for a caption stays a line, whole', () => {
    expect(image(conv(`<div>${media()}</div><div style="--kosko-caption:1;">0123</div>`).doc).caption).toBe('0123');
    const fits = conv(`<div>${media()}</div><div style="--kosko-caption:1;">${'x'.repeat(500)}</div>`).doc;
    expect(image(fits).caption).toHaveLength(500);
    const long = conv(`<div>${media()}</div><div style="--kosko-caption:1;">${'x'.repeat(700)}</div>`).doc;
    expect(image(long).caption ?? null).toBeNull();
    expect(textOf(long)).toBe('x'.repeat(700));
  });

  it('a caption carries text only: markup inside it is not stored', () => {
    const { doc } = conv(`<div>${media()}</div><div style="--kosko-caption:1;">a <b>bold</b> <a href="https://example.com/x">link</a></div>`);
    expect(image(doc).caption).toBe('a bold link');
    expect(JSON.stringify(doc)).not.toContain('example.com');
  });

  it('a marked line with no picture before it is an ordinary paragraph (nothing is dropped)', () => {
    const { doc } = conv('<div>words</div><div style="--kosko-caption:1;">orphan caption</div>');
    expect(textOf(doc)).toBe('wordsorphan caption');
    const file = conv('<div><en-media type="application/pdf" hash="0123456789abcdef0123456789abcdef"/></div><div style="--kosko-caption:1;">not a picture</div>');
    expect(textOf(file.doc)).toBe('not a picture');
  });

  it('the pixel size attributes are read as before', () => {
    const { doc, media: manifest } = conv(`<div>${media(' width="360" height="240"')}</div>`);
    expect(image(doc)).toMatchObject({ width: 360, height: 240, path: 'enex-resource:0123456789abcdef0123456789abcdef' });
    expect(manifest[0]).toEqual({ hash: '0123456789abcdef0123456789abcdef', mime: 'image/png', node: 'noteImage', width: 360, height: 240 });
  });
});

describe('table cell shade', () => {
  const cellOf = (style, tag = 'td') => {
    const { doc } = conv(`<table><tr><${tag} style="${style}"><div>c</div></${tag}></tr></table>`);
    return nodesOf(doc, tag === 'td' ? 'tableCell' : 'tableHeader')[0].attrs.background;
  };

  it('each of Kosko\'s own light values comes back as its shade (the round trip)', () => {
    for (const shade of CELL_SHADES) expect(cellOf(`background-color:${NOTE_PALETTE.cellLight[shade]};`), shade).toBe(shade);
  });

  it('the same value written as rgb() is the same shade (a browser rewrites hex to rgb)', () => {
    expect(cellOf('background-color: rgb(252, 244, 219)')).toBe('yellow');
  });

  it('an Evernote cell colour maps to the nearest shade by hue', () => {
    expect(cellOf('background-color:#ffef9e')).toBe('yellow');
    expect(cellOf('background-color:rgb(255, 209, 176)')).toBe('orange');
    expect(cellOf('background-color:#fec1d0')).toBe('red');
    expect(cellOf('background-color:#b7f7d1')).toBe('green');
    expect(cellOf('background-color:#add8ff')).toBe('blue');
    expect(cellOf('background-color:#dccaff')).toBe('purple');
    expect(cellOf('background-color:#e6e6e6')).toBe('grey');
    expect(cellOf('background-color:#ff0000', 'th')).toBe('red');
  });

  it('white, near-white, transparent and nonsense are no shade', () => {
    for (const none of ['#ffffff', '#fff', 'rgb(255,255,255)', '#fdfdfd', 'transparent', 'rgba(255, 0, 0, 0)', 'url(javascript:alert(1))', 'red', 'expression(x)', '#12', 'var(--x)']) {
      expect(cellOf(`background-color:${none}`), none).toBeNull();
    }
  });

  it('reads the legacy bgcolor attribute too', () => {
    const { doc } = conv('<table><tr><td bgcolor="#ffef9e"><div>c</div></td></tr></table>');
    expect(nodesOf(doc, 'tableCell')[0].attrs.background).toBe('yellow');
  });

  it('never stores the colour itself', () => {
    const { doc } = conv('<table><tr><td style="background-color:#ffef9e"><div>c</div></td></tr></table>');
    expect(JSON.stringify(doc)).not.toMatch(/ffef9e|background-color/);
  });

  it('benign: an unshaded cell has no shade, and the table is still a table', () => {
    const { doc } = conv('<table><tr><td><div>c</div></td></tr></table>');
    expect(nodesOf(doc, 'tableCell')[0].attrs.background).toBeNull();
    expect(topTypes(doc)).toEqual(['table']);
  });

  it('cellShadeOfColour is the one rule, usable by a paste handler', () => {
    expect(cellShadeOfColour('#FCF4DB')).toBe('yellow');
    expect(cellShadeOfColour('')).toBeNull();
    expect(cellShadeOfColour(null)).toBeNull();
    expect(cellShadeOfColour('#000000')).toBe('grey');
  });
});
