"""Renders the extension icons (PNG) from code. Requires Pillow: `pip install pillow`.

Usage: python scripts/build-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"
SIZES = [16, 32, 48, 128]
S = 1024  # draw big, downscale for anti-aliasing

TOP = (99, 102, 241)  # indigo-500
BOTTOM = (139, 92, 246)  # violet-500


def render() -> Image.Image:
    gradient = Image.new("RGBA", (S, S))
    px = gradient.load()
    for y in range(S):
        f = y / (S - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * f) for i in range(3)) + (255,)
        for x in range(S):
            px[x, y] = color

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    # 2x2 grid of tiles = workspaces; the active one is solid.
    tiles = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(tiles)
    pad, gap = int(S * 0.2), int(S * 0.08)
    tile = (S - 2 * pad - gap) // 2
    r = int(tile * 0.24)
    for row in range(2):
        for col in range(2):
            x0 = pad + col * (tile + gap)
            y0 = pad + row * (tile + gap)
            alpha = 255 if (row, col) == (0, 0) else 120
            d.rounded_rectangle((x0, y0, x0 + tile, y0 + tile), radius=r, fill=(255, 255, 255, alpha))
    return Image.alpha_composite(icon, tiles)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = render()
    for size in SIZES:
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png")
    big.resize((512, 512), Image.LANCZOS).save(ROOT / "docs" / "icon-512.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    (ROOT / "docs").mkdir(exist_ok=True)
    main()
