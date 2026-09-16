import argparse, io, os, re, json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests
from PIL import Image

BASE='https://game.gtimg.cn/images/dfm/cp/a20240729directory/img'
DEFAULT=['map_db','map_yc','map_htjd','map_bks2','map_cxjy','daba_1f','daba_2f','cgxg_1f','cgxg_2f','bks_1f','bks_2f','bks_3f','cxjy_1f','cxjy_2f','cxjy_3f','cxjy_4f','map_pc','map_ljd','map_gc','map_jq','map_qhz','map_df','map_dg']

s=requests.Session();s.headers.update({'User-Agent':'Mozilla/5.0','Referer':'https://df.qq.com/cp/a20240729directory/'})

def get(url):
    try:
        r=s.get(url,timeout=15)
        if r.status_code!=200:return None
        Image.open(io.BytesIO(r.content)).verify()
        return r.content
    except:return None

def probe(layer,z):
    for x,y in [(0,0),(1,1),(2,2),(4,4),(8,8)]:
        b=get(f'{BASE}/{layer}/{z}_{x}_{y}.jpg')
        if b:return z
    return None

def run(layer,z,out):
    side=1<<z
    tiles=[]
    with ThreadPoolExecutor(max_workers=16) as ex:
        fs={ex.submit(get,f'{BASE}/{layer}/{z}_{x}_{y}.jpg'):(x,y) for y in range(side) for x in range(side)}
        for f in as_completed(fs):
            b=f.result();
            if b: tiles.append((fs[f],b))
    if not tiles:return
    img=Image.new('RGB',(side*256,side*256))
    for (x,y),b in tiles:
        try: img.paste(Image.open(io.BytesIO(b)).convert('RGB'),(x*256,y*256))
        except:pass
    out.mkdir(parents=True,exist_ok=True)
    img.save(out/f'{layer}_z{z}.jpg',quality=95)
    return len(tiles),img.size

def main():
    p=argparse.ArgumentParser();p.add_argument('--max-zoom',type=int,default=6);p.add_argument('--workers',type=int,default=16);p.add_argument('--only-layers',default='');a=p.parse_args()
    layers=[x for x in a.only_layers.split(',') if x] or DEFAULT
    out=Path('output/maps');meta=[]
    for l in layers:
        z=next((probe(l,i) for i in range(a.max_zoom,-1,-1) if probe(l,i)),None)
        if z is None: continue
        r=run(l,z,out);meta.append({'layer':l,'zoom':z,'result':r})
    Path('output/manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
