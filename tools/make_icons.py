"""Generate the Glass Player app and tray icons."""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets")
os.makedirs(OUT, exist_ok=True)
SS = 4


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def squircle_mask(size: int, radius: int, supersample: int) -> Image.Image:
    big = Image.new("L", (size * supersample, size * supersample), 0)
    d = ImageDraw.Draw(big)
    d.rounded_rectangle(
        (0, 0, size * supersample - 1, size * supersample - 1),
        radius=radius * supersample,
        fill=255,
    )
    return big.resize((size, size), Image.LANCZOS)


def make_note(
    size: int,
    color=(255, 255, 255, 255),
    shadow=True,
    scale=1.0,
    supersample=SS,
) -> Image.Image:
    s = size * supersample
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Single eighth note: round head, straight stem, swooping flag.
    head = (s * 0.38 * 1.0, s * 0.685)
    head_rx = s * 0.125 * scale
    head_ry = s * 0.095 * scale
    d.ellipse(
        (head[0] - head_rx, head[1] - head_ry, head[0] + head_rx, head[1] + head_ry),
        fill=color,
    )
    stem_w = max(2, int(s * 0.048 * scale))
    stem_x = head[0] + head_rx * 0.78
    d.rounded_rectangle(
        (stem_x - stem_w / 2, s * 0.205, stem_x + stem_w / 2, head[1] + head_ry * 0.12),
        radius=stem_w // 2,
        fill=color,
    )
    # Curved flag drawn as a filled polygon.
    flag = [
        (stem_x - stem_w * 0.35, s * 0.205),
        (stem_x + s * 0.085, s * 0.235),
        (stem_x + s * 0.155, s * 0.320),
        (stem_x + s * 0.180, s * 0.455),
        (stem_x + s * 0.168, s * 0.545),
        (stem_x + s * 0.100, s * 0.455),
        (stem_x + s * 0.082, s * 0.365),
        (stem_x + stem_w * 0.35, s * 0.325),
    ]
    d.polygon(flag, fill=color)
    d.ellipse(
        (
            stem_x - stem_w / 2,
            s * 0.205 - stem_w / 2,
            stem_x + stem_w / 2,
            s * 0.205 + stem_w / 2,
        ),
        fill=color,
    )
    if shadow:
        alpha = img.split()[3]
        blur = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        blur.putalpha(alpha.filter(ImageFilter.GaussianBlur(s * 0.018)))
        black = Image.new("RGBA", (s, s), (0, 0, 0, 150))
        black.putalpha(blur.split()[3].point(lambda v: int(v * 0.45)))
        base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        base.alpha_composite(black, (0, int(s * 0.018)))
        base.alpha_composite(img)
        img = base
    return img.resize((size, size), Image.LANCZOS)


def make_app_icon(size: int = 512) -> Image.Image:
    s = size * SS
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Diagonal color field.
    grad = Image.new("RGBA", (64, 64))
    gd = ImageDraw.Draw(grad)
    c1 = (44, 80, 255)
    c2 = (124, 78, 255)
    c3 = (26, 214, 190)
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126
            if t < 0.55:
                c = lerp(c1, c2, t / 0.55)
            else:
                c = lerp(c2, c3, (t - 0.55) / 0.45)
            # subtle vignette towards edges
            glow = math.exp(-(((x - 42) / 42) ** 2 + ((y - 18) / 42) ** 2))
            c = tuple(min(255, int(v + glow * 22)) for v in c)
            gd.point((x, y), fill=c + (255,))
    bg = grad.resize((s, s), Image.BICUBIC)
    mask = squircle_mask(s, int(s * 0.235), 1)

    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    # Frosted inner glass layer.
    inner = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    idraw = ImageDraw.Draw(inner)
    inset = s * 0.055
    idraw.rounded_rectangle(
        (inset, inset, s - inset, s - inset),
        radius=s * 0.20,
        fill=(255, 255, 255, 18),
    )
    icon.alpha_composite(inner)

    # Soft top-left specular.
    spec = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(spec)
    sd.ellipse((-s * 0.25, -s * 0.38, s * 0.85, s * 0.55), fill=(255, 255, 255, 70))
    spec = spec.filter(ImageFilter.GaussianBlur(s * 0.10))
    icon.alpha_composite(spec)

    # Glass rim.
    rim = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.rounded_rectangle(
        (inset * 0.7, inset * 0.7, s - inset * 0.7, s - inset * 0.7),
        radius=s * 0.205,
        outline=(255, 255, 255, 120),
        width=max(2, int(s * 0.006)),
    )
    icon.alpha_composite(rim)

    note = make_note(s, shadow=True, scale=1.15, supersample=2)
    note = note.filter(ImageFilter.GaussianBlur(s * 0.0015))
    icon.alpha_composite(note)

    # Baked outer shadow + final resize.
    final = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sh = ImageDraw.Draw(shadow)
    sh.rounded_rectangle(
        (s * 0.04, s * 0.07, s * 0.96, s * 0.98),
        radius=s * 0.23,
        fill=(0, 0, 0, 90),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(s * 0.045))
    final.alpha_composite(shadow)
    final.alpha_composite(icon)
    return final.resize((size, size), Image.LANCZOS)


app_icon = make_app_icon(512)
app_icon.save(os.path.join(OUT, "icon.png"))
app_icon.save(
    os.path.join(OUT, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
tray = make_app_icon(64).resize((32, 32), Image.LANCZOS)
tray.save(os.path.join(OUT, "tray.png"))
print("icons written to", OUT)
