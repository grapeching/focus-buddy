"""v2 彻底统一：只保留明确配件色，其余全部按亮度映射到基准棕阶梯"""
from PIL import Image, ImageDraw
import numpy as np, glob, os, zipfile

U = "/workspace/角色统一配色_PNG"


def rgb_hsv(rgb):
    a = rgb.astype(float) / 255
    mx, mn = a.max(-1), a.min(-1); d = mx - mn
    h = np.zeros_like(mx); r, g, b = a[...,0], a[...,1], a[...,2]
    m = d > 1e-6
    i = (mx==r)&m; h[i] = ((g-b)[i]/d[i])%6
    i = (mx==g)&m; h[i] = ((b-r)[i]/d[i])+2
    i = (mx==b)&m; h[i] = ((r-g)[i]/d[i])+4
    h *= 60
    return h, np.where(mx>0, d/np.maximum(mx,1e-9), 0), mx


# 基准阶梯（与 v1 相同，来自设定图）
base_files = sorted(glob.glob("/workspace/角色透明底_PNG/sheet_*.png"))
samples = []
for f in base_files:
    a = np.array(Image.open(f).convert("RGBA"))
    px = a[:,:,:3][a[:,:,3]>0]
    h,s,v = rgb_hsv(px)
    sel = (h>=12)&(h<=48)&(s>=0.16)&(s<=0.72)&(v>=0.25)&(v<=0.95)
    samples.append(px[sel])
S = np.concatenate(samples); hs,ss,vs = rgb_hsv(S)
bins = np.linspace(0.20,0.97,20)
ramp_v, ramp_rgb = [], []
for i in range(len(bins)-1):
    sel = (vs>=bins[i])&(vs<bins[i+1])
    if sel.sum()>20:
        ramp_v.append(vs[sel].mean()); ramp_rgb.append(np.median(S[sel],axis=0))
ramp_v=np.array(ramp_v); ramp_rgb=np.array(ramp_rgb)


def recolor(path):
    a = np.array(Image.open(path).convert("RGBA")).astype(np.uint8)
    alpha = a[:,:,3]; rgb = a[:,:,:3].astype(float)
    h,s,v = rgb_hsv(rgb)
    # 明确保留的配件
    keep = ((alpha==0) | (v<0.20)                              # 透明 / 描边
            | ((v>0.90)&(s<0.20))                              # 眼白 / 高光
            | ((s>0.42)&((h<15)|(h>330)))                      # 红围巾 / 红线球
            | ((s>0.28)&(h>=90)&(h<=290))                      # 冷色配件（书本、杯子）
            | ((s>0.70)&(h>=42)&(h<=62)&(v>0.72)))             # 亮金眼镜 / 喙高光
    fur = (alpha>0) & ~keep & (v>=0.20) & (v<=0.97)
    out = rgb.copy()
    if fur.any():
        vv = v[fur]
        target = np.stack([np.interp(vv, ramp_v, ramp_rgb[:,c]) for c in range(3)], -1)
        target = target * (vv/np.maximum(target.max(-1),1e-6))[...,None]
        out[fur] = np.clip(target*255,0,255)
    a[:,:,:3] = out.astype(np.uint8)
    return Image.fromarray(a)

files = sorted([f for f in glob.glob(U+"/*.png") if os.path.basename(f)[:4] in ("owl_","shee")])
pairs=[]
for f in files:
    n=os.path.basename(f); before=Image.open(f).convert("RGBA")
    after=recolor(f); after.save(f)
    pairs.append((n,before,after))
    print("v2",n)

# 对比图：v1(左) vs v2(右)
th=190; rows=[]
for n,b,a in pairs:
    fit=lambda im: im.resize((max(1,int(im.width*th/im.height)),th), Image.NEAREST)
    rows.append((n,fit(b),fit(a)))
cw=max(max(b.width,a.width) for _,b,a in rows)+40; ch=th+46
cv=Image.new("RGB",(cw*2+20,ch*len(rows)+20),(255,255,255)); d=ImageDraw.Draw(cv)
sq=12
for y in range(0,cv.height,sq):
    for x in range(0,cv.width,sq):
        if (x//sq+y//sq)%2==0: d.rectangle([x,y,x+sq-1,y+sq-1],fill=(226,226,226))
for i,(n,b,a) in enumerate(rows):
    y=10+i*ch
    cv.paste(b,(10+(cw-b.width)//2,y),b); cv.paste(a,(cw+20+(cw-a.width)//2,y),a)
    d.text((10,y+th+6),n.replace(".png","")[:22]+"  [v1]",fill=(70,70,70))
    d.text((cw+20,y+th+6),n.replace(".png","")[:22]+"  [最终]",fill=(70,70,70))
cv.save(f"{U}/统一前后对比.png")
print("saved",cv.size)

with zipfile.ZipFile("/workspace/角色统一配色_PNG.zip","w",zipfile.ZIP_DEFLATED) as z:
    for f in os.listdir(U):
        if f.endswith(".png"): z.write(f"{U}/{f}",f)
