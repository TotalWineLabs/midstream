"""Midstream's mark: one stream, drawn with a pen whose pressure varies.

The centreline rises twice and settles into a line. A round nib is swept along it, its radius set by
pressure: heavier on the way down, lighter on the way up, touching down a little light and easing
off along the tail. The outline is the union of the nib's hull between each pair of samples, which
stays clean through the tight turns where an offset curve would fold over itself.

Two cuts, as a typeface has optical sizes: `display` for 48 px and up, and `text`, heavier and with
less contrast, for 32 px and under, so the thin strokes hold beside text and in a browser tab.

Writes the console's icons and `src/components/markPaths.ts`. Needs numpy and shapely:

    python -m venv /tmp/mark && /tmp/mark/bin/pip install numpy shapely
    /tmp/mark/bin/python console/design/mark/mark.py

then render the PNGs with any SVG rasteriser, such as a headless browser: `public/icons/mark.svg`
at 192 and 512 px (`icon-192.png`, `icon-512.png`), `mark-maskable.svg` at 512 px
(`maskable-512.png`), and `design/mark/apple-touch-icon.svg` at 180 px (`apple-touch-icon.png`),
and run `lockup.py` for the README's lockup. See docs/10-design-system.md §10.2.
"""
from __future__ import annotations

import pathlib

import numpy as np
from shapely import affinity
from shapely.geometry import Point
from shapely.ops import unary_union

CONSOLE = pathlib.Path(__file__).resolve().parents[2]

#: The centreline, in a 64-unit box: two rises, the second lower, and a tail that settles.
CENTRELINE = [
    ((11, 44), (14, 33), (16.6, 14.5), (21, 14.5)),
    ((21, 14.5), (25.4, 14.5), (27, 44), (31.5, 44)),
    ((31.5, 44), (35.6, 44), (36.6, 25), (40.6, 25)),
    ((40.6, 25), (44.2, 25), (45.0, 39.5), (47.6, 42.6)),
    ((47.6, 42.6), (49.6, 45.0), (52.8, 44.6), (57.0, 43.7)),
]

#: Each cut's nib: its full radius, how light an upstroke is beside a downstroke, how far the tail
#: thins, and the mark's width in the box.
CUTS = {
    'display': {'radius': 3.2, 'light': 0.56, 'tail': 0.10, 'width': 46.0},
    'text': {'radius': 3.9, 'light': 0.72, 'tail': 0.24, 'width': 48.0},
}

ABYSS, CURRENT = '#07090C', '#3EF0C5'


def bezier(p: np.ndarray, t: np.ndarray) -> np.ndarray:
    u = 1 - t
    return (u**3)[:, None] * p[0] + (3 * u * u * t)[:, None] * p[1] + (3 * u * t * t)[:, None] * p[2] + (t**3)[:, None] * p[3]


def tangent(p: np.ndarray, t: np.ndarray) -> np.ndarray:
    u = 1 - t
    return (3 * u * u)[:, None] * (p[1] - p[0]) + (6 * u * t)[:, None] * (p[2] - p[1]) + (3 * t * t)[:, None] * (p[3] - p[2])


def smoothstep(a: float, b: float, x: np.ndarray) -> np.ndarray:
    x = np.clip((x - a) / (b - a), 0, 1)
    return x * x * (3 - 2 * x)


def sample(per_segment: int = 160) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """Points along the centreline, their unit tangents, how far along each is (0–1), and where the tail starts."""
    points, tangents = [], []
    for index, segment in enumerate(CENTRELINE):
        p = np.array(segment, float)
        t = np.linspace(0, 1, per_segment, endpoint=index == len(CENTRELINE) - 1)
        points.append(bezier(p, t))
        tangents.append(tangent(p, t))
    pts = np.vstack(points)
    tans = np.vstack(tangents)
    tans /= np.maximum(np.linalg.norm(tans, axis=1, keepdims=True), 1e-9)
    along = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    along /= along[-1]
    return pts, tans, along, float(along[(len(CENTRELINE) - 1) * per_segment])


def pressure(cut: dict, tans: np.ndarray, along: np.ndarray, tail_start: float) -> np.ndarray:
    down = (tans[:, 1] + 1) / 2  # y grows downward: 1 straight down, 0 straight up
    direction = cut['light'] + (1 - cut['light']) * down**1.1
    touch = 0.72 + 0.28 * smoothstep(0, 0.06, along)
    lift = 1 - (1 - cut['tail']) * smoothstep(tail_start - 0.03, 1.0, along) ** 1.25
    raw = cut['radius'] * direction * touch * lift
    # Smoothed along the stroke, so pressure never steps where the direction swings, but not at
    # the ends: the touch and the lift are the pen's own.
    sigma = 0.022
    weights = np.exp(-0.5 * ((along[None, :] - along[:, None]) / sigma) ** 2)
    smoothed = (weights * raw[None, :]).sum(axis=1) / weights.sum(axis=1)
    keep = smoothstep(0.0, 0.04, along) * smoothstep(1.0, 0.9, along)
    return smoothed * keep + raw * (1 - keep)


def outline(cut: dict):
    pts, tans, along, tail_start = sample()
    radii = pressure(cut, tans, along, tail_start)
    hulls = []
    for i in range(len(pts) - 1):
        a = Point(pts[i]).buffer(radii[i], quad_segs=16)
        b = Point(pts[i + 1]).buffer(radii[i + 1], quad_segs=16)
        hulls.append(a.union(b).convex_hull)
    return unary_union(hulls).simplify(0.02)


def placement(shape, width: float) -> tuple[float, float, float]:
    """Scale and offset that set the mark `width` wide, a little below centre: the tall rise carries its weight up."""
    minx, miny, maxx, maxy = shape.bounds
    k = width / (maxx - minx)
    return k, 32.6 - k * (minx + maxx) / 2, 32.8 - k * (miny + maxy) / 2


def place(shape, k: float, dx: float, dy: float):
    return affinity.translate(affinity.scale(shape, k, k, origin=(0, 0)), dx, dy)


def path_d(shape) -> str:
    polygons = [shape] if shape.geom_type == 'Polygon' else list(shape.geoms)
    rings = []
    for polygon in polygons:
        for ring in [polygon.exterior, *polygon.interiors]:
            xy = list(ring.coords)[:-1]
            rings.append('M' + 'L'.join(f'{x:.2f},{y:.2f}' for x, y in xy) + 'Z')
    return ''.join(rings)


def centreline_d(k: float, dx: float, dy: float) -> str:
    def at(point: tuple[float, float]) -> str:
        return f'{point[0] * k + dx:.2f},{point[1] * k + dy:.2f}'

    return f'M{at(CENTRELINE[0][0])}' + ''.join(f'C{at(s[1])} {at(s[2])} {at(s[3])}' for s in CENTRELINE)


def svg(d: str, *, tile: str | None, rx: float = 15, scale: float = 1.0) -> str:
    body = f'<path d="{d}" fill="{ABYSS if tile else CURRENT}"/>'
    if scale != 1.0:
        body = f'<g transform="translate(32 32) scale({scale}) translate(-32 -32)">{body}</g>'
    rect = '' if tile is None else (f'<rect width="64" height="64" fill="{tile}"/>' if rx == 0 else f'<rect width="64" height="64" rx="{rx}" fill="{tile}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{rect}{body}</svg>\n'


def main() -> None:
    shapes = {name: outline(cut) for name, cut in CUTS.items()}
    placed, lines = {}, {}
    for name, shape in shapes.items():
        k, dx, dy = placement(shape, CUTS[name]['width'])
        placed[name] = path_d(place(shape, k, dx, dy))
        lines[name] = centreline_d(k, dx, dy)

    public = CONSOLE / 'public'
    (public / 'favicon.svg').write_text(svg(placed['text'], tile=CURRENT, rx=14))
    (public / 'icons' / 'mark.svg').write_text(svg(placed['display'], tile=CURRENT))
    (public / 'icons' / 'mark-maskable.svg').write_text(svg(placed['display'], tile=CURRENT, rx=0, scale=0.68))
    # iOS rounds its own corners: the touch icon is square, rendered from this.
    (CONSOLE / 'design' / 'mark' / 'apple-touch-icon.svg').write_text(svg(placed['display'], tile=CURRENT, rx=0, scale=0.8))

    ts = [
        '// Generated by design/mark/mark.py; edit that and run it again rather than this file.',
        '',
        '/** The mark at 48 px and up: the full contrast of the pen. */',
        f"export const MARK_DISPLAY = '{placed['display']}';",
        '',
        '/** The mark at 32 px and under: heavier, with less contrast, so it holds beside text. */',
        f"export const MARK_TEXT = '{placed['text']}';",
        '',
        "/** Each cut's centreline, which the mark draws along when it appears. */",
        f"export const MARK_DISPLAY_LINE = '{lines['display']}';",
        f"export const MARK_TEXT_LINE = '{lines['text']}';",
        '',
    ]
    (CONSOLE / 'src' / 'components' / 'markPaths.ts').write_text('\n'.join(ts))
    for name, d in placed.items():
        print(name, len(d), 'chars')


if __name__ == '__main__':
    main()
