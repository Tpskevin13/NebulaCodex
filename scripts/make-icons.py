#!/usr/bin/env python3
"""Genera los iconos de NebulaCodex (assets/icon.png, icon.ico, icon.icns).

Dibujo original: una nebulosa (manchas de color desenfocadas) con estrellas y un
prompt de terminal (`>_`). Es determinista: la misma ejecución da los mismos archivos.

Uso:  python3 scripts/make-icons.py        (requiere Pillow)
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "assets"
S = 1024            # lienzo de trabajo
PAD = 72            # margen transparente (como pide la plantilla de iconos de macOS)
RADIUS = 200        # esquinas redondeadas del cuadrado

# Colores del degradado "nebula" de la interfaz (src/ui/theme.ts)
INDIGO, PURPLE, PINK, CYAN = (99, 102, 241), (168, 85, 247), (236, 72, 153), (34, 211, 238)


def blob(size, center, radii, color, alpha, blur):
    """Mancha elíptica desenfocada de un color."""
    mask = Image.new("L", (size, size), 0)
    cx, cy = center
    rx, ry = radii
    ImageDraw.Draw(mask).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=int(255 * alpha))
    mask = mask.filter(ImageFilter.GaussianBlur(blur))
    return Image.merge("RGBA", (*Image.new("RGB", (size, size), color).split(), mask))


def build():
    rnd = random.Random(1313)
    base = Image.new("RGBA", (S, S), (9, 8, 24, 255))

    # Nebulosa: varias manchas superpuestas
    for center, radii, color, alpha, blur in [
        ((300, 330), (330, 250), INDIGO, 0.95, 110),
        ((700, 260), (300, 220), PURPLE, 0.90, 110),
        ((690, 720), (340, 260), PINK, 0.80, 120),
        ((280, 760), (260, 200), CYAN, 0.70, 110),
        ((520, 520), (260, 210), PURPLE, 0.55, 100),
    ]:
        base = Image.alpha_composite(base, blob(S, center, radii, color, alpha, blur))

    # Velo oscuro al centro para que el prompt se lea
    base = Image.alpha_composite(base, blob(S, (512, 540), (300, 230), (8, 7, 22), 0.55, 120))

    # Estrellas
    stars = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stars)
    for _ in range(90):
        x, y = rnd.randrange(S), rnd.randrange(S)
        r = rnd.choice([1.5, 2, 2, 3, 3, 4])
        a = rnd.randrange(110, 255)
        sd.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, a))
    glow = stars.filter(ImageFilter.GaussianBlur(5))
    base = Image.alpha_composite(base, glow)
    base = Image.alpha_composite(base, stars)

    # Prompt ">_"
    def stroke(draw, pts, width, fill):
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            draw.line([(x1, y1), (x2, y2)], fill=fill, width=width)
        for x, y in pts:
            draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=fill)

    glyph = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glyph)
    w = 78
    stroke(gd, [(318, 392), (508, 540), (318, 688)], w, (250, 247, 255, 255))   # >
    stroke(gd, [(566, 700), (720, 700)], w, (250, 247, 255, 255))               # _
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.putalpha(glyph.getchannel("A").filter(ImageFilter.GaussianBlur(26)).point(lambda v: int(v * 0.85)))
    base = Image.alpha_composite(base, shadow)
    base = Image.alpha_composite(base, glyph)

    # Borde sutil y recorte en cuadrado redondeado con margen
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([PAD, PAD, S - PAD, S - PAD], radius=RADIUS, fill=255)
    rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle([PAD, PAD, S - PAD, S - PAD], radius=RADIUS, outline=(255, 255, 255, 46), width=4)
    base = Image.alpha_composite(base, rim)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def main():
    OUT.mkdir(exist_ok=True)
    big = build()
    big.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png", optimize=True)
    ico_src = big.resize((256, 256), Image.LANCZOS)
    ico_src.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.save(OUT / "icon.icns")
    for name in ("icon.png", "icon.ico", "icon.icns"):
        print(f"{name}: {(OUT / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()
