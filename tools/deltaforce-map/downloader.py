import argparse, io, json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests
from PIL import Image

BASE='https://game.gtimg.cn/images/dfm/cp/a20240729directory/img'
DEFAULT=['map_db','map_yc','map_yc2','map_htjd','map_htjd2','map_bks2','map_cxjy','daba_0f','daba_1f','daba_2f','cgxg_1f','cgxg_2f','bks_1f','bks_2f','bks_3f','cxjy_1f','cxjy_2f','cxjy_3f','cxjy_4f','map_pc','map_ljd','map_gc','map_jq','map_qhz','map_df','map_dg']
HEADERS={'User-Agent':'Mozilla/5.0','Referer':'https://df.qq.com/cp/a20240729directory/'}

def get(url):
    try:
        r=requests.get(url,headers=HEADERS,timeout=(3,5))
        if r.status_code!=200:return None
        Image.open(io.BytesIO(r.content)).verify()
        return r.content
    except Exception:return None

def probe(layer,z,workers):
    side=1<<z
    vals=sorted(set([0,side//4,side//2,(3*side)//4,side-1]))
    pts=[(x,y) for y in vals for x in vals]
    with ThreadPoolExecutor(max_workers=min(workers,len(pts))) as ex:
        fs=[ex.submit(get,f'{BASE}/{layer}/{z}_{x}_{y}.jpg') for x,y in pts]
        for f in as_completed(fs):
            if f.result():
                for q in fs:q.cancel()
                return True
    return False

def run(layer,z,out,workers):
    side=1<<z; total=side*side; tiles=[]; done=0; t=time.time()
    print(f'[{layer}] z={z}, scanning {total} tiles',flush=True)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        fs={ex.submit(get,f'{BASE}/{layer}/{z}_{x}_{y}.jpg'):(x,y) for y in range(side) for x in range(side)}
        for f in as_completed(fs):
            done+=1; b=f.result()
            if b:tiles.append((fs[f],b))
            if done%256==0 or done==total:print(f'[{layer}] {done}/{total}, valid={len(tiles)}, {time.time()-t:.1f}s',flush=True)
    if not tiles:return None
    xs=[p[0][0] for p in tiles]; ys=[p[0][1] for p in tiles]
    xmin,xmax,ymin,ymax=min(xs),max(xs),min(ys),max(ys)
    img=Image.new('RGB',((xmax-xmin+1)*256,(ymax-ymin+1)*256))
    for (x,y),b in tiles:
        try:img.paste(Image.open(io.BytesIO(b)).convert('RGB'),((x-xmin)*256,(y-ymin)*256))
        except Exception:pass
    out.mkdir(parents=True,exist_ok=True)
    path=out/f'{layer}_z{z}_{img.width}x{img.height}.jpg'; img.save(path,quality=96,subsampling=0)
    return {'tiles':len(tiles),'size':[img.width,img.height],'bounds':[xmin,xmax,ymin,ymax],'file':str(path)}

def main():
    p=argparse.ArgumentParser();p.add_argument('--max-zoom',type=int,default=6);p.add_argument('--workers',type=int,default=24);p.add_argument('--only-layers',default='');a=p.parse_args()
    layers=[x.strip() for x in a.only_layers.split(',') if x.strip()] or DEFAULT
    out=Path('output/maps'); meta=[]
    for l in layers:
        print(f'[{l}] probing',flush=True); z=None
        for i in range(a.max_zoom,-1,-1):
            ok=probe(l,i,a.workers); print(f'[{l}] z={i}: {"yes" if ok else "no"}',flush=True)
            if ok:z=i;break
        if z is None:
            meta.append({'layer':l,'ok':False,'error':'no tile found'});continue
        r=run(l,z,out,a.workers);meta.append({'layer':l,'ok':bool(r),'zoom':z,'result':r})
    Path('output').mkdir(exist_ok=True);Path('output/manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
