"""Sub-pixel contour tracer (marching squares on an anti-aliased color field) -> SVG path data."""
import sys, json, math
import numpy as np
from PIL import Image

def field(img, box, target, bg):
    a = np.asarray(img.crop(box).convert('RGB'), dtype=float)
    t = np.array(target, float); b = np.array(bg, float)
    d = t - b
    f = ((a - b) @ d) / (d @ d)
    # pixels of a third color (e.g. white check inside the bubble, amber dot) are not ink
    dist_t = np.linalg.norm(a - t, axis=2); dist_b = np.linalg.norm(a - b, axis=2)
    other = (dist_t > 60) & (dist_b > 60) & (f > 0.25) & (f < 0.75) == False
    f = np.clip(f, 0, 1)
    return np.pad(f, 1)  # zero border so every contour closes

def contours(f, iso=0.5):
    h, w = f.shape
    segs = []
    def interp(p1, v1, p2, v2):
        t = (iso - v1) / (v2 - v1)
        return (p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]))
    for y in range(h - 1):
        for x in range(w - 1):
            c = [((x, y), f[y, x]), ((x + 1, y), f[y, x + 1]), ((x + 1, y + 1), f[y + 1, x + 1]), ((x, y + 1), f[y + 1, x])]
            idx = sum(1 << i for i, (_, v) in enumerate(c) if v >= iso)
            if idx in (0, 15): continue
            edges = []
            for i in range(4):
                (p1, v1), (p2, v2) = c[i], c[(i + 1) % 4]
                if (v1 >= iso) != (v2 >= iso): edges.append((i, interp(p1, v1, p2, v2)))
            if len(edges) == 2:
                segs.append((edges[0][1], edges[1][1]))
            else:  # saddle: resolve with the centre value
                centre = sum(v for _, v in c) / 4
                e = {i: p for i, p in edges}
                if (centre >= iso) == (c[0][1] >= iso):
                    segs += [(e[0], e[1]), (e[2], e[3])]
                else:
                    segs += [(e[3], e[0]), (e[1], e[2])]
    key = lambda p: (round(p[0], 4), round(p[1], 4))
    adj = {}
    for a, b in segs:
        adj.setdefault(key(a), []).append(b); adj.setdefault(key(b), []).append(a)
    seen = set(); loops = []
    for a, b in segs:
        if (key(a), key(b)) in seen: continue
        loop = [a]; prev = a; cur = b
        seen.add((key(a), key(b))); seen.add((key(b), key(a)))
        while key(cur) != key(a):
            loop.append(cur)
            nxt = [p for p in adj[key(cur)] if key(p) != key(prev) and (key(cur), key(p)) not in seen]
            if not nxt: break
            seen.add((key(cur), key(nxt[0]))); seen.add((key(nxt[0]), key(cur)))
            prev, cur = cur, nxt[0]
        if len(loop) > 8: loops.append(loop)
    return loops

def rdp(pts, eps):
    if len(pts) < 3: return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1; n = math.hypot(dx, dy) or 1e-9
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / n
        if d > dmax: dmax, idx = d, i
    if dmax > eps:
        return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]

def to_path(loops, ox, oy, eps=0.2):
    out = []
    for lp in loops:
        far = max(range(len(lp)), key=lambda i: (lp[i][0] - lp[0][0]) ** 2 + (lp[i][1] - lp[0][1]) ** 2)
        s = rdp(lp[:far + 1], eps)[:-1] + rdp(lp[far:] + [lp[0]], eps)[:-1]
        out.append('M' + ' '.join(f'{p[0]-1-ox:.2f} {p[1]-1-oy:.2f}' for p in s) + 'Z')
    return ''.join(out)

def circle(img, box, target, bg):
    a = np.asarray(img.crop(box).convert('RGB'), dtype=float)
    m = (np.linalg.norm(a - np.array(target, float), axis=2) < 45).astype(float)
    area = m.sum(); yy, xx = np.indices(m.shape)
    cx = (xx * m).sum() / area; cy = (yy * m).sum() / area
    return box[0] + cx + 0.5, box[1] + cy + 0.5, math.sqrt(area / math.pi) + 0.5

if __name__ == '__main__':
    img = Image.open(sys.argv[1])
    spec = json.loads(sys.argv[2])
    res = {}
    for name, s in spec.items():
        box = tuple(s['box']); tgt = tuple(int(s['color'][i:i+2], 16) for i in (1, 3, 5)); bg = tuple(int(s['bg'][i:i+2], 16) for i in (1, 3, 5))
        if s.get('circle'):
            res[name] = circle(img, box, tgt, bg)
        else:
            res[name] = to_path(contours(field(img, box, tgt, bg)), 0, 0)
            res[name + '_origin'] = box[:2]
    print(json.dumps(res))
