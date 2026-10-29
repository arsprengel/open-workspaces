"""Renders the extension icons (PNG) from code. Requires Pillow: `pip install pillow`.

Usage: python scripts/build-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"
SIZES = [16, 32, 48, 128]
S = 1024  # draw big, downscale for anti-aliasing

VIOLET = (110, 86, 207)  # brand violet, see DESIGN.md


def folder(d: ImageDraw.ImageDraw, x0: float, y0: float, x1: float, y1: float, fill) -> None:
    """A tab-topped card: the body plus a raised tab on its top-left edge."""
    r = (x1 - x0) * 0.16
    tab_w, tab_h = (x1 - x0) * 0.46, (y1 - y0) * 0.24
    d.rounded_rectangle((x0, y0, x0 + tab_w, y0 + tab_h * 2), radius=r, fill=fill)
    d.rounded_rectangle((x0, y0 + tab_h, x1, y1), radius=r, fill=fill)


def render() -> Image.Image:
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.24), fill=255)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(Image.new("RGBA", (S, S), VIOLET + (255,)), (0, 0), mask)

    # Two stacked tab cards = workspaces of tabs. The one in front is the open workspace.
    back = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    folder(ImageDraw.Draw(back), S * 0.30, S * 0.17, S * 0.84, S * 0.63, (255, 255, 255, 120))
    front = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    folder(ImageDraw.Draw(front), S * 0.16, S * 0.33, S * 0.74, S * 0.83, (255, 255, 255, 255))
    # Cut a gap around the front card so the two layers read apart at 16px.
    gap = Image.new("L", (S, S), 0)
    folder(ImageDraw.Draw(gap), S * 0.16 - S * 0.045, S * 0.33 - S * 0.045, S * 0.74 + S * 0.045, S * 0.83 + S * 0.045, 255)
    back.putalpha(Image.composite(Image.new("L", (S, S), 0), back.getchannel("A"), gap))
    return Image.alpha_composite(Image.alpha_composite(icon, back), front)


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
