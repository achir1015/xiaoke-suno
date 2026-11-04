# 產生程式圖示：小柯機器人（戴耳機）＋音波＋音符＋字幕條與下載箭頭
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024


def layer():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))


def gradient():
    g = Image.new('RGBA', (S, S))
    px = g.load()
    stops = [(0.0, (251, 146, 60)), (0.5, (236, 72, 153)), (1.0, (124, 58, 237))]
    for y in range(S):
        for x in range(S):
            t = (x * 0.45 + y * 0.55) / S
            for i in range(len(stops) - 1):
                a, ca = stops[i]
                b, cb = stops[i + 1]
                if t <= b:
                    k = (t - a) / (b - a)
                    px[x, y] = tuple(int(ca[j] + (cb[j] - ca[j]) * k) for j in range(3)) + (255,)
                    break
            else:
                px[x, y] = stops[-1][1] + (255,)
    return g


def shadow(src, blur=20, alpha=0.4):
    a = src.split()[3].filter(ImageFilter.GaussianBlur(blur)).point(lambda p: p * alpha)
    return Image.merge('RGBA', (*[Image.new('L', (S, S), 0)] * 3, a))


# 圓角漸層底
mask = layer()
ImageDraw.Draw(mask).rounded_rectangle((36, 36, 988, 988), 210, fill=(255, 255, 255, 255))
img = layer()
img.paste(gradient(), (0, 0), mask)

# 音波（右上）
wave = layer()
w = ImageDraw.Draw(wave)
heights = [70, 140, 230, 320, 250, 170, 290, 200, 120, 60]
x = 470
for hgt in heights:
    w.rounded_rectangle((x, 330 - hgt // 2, x + 30, 330 + hgt // 2), 15, fill=(255, 255, 255, 235))
    x += 48
img = Image.alpha_composite(img, shadow(wave, 16, 0.25))
img = Image.alpha_composite(img, wave)

# 音符（左上）
nt = layer()
n = ImageDraw.Draw(nt)
n.ellipse((150, 300, 270, 390), fill=(255, 255, 255, 255))
n.ellipse((300, 270, 420, 360), fill=(255, 255, 255, 255))
n.rectangle((246, 130, 270, 350), fill=(255, 255, 255, 255))
n.rectangle((396, 100, 420, 320), fill=(255, 255, 255, 255))
n.polygon([(246, 130), (420, 100), (420, 160), (246, 190)], fill=(255, 255, 255, 255))
img = Image.alpha_composite(img, shadow(nt, 14, 0.3))
img = Image.alpha_composite(img, nt)

# 字幕條＋下載箭頭（右下）
sub = layer()
s = ImageDraw.Draw(sub)
s.rounded_rectangle((560, 600, 940, 900), 50, fill=(20, 18, 34, 235))
s.rounded_rectangle((600, 650, 900, 690), 20, fill=(255, 255, 255, 255))
s.rounded_rectangle((600, 715, 820, 750), 18, fill=(255, 210, 120, 255))
try:
    font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 92)
except OSError:
    font = ImageFont.load_default()
s.text((600, 770), 'SRT', font=font, fill=(255, 255, 255, 255))
s.ellipse((800, 770, 910, 880), fill=(34, 197, 94, 255))
s.line((855, 790, 855, 852), fill=(255, 255, 255, 255), width=18)
s.line((826, 826, 855, 856, 884, 826), fill=(255, 255, 255, 255), width=18, joint='curve')
img = Image.alpha_composite(img, shadow(sub, 22, 0.45))
img = Image.alpha_composite(img, sub)

# 小柯機器人（頭盔造型＋耳機）
rb = layer()
r = ImageDraw.Draw(rb)
cx, cy = 330, 700
r.line((cx, cy - 256, cx, cy - 196), fill=(90, 100, 120, 255), width=20)
r.ellipse((cx - 38, cy - 300, cx + 38, cy - 224), fill=(255, 196, 40, 255))
r.arc((cx - 262, cy - 262, cx + 262, cy + 170), 190, 350, fill=(30, 30, 46, 255), width=34)
r.ellipse((cx - 240, cy - 216, cx + 240, cy + 228), fill=(70, 150, 240, 255))
r.ellipse((cx - 222, cy - 202, cx + 222, cy + 208), fill=(240, 246, 255, 255))
r.rounded_rectangle((cx - 178, cy - 114, cx + 178, cy + 94), 94, fill=(24, 36, 64, 255))
for ex in (cx - 76, cx + 76):
    r.arc((ex - 48, cy - 54, ex + 48, cy + 30), 200, 340, fill=(90, 230, 255, 255), width=24)
r.arc((cx - 54, cy + 8, cx + 54, cy + 72), 20, 160, fill=(90, 230, 255, 255), width=15)
r.ellipse((cx - 168, cy + 40, cx - 114, cy + 82), fill=(255, 140, 160, 200))
r.ellipse((cx + 114, cy + 40, cx + 168, cy + 82), fill=(255, 140, 160, 200))
r.rounded_rectangle((cx - 292, cy - 90, cx - 214, cy + 90), 34, fill=(30, 30, 46, 255))
r.rounded_rectangle((cx + 214, cy - 90, cx + 292, cy + 90), 34, fill=(30, 30, 46, 255))
r.rounded_rectangle((cx - 280, cy - 70, cx - 226, cy + 70), 24, fill=(249, 115, 22, 255))
r.rounded_rectangle((cx + 226, cy - 70, cx + 280, cy + 70), 24, fill=(249, 115, 22, 255))
img = Image.alpha_composite(img, shadow(rb, 24, 0.5))
img = Image.alpha_composite(img, rb)

out = os.path.join(ROOT, 'build')
os.makedirs(out, exist_ok=True)
img.save(os.path.join(out, 'icon.png'))
img.save(os.path.join(out, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

ui = os.path.join(ROOT, 'src', 'app', 'img')
os.makedirs(ui, exist_ok=True)
img.resize((64, 64), Image.LANCZOS).save(os.path.join(ui, 'logo64.png'))
img.resize((192, 192), Image.LANCZOS).save(os.path.join(ui, 'logo192.png'))
head = Image.alpha_composite(layer(), rb).crop((cx - 300, cy - 310, cx + 300, cy + 290))
head.resize((96, 96), Image.LANCZOS).save(os.path.join(ui, 'robot96.png'))
print('icon ok')
