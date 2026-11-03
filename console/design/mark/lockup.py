"""Midstream's lockup as an image, for where the console's `Lockup` component cannot go: the README.

The same lockup `components/Logo.tsx::Lockup` draws, scaled up: the mark's display cut in Current
beside "Midstream" in Bricolage Grotesque 600, tracking -0.022em, the name 17/22 of the mark's size
and a gap of 8/22 of it, centred on each other as the component's flex row centres them, with clear
space of half the mark's drawn height on every side (docs/10-design-system.md §10.2). The name is
outlined, so the image needs no font; the optical size is the name's size, as the browser sets it.

Writes `lockup-dark.svg` (Foam and Current on Deep) and `lockup-light.svg` (Shallows) beside this
file. Reads the mark from `src/components/markPaths.ts` (run `mark.py` first after changing the
mark) and the face from `node_modules` (`npm install`). Needs fonttools, brotli and uharfbuzz:

    python -m venv /tmp/lockup && /tmp/lockup/bin/pip install fonttools brotli uharfbuzz
    /tmp/lockup/bin/python console/design/mark/lockup.py
"""
from __future__ import annotations

import pathlib
import re

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).resolve().parent
CONSOLE = HERE.parents[1]
FACE = CONSOLE / 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-opsz-normal.woff2'

#: The mark's box in pixels: the display cut, as for anything 48 px and up.
MARK_SIZE = 64.0
#: `Lockup`'s proportions: a 22 px mark, a 17 px name, 8 px between them.
NAME_SIZE = MARK_SIZE * 17 / 22
GAP = MARK_SIZE * 8 / 22
TRACKING = -0.022
WEIGHT = 600

#: The theme tokens of `src/styles.css`: Current and Foam, in each theme.
THEMES = {
    'dark': {'mark': '#3EF0C5', 'name': '#E7EEF5'},
    'light': {'mark': '#009E76', 'name': '#0A1218'},
}


def mark_path() -> str:
    source = (CONSOLE / 'src/components/markPaths.ts').read_text()
    return re.search(r"export const MARK_DISPLAY = '([^']+)'", source).group(1)


def path_bounds(d: str) -> tuple[float, float, float, float]:
    numbers = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?', d)]
    xs, ys = numbers[0::2], numbers[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def transform_path(d: str, scale: float, dx: float, dy: float) -> str:
    """The mark's path (absolute M/L/C/Z commands) scaled and moved."""
    out, index = [], 0

    def coordinate(match: re.Match[str]) -> str:
        nonlocal index
        value = float(match.group(0))
        value = value * scale + (dx if index % 2 == 0 else dy)
        index += 1
        return f'{value:.2f}'

    for token in re.split(r'([A-Za-z])', d):
        if re.fullmatch(r'[A-Za-z]', token):
            out.append(token)
        elif token.strip():
            out.append(re.sub(r'-?\d+(?:\.\d+)?', coordinate, token))
    return ''.join(out)


def name_outline(x0: float, baseline: float, dx: float = 0.0, dy: float = 0.0) -> tuple[str, tuple[float, float, float, float]]:
    """'Midstream' shaped and outlined at `NAME_SIZE`, its pen starting at (x0, baseline), then moved by (dx, dy): the path and its ink's bounds."""
    font = TTFont(FACE)
    upem = font['head'].unitsPerEm
    location = {'wght': WEIGHT, 'opsz': NAME_SIZE}

    # HarfBuzz reads no WOFF2: it shapes the same font, decompressed.
    shaper = hb.Font(hb.Face(hb.Blob(_ttf_bytes(font))))
    shaper.set_variations(location)
    buffer = hb.Buffer()
    buffer.add_str('Midstream')
    buffer.guess_segment_properties()
    hb.shape(shaper, buffer, {'kern': True, 'liga': True})

    glyphs = font.getGlyphSet(location=location)
    order = font.getGlyphOrder()
    scale = NAME_SIZE / upem
    pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}')
    bounds = BoundsPen(glyphs)
    x = x0
    for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
        name = order[info.codepoint]
        placed = (scale, 0, 0, -scale, x + position.x_offset * scale + dx, baseline - position.y_offset * scale + dy)
        glyphs[name].draw(TransformPen(pen, placed))
        glyphs[name].draw(TransformPen(bounds, placed))
        x += position.x_advance * scale + TRACKING * NAME_SIZE
    return pen.getCommands(), bounds.bounds


def _ttf_bytes(font: TTFont) -> bytes:
    import io

    font.flavor = None
    stream = io.BytesIO()
    font.save(stream)
    return stream.getvalue()


def main() -> None:
    mark = mark_path()
    ml, mt, mr, mb = path_bounds(mark)
    scale = MARK_SIZE / 64
    drawn_height = (mb - mt) * scale
    clear = drawn_height / 2

    # As the component's row centres them: the mark's box and the name's 1em line box share a centre;
    # the face's ascent (930) and descent (270) put the baseline 0.83em down a line-height-1 box.
    centre = MARK_SIZE / 2
    baseline = centre - NAME_SIZE / 2 + NAME_SIZE * (1 - (0.93 + 0.27)) / 2 + NAME_SIZE * 0.93
    _, (_, name_top, name_right, name_bottom) = name_outline(MARK_SIZE + GAP, baseline)

    ink_left = ml * scale
    ink_top = min(mt * scale, name_top)
    ink_bottom = max(mb * scale, name_bottom)
    dx, dy = clear - ink_left, clear - ink_top
    width = name_right - ink_left + 2 * clear
    height = ink_bottom - ink_top + 2 * clear

    mark_d = transform_path(mark, scale, dx, dy)
    name_d, _ = name_outline(MARK_SIZE + GAP, baseline, dx, dy)
    for theme, colours in THEMES.items():
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height:.0f}" '
            f'width="{width:.0f}" height="{height:.0f}" role="img" aria-label="Midstream">\n'
            f'  <path fill="{colours["mark"]}" d="{mark_d}"/>\n'
            f'  <path fill="{colours["name"]}" d="{name_d}"/>\n'
            '</svg>\n'
        )
        (HERE / f'lockup-{theme}.svg').write_text(svg)
        print(f'lockup-{theme}.svg', f'{width:.0f}x{height:.0f}')


if __name__ == '__main__':
    main()
