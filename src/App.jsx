import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════
const PAL = [
  "#00e5ff","#a78bfa","#f59e0b","#34d399","#f87171",
  "#fb923c","#a3e635","#e879f9","#38bdf8","#fbbf24",
  "#10b981","#818cf8","#f472b6","#4ade80","#60a5fa",
];
const STD_SHEETS = [
  { n:"2440 × 1220 мм — ЛДСП / Фанера", w:2440, h:1220 },
  { n:"3050 × 1220 мм",                  w:3050, h:1220 },
  { n:"2800 × 2070 мм — Большой формат", w:2800, h:2070 },
  { n:"2000 × 1000 мм",                  w:2000, h:1000 },
  { n:"1500 × 750 мм",                   w:1500, h:750  },
  { n:"1220 × 2440 мм — Портрет",        w:1220, h:2440 },
];
const ROT_OPTS = [
  { v:1,  l:"1 — Без поворота" },
  { v:2,  l:"2 — 0° · 180°" },
  { v:4,  l:"4 — 0° · 90° · 180° · 270°  ★" },
  { v:8,  l:"8 — шаг 45°" },
  { v:16, l:"16 — шаг 22.5°" },
  { v:36, l:"36 — шаг 10°" },
  { v:72, l:"72 — шаг 5°" },
];
const DEMO = [
  { id:1, name:"Стойка",    w:600, h:350, qty:4, rot:true  },
  { id:2, name:"Перемычка", w:900, h:120, qty:6, rot:true  },
  { id:3, name:"Полка",     w:400, h:400, qty:3, rot:false },
  { id:4, name:"Фасад",    w:700, h:250, qty:2, rot:true  },
];

// ═══════════════════════════════════════════════════════════
//  GEOMETRY HELPERS
// ═══════════════════════════════════════════════════════════
function getBBox(pts) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const {x,y} of pts) {
    if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
  }
  return { x0, y0, x1, y1, w: x1-x0, h: y1-y0 };
}

function rotPts(pts, deg) {
  if (!pts) return null;
  const n = ((deg % 360)+360) % 360;
  if (n < 0.001) return pts;
  const r = n*Math.PI/180, c = Math.cos(r), s = Math.sin(r);
  return pts.map(({x,y}) => ({ x: x*c - y*s, y: x*s + y*c }));
}

// Centre at origin, flip Y (DXF Y-up → screen Y-down)
function normPoly(pts) {
  const { x0,y0,x1,y1 } = getBBox(pts);
  const cx = (x0+x1)/2, cy = (y0+y1)/2;
  return pts.map(({x,y}) => ({ x: x-cx, y: -(y-cy) }));
}

// ── Hole detection helpers ─────────────────────────────────
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
    const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
    if ((yi>py) !== (yj>py) && px < (xj-xi)*(py-yi)/(yj-yi)+xi)
      inside = !inside;
  }
  return inside;
}

function polygonArea(pts) {
  let a = 0;
  for (let i=0, j=pts.length-1; i<pts.length; j=i++)
    a += (pts[j].x+pts[i].x) * (pts[j].y-pts[i].y);
  return Math.abs(a/2);
}

// Evaluate closed periodic cubic B-spline
function evalClosedBSpline3(ctrlPts, numPts) {
  const n = ctrlPts.length;
  const out = [];
  for (let s = 0; s < numPts; s++) {
    const t  = s / numPts;
    const fn = t * n;
    const k  = Math.floor(fn);
    const u  = fn - k;
    const u2 = u*u, u3 = u2*u;
    const b0 = (1 - 3*u + 3*u2 - u3) / 6;
    const b1 = (4 - 6*u2 + 3*u3)     / 6;
    const b2 = (1 + 3*u + 3*u2 - 3*u3) / 6;
    const b3 = u3 / 6;
    const p0 = ctrlPts[(k + n - 1) % n];
    const p1 = ctrlPts[ k          % n];
    const p2 = ctrlPts[(k + 1)     % n];
    const p3 = ctrlPts[(k + 2)     % n];
    out.push({
      x: b0*p0.x + b1*p1.x + b2*p2.x + b3*p3.x,
      y: b0*p0.y + b1*p1.y + b2*p2.y + b3*p3.y,
    });
  }
  return out;
}

// Approximate an OPEN B-spline segment as a polyline.
// For clamped B-splines: curve starts at P[0], ends at P[n-1].
// flag=24 (linear): just two endpoints.
function evalOpenSplineApprox(ctrlPts, isLinear) {
  if (!ctrlPts.length) return [];
  if (isLinear || ctrlPts.length <= 2)
    return [ctrlPts[0], ctrlPts[ctrlPts.length-1]];
  // For non-linear: use de Boor with auto-generated knots (fallback path)
  return evalBSplineDeBoor(ctrlPts, null, 3,
    Math.min(64, Math.max(16, ctrlPts.length * 3)));
}

// Cox-de Boor B-spline evaluation.
// Works for CLAMPED open B-splines of any degree.
// If knots is null/empty, generates a uniform clamped knot vector.
function evalBSplineDeBoor(ctrl, knots, degree, numSamples) {
  const n = ctrl.length;
  const p = Math.min(degree || 3, n - 1);

  // Build knot vector if not provided
  if (!knots || knots.length < n + p + 1) {
    knots = [];
    for (let i = 0; i <= p; i++) knots.push(0);
    const inner = n - p - 1;
    for (let i = 1; i <= inner; i++) knots.push(i / (inner + 1));
    for (let i = 0; i <= p; i++) knots.push(1);
  }

  const tMin = knots[p];
  const tMax = knots[n];
  const out  = [];

  for (let s = 0; s <= numSamples; s++) {
    // Parameter value — clamp slightly inside to avoid edge artifacts
    let x = tMin + (tMax - tMin) * s / numSamples;
    if (s === numSamples) x = tMax - 1e-9;

    // Find knot span k: largest k such that knots[k] <= x < knots[k+1]
    let k = p;
    while (k < n - 1 && knots[k + 1] <= x) k++;

    // De Boor's algorithm — copy the (p+1) relevant control points
    const d = [];
    for (let i = 0; i <= p; i++)
      d.push({ x: ctrl[k - p + i].x, y: ctrl[k - p + i].y });

    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const ki    = j + k - p;
        const denom = knots[ki + p - r + 1] - knots[ki];
        if (Math.abs(denom) < 1e-10) continue;
        const alpha = (x - knots[ki]) / denom;
        d[j].x = (1 - alpha) * d[j - 1].x + alpha * d[j].x;
        d[j].y = (1 - alpha) * d[j - 1].y + alpha * d[j].y;
      }
    }
    out.push({ x: d[p].x, y: d[p].y });
  }
  return out;
}

// Connect open segments into closed chains (contours).
// Each segment has {pts, startPt, endPt}. Matching tolerance: chainTol mm.
function buildClosedChains(segs, chainTol = 0.2) {
  if (!segs.length) return [];
  const tolSq = chainTol * chainTol;
  const distSq = (a, b) => (a.x-b.x)**2 + (a.y-b.y)**2;
  const n = segs.length;
  const used = new Set();
  const chains = [];

  for (let si = 0; si < n; si++) {
    if (used.has(si)) continue;
    const chain = [...segs[si].pts];
    used.add(si);
    const startPt = segs[si].startPt;
    let curEnd    = segs[si].endPt;

    // Extend chain greedily by matching endpoints
    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < n; j++) {
        if (used.has(j)) continue;
        const seg = segs[j];
        if (distSq(curEnd, seg.startPt) < tolSq) {
          chain.push(...seg.pts.slice(1));
          curEnd = seg.endPt;
          used.add(j);
          extended = true;
          break;
        }
        if (distSq(curEnd, seg.endPt) < tolSq) {
          chain.push(...[...seg.pts].reverse().slice(1));
          curEnd = seg.startPt;
          used.add(j);
          extended = true;
          break;
        }
      }
    }

    // Only keep chains that close back to the starting point
    if (distSq(curEnd, startPt) < tolSq * 4 && chain.length >= 3)
      chains.push(chain);
  }
  return chains;
}

// Decimate polygon if too many points (for rendering performance)
function decimatePoly(pts, maxPts = 200) {
  if (pts.length <= maxPts) return pts;
  const step = Math.ceil(pts.length / maxPts);
  return pts.filter((_, i) => i % step === 0);
}

// Group contours: inner polygons (holes) are nested inside their parent.
// Groups by LAYER first to limit O(n²) scope.
// Returns array of {polygon, holes, w, h, layer}
function groupContours(shapes) {
  if (!shapes.length) return [];

  // Step 1: group by layer
  const byLayer = {};
  for (const s of shapes) {
    const l = s.layer || '0';
    if (!byLayer[l]) byLayer[l] = [];
    byLayer[l].push({...s, area: polygonArea(s.polygon)});
  }

  const result = [];

  for (const layer of Object.keys(byLayer)) {
    // Sort largest → smallest (outer contours come first)
    const group = byLayer[layer].sort((a,b) => b.area - a.area);
    // Cap per-layer shapes to avoid O(n²) hang
    const capped = group.length > 200 ? group.slice(0, 200) : group;

    const used = new Set();

    for (let i = 0; i < capped.length; i++) {
      if (used.has(i)) continue;
      const outer = capped[i];
      const obb   = getBBox(outer.polygon);
      const holes = [];

      for (let j = i + 1; j < capped.length; j++) {
        if (used.has(j)) continue;
        const inner = capped[j];
        // Quick bbox pre-filter (fast reject)
        const ibb = getBBox(inner.polygon);
        if (ibb.x0 < obb.x0-1 || ibb.y0 < obb.y0-1 ||
            ibb.x1 > obb.x1+1 || ibb.y1 > obb.y1+1) continue;
        // Centroid containment test
        const cx = (ibb.x0+ibb.x1)/2, cy = (ibb.y0+ibb.y1)/2;
        if (pointInPolygon(cx, cy, outer.polygon)) {
          holes.push(inner.polygon);
          used.add(j);
        }
      }
      used.add(i);

      // Normalize: shift outer+holes by outer's bbox center
      const ocx  = (obb.x0+obb.x1)/2, ocy = (obb.y0+obb.y1)/2;
      const shft = ({x,y}) => ({x:x-ocx, y:y-ocy});
      const nPoly  = outer.polygon.map(shft);
      const nHoles = holes.map(h => h.map(shft));
      const nBB    = getBBox(nPoly);
      result.push({ polygon:nPoly, holes:nHoles, w:nBB.w, h:nBB.h, layer });
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
//  DXF PARSER  (LWPOLYLINE · CIRCLE · ELLIPSE)
// ═══════════════════════════════════════════════════════════

// Tessellate a DXF bulge arc from P1→P2 into polyline segments
function bulgeArcPts(x1,y1,x2,y2,bulge,tol) {
  const ab = Math.abs(bulge);
  if (ab < 1e-5) return [];
  const theta = 4 * Math.atan(ab);
  const d = Math.hypot(x2-x1, y2-y1);
  if (d < 1e-8) return [];
  const R = d / (2 * Math.sin(theta / 2));
  const hh = Math.sqrt(Math.max(0, R*R - (d/2)*(d/2)));
  const mx = (x1+x2)/2, my = (y1+y2)/2;
  // Left-normal of chord
  const px = -(y2-y1)/d, py = (x2-x1)/d;
  const sgn = bulge > 0 ? 1 : -1;
  const cx = mx + sgn*hh*px, cy = my + sgn*hh*py;
  let sa = Math.atan2(y1-cy, x1-cx);
  let ea = Math.atan2(y2-cy, x2-cx);
  if (bulge > 0) { while(ea <= sa) ea += 2*Math.PI; }
  else           { while(ea >= sa) ea -= 2*Math.PI; }
  const segs = Math.max(3, Math.ceil(R * Math.abs(ea-sa) / tol));
  return Array.from({ length: segs }, (_, i) => {
    const a = sa + (ea-sa) * (i+1) / segs;
    return { x: cx + R*Math.cos(a), y: cy + R*Math.sin(a) };
  }); // last point == (x2,y2)
}

function parseDXF(text, tol = 1.0) {
  const raw = text.replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(Boolean);
  const G = [];
  for (let i = 0; i+1 < raw.length; i += 2)
    G.push([+raw[i], raw[i+1]]);

  let gi = 0;
  while (gi < G.length && !(G[gi][0]===2 && G[gi][1]==='ENTITIES')) gi++;

  const foundTypes = new Set();
  for (let k = gi; k < G.length; k++)
    if (G[k][0]===0 && G[k][1]!=='ENDSEC' && G[k][1]!=='EOF') foundTypes.add(G[k][1]);

  gi++;

  const shapes   = []; // closed contours
  const openSegs = []; // open spline/polyline segments → chain-build later

  // ── min-size helper (applied after Y-flip) ─────────────
  const addShape = (pts, layer) => {
    if (pts.length < 3) return;
    const flipped = pts.map(({x,y}) => ({x, y:-y}));
    const bb = getBBox(flipped);
    if (bb.w < 1.5 && bb.h < 1.5) return;       // both tiny → skip
    if (polygonArea(flipped) < 2) return;         // degenerate (self-intersecting) → skip
    const poly = decimatePoly(flipped);
    shapes.push({ polygon:poly, w:bb.w, h:bb.h, layer });
  };

  const addOpenSeg = (pts, layer) => {
    if (pts.length < 2) return;
    const flipped = pts.map(({x,y}) => ({x, y:-y}));
    openSegs.push({
      layer,
      pts:      flipped,
      startPt:  flipped[0],
      endPt:    flipped[flipped.length-1],
    });
  };

  while (gi < G.length) {
    if (G[gi][0]===0 && G[gi][1]==='ENDSEC') break;
    if (G[gi][0] !== 0) { gi++; continue; }
    const etype = G[gi++][1];

    // ── LWPOLYLINE ────────────────────────────────────────
    if (etype === 'LWPOLYLINE') {
      let layer='0', flags=0;
      const xs=[], ys=[], bl=[];
      while (gi < G.length && G[gi][0] !== 0) {
        const [c,v] = G[gi++];
        if (c===8)  layer=v;
        if (c===70) flags=+v;
        if (c===10) { xs.push(+v); bl.push(0); }
        if (c===20) ys.push(+v);
        if (c===42) bl[bl.length-1]=+v;
      }
      const geoCl = xs.length>=3 &&
        Math.hypot(xs[0]-xs[xs.length-1], ys[0]-ys[ys.length-1]) < tol*10;
      const isClosed = (flags&1) || geoCl;
      if (xs.length >= 2) {
        const count = (geoCl && !(flags&1)) ? xs.length-1 : xs.length;
        const pts = [];
        for (let j=0; j<count; j++) {
          pts.push({x:xs[j], y:ys[j]});
          if (Math.abs(bl[j]) > 1e-5) {
            const nj=(j+1)%xs.length;
            bulgeArcPts(xs[j],ys[j],xs[nj],ys[nj],bl[j],tol).slice(0,-1)
              .forEach(p=>pts.push(p));
          }
        }
        if (isClosed) addShape(pts, layer);
        else           addOpenSeg(pts, layer);
      }
      continue;
    }

    // ── POLYLINE / VERTEX ────────────────────────────────
    if (etype === 'POLYLINE') {
      let layer='0', flags=0;
      while (gi < G.length && G[gi][0] !== 0) {
        const [c,v] = G[gi++];
        if (c===8)  layer=v;
        if (c===70) flags=+v;
      }
      const verts=[];
      while (gi < G.length) {
        if (G[gi][0]!==0)            { gi++; continue; }
        if (G[gi][1]==='SEQEND')     { gi++; break; }
        if (G[gi][1]!=='VERTEX')     { break; }
        gi++;
        let vx=0,vy=0,vb=0,vf=0;
        while (gi<G.length&&G[gi][0]!==0) {
          const [c,v]=G[gi++];
          if(c===10)vx=+v; if(c===20)vy=+v;
          if(c===42)vb=+v; if(c===70)vf=+v;
        }
        if(!(vf&16)) verts.push({x:vx,y:vy,b:vb});
      }
      const geoCl2 = verts.length>=3 &&
        Math.hypot(verts[0].x-verts[verts.length-1].x,
                   verts[0].y-verts[verts.length-1].y) < tol*10;
      const isCl2  = (flags&1)||geoCl2;
      const count2 = (geoCl2&&!(flags&1)) ? verts.length-1 : verts.length;
      if (verts.length >= 2) {
        const out=[];
        for(let j=0;j<count2;j++){
          out.push({x:verts[j].x,y:verts[j].y});
          if(Math.abs(verts[j].b)>1e-5){
            const nj=(j+1)%verts.length;
            bulgeArcPts(verts[j].x,verts[j].y,verts[nj].x,verts[nj].y,verts[j].b,tol)
              .slice(0,-1).forEach(p=>out.push(p));
          }
        }
        if (isCl2) addShape(out, layer);
        else        addOpenSeg(out, layer);
      }
      continue;
    }

    // ── SPLINE ─────────────────────────────────────────────
    if (etype === 'SPLINE') {
      let layer='0', flags=0, degree=3;
      const ctrlX=[],ctrlY=[],fitX=[],fitY=[],spKnots=[];
      while (gi<G.length&&G[gi][0]!==0) {
        const [c,v]=G[gi++];
        if(c===8)  layer=v;
        if(c===70) flags=+v;
        if(c===71) degree=+v;
        if(c===40) spKnots.push(+v); // knot vector values
        if(c===10) ctrlX.push(+v);
        if(c===20) ctrlY.push(+v);
        if(c===11) fitX.push(+v);
        if(c===21) fitY.push(+v);
      }
      const spClosed   = (flags&1)!==0;
      const spPeriodic = (flags&2)!==0;
      const spLinear   = (flags&16)!==0;

      let rawPts=[];
      if (fitX.length>=3 && fitX.length===fitY.length) {
        rawPts = fitX.map((x,i)=>({x,y:fitY[i]}));
      } else if (ctrlX.length>=2 && ctrlX.length===ctrlY.length) {
        const ctrl = ctrlX.map((x,i)=>({x,y:ctrlY[i]}));
        if (spClosed || spPeriodic) {
          // Closed/periodic → evaluate as uniform periodic B-spline
          if (ctrl.length >= 4) {
            const numPts = Math.min(128, Math.max(32, ctrl.length*2));
            rawPts = evalClosedBSpline3(ctrl, numPts);
          } else {
            rawPts = ctrl;
          }
        } else if (spLinear) {
          // Linear spline → just start and end (straight line segment)
          rawPts = [ctrl[0], ctrl[ctrl.length-1]];
        } else {
          // Open curved B-spline → Cox-de Boor evaluation with actual knots
          const numPts = Math.min(96, Math.max(16, ctrl.length*4));
          rawPts = evalBSplineDeBoor(ctrl, spKnots.length ? spKnots : null, degree, numPts);
        }
      }
      if (rawPts.length < 2) continue;

      if (spClosed || spPeriodic) {
        const d0 = Math.hypot(rawPts[0].x-rawPts[rawPts.length-1].x,
                              rawPts[0].y-rawPts[rawPts.length-1].y);
        if (d0 < Math.max(tol*5, 0.5) && rawPts.length>3)
          rawPts = rawPts.slice(0,-1);
        addShape(rawPts, layer);
      } else {
        addOpenSeg(rawPts, layer);
      }
      continue;
    }

    // ── CIRCLE ────────────────────────────────────────────
    if (etype === 'CIRCLE') {
      let layer='0',cx=0,cy=0,r=0;
      while(gi<G.length&&G[gi][0]!==0){
        const [c,v]=G[gi++];
        if(c===8) layer=v;
        if(c===10)cx=+v; if(c===20)cy=+v; if(c===40)r=+v;
      }
      if(r>0.001){
        const segs=Math.max(16,Math.ceil(2*Math.PI*r/tol));
        const pts=Array.from({length:segs},(_,i)=>{
          const a=2*Math.PI*i/segs;
          return{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};
        });
        addShape(pts, layer);
      }
      continue;
    }

    // ── ELLIPSE ───────────────────────────────────────────
    if (etype === 'ELLIPSE') {
      let layer='0',cx=0,cy=0,mX=1,mY=0,ratio=1,sp=0,ep=2*Math.PI;
      while(gi<G.length&&G[gi][0]!==0){
        const [c,v]=G[gi++];
        if(c===8) layer=v;
        if(c===10)cx=+v; if(c===20)cy=+v;
        if(c===11)mX=+v; if(c===21)mY=+v;
        if(c===40)ratio=+v; if(c===41)sp=+v; if(c===42)ep=+v;
      }
      const mR=Math.hypot(mX,mY),mnR=mR*ratio,ang=Math.atan2(mY,mX);
      if(mR>0.001){
        let sw=ep-sp; if(sw<=0)sw+=2*Math.PI;
        const segs=Math.max(16,Math.ceil(sw*Math.max(mR,mnR)/tol));
        const pts=Array.from({length:segs},(_,i)=>{
          const t=sp+sw*i/segs;
          const lx=mR*Math.cos(t),ly=mnR*Math.sin(t);
          return{x:cx+lx*Math.cos(ang)-ly*Math.sin(ang),
                 y:cy+lx*Math.sin(ang)+ly*Math.cos(ang)};
        });
        if(sw>2*Math.PI*0.99) addShape(pts, layer);
        else addOpenSeg(pts, layer);
      }
      continue;
    }

    // ── ARC (open) ─────────────────────────────────────────
    if (etype === 'ARC') {
      let layer='0',cx=0,cy=0,r=0,sa=0,ea=360;
      while(gi<G.length&&G[gi][0]!==0){
        const [c,v]=G[gi++];
        if(c===8) layer=v;
        if(c===10)cx=+v; if(c===20)cy=+v; if(c===40)r=+v;
        if(c===50)sa=+v; if(c===51)ea=+v;
      }
      if(r>0.001){
        let span=ea-sa; if(span<=0)span+=360;
        if(span>359.9){
          // Full circle
          const segs=Math.max(16,Math.ceil(2*Math.PI*r/tol));
          const pts=Array.from({length:segs},(_,i)=>{
            const a=(sa+span*i/segs)*Math.PI/180;
            return{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};
          });
          addShape(pts, layer);
        } else {
          const segs=Math.max(4,Math.ceil(span*Math.PI/180*r/tol));
          const pts=Array.from({length:segs+1},(_,i)=>{
            const a=(sa+span*i/segs)*Math.PI/180;
            return{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};
          });
          addOpenSeg(pts, layer);
        }
      }
      continue;
    }

    // ── LINE (as open segment) ──────────────────────────────
    if (etype === 'LINE') {
      let layer='0',x1=0,y1=0,x2=0,y2=0;
      while(gi<G.length&&G[gi][0]!==0){
        const [c,v]=G[gi++];
        if(c===8) layer=v;
        if(c===10)x1=+v; if(c===20)y1=+v;
        if(c===11)x2=+v; if(c===21)y2=+v;
      }
      addOpenSeg([{x:x1,y:y1},{x:x2,y:y2}], layer);
      continue;
    }

    // Skip any other entity body
    while(gi<G.length&&G[gi][0]!==0) gi++;
  }

  // ── Chain-build closed contours from open segments ───────
  const segsByLayer = {};
  for (const seg of openSegs) {
    if (!segsByLayer[seg.layer]) segsByLayer[seg.layer] = [];
    segsByLayer[seg.layer].push(seg);
  }
  for (const [layer, segs] of Object.entries(segsByLayer)) {
    const chains = buildClosedChains(segs, 0.5);
    for (const chain of chains) {
      const bb   = getBBox(chain);
      const area = polygonArea(chain);
      const minD = Math.min(bb.w, bb.h);
      // Skip annotation marks, dimension arrows, degenerate micro-chains.
      // Real cut parts always have area ≥ 200mm² and shortest side ≥ 5mm.
      if (area < 200 || minD < 5) continue;
      shapes.push({ polygon: decimatePoly(chain), w:bb.w, h:bb.h, layer });
    }
  }

  return { shapes, foundTypes };
}

// ═══════════════════════════════════════════════════════════
//  GUILLOTINE BSSF  +  ROTATION STEPS
// ═══════════════════════════════════════════════════════════

function buildOrients(angles, part, gap) {
  const seen = new Set(), result = [];
  for (const angle of angles) {
    let pw, ph, polyPts = null, holePts = null;
    if (part.polygon) {
      const rotated = rotPts(part.polygon, angle);
      const bb = getBBox(rotated);
      pw = bb.w; ph = bb.h;
      polyPts = rotated.map(pt => ({ x:pt.x-bb.x0, y:pt.y-bb.y0 }));
      // Rotate holes with the same angle, offset by the same bbox origin
      holePts = (part.holes||[]).map(hole =>
        rotPts(hole, angle).map(pt => ({ x:pt.x-bb.x0, y:pt.y-bb.y0 }))
      );
    } else {
      const a = ((angle % 180) + 180) % 180;
      [pw, ph] = (a < 45 || a >= 135) ? [part.w, part.h] : [part.h, part.w];
    }
    const key = `${Math.round(pw*10)}_${Math.round(ph*10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ pw, ph, bw:pw+gap, bh:ph+gap, rot:angle, polyPts, holePts });
  }
  return result;
}

function getOrients(part, gap, rotSteps) {
  if (!part.rot)     return buildOrients([0], part, gap);
  if (!part.polygon) return buildOrients([0, 90], part, gap);
  // Polygon → try all rotSteps discrete angles
  return buildOrients(
    Array.from({ length:rotSteps }, (_, i) => i*360/rotSteps),
    part, gap
  );
}

function placeItem(item, sheet, W, H, gap, rotSteps) {
  const ors = getOrients(item, gap, rotSteps);
  let best = null, bScore = Infinity;
  for (const o of ors)
    for (const r of sheet.fr)
      if (o.bw <= r.w+0.001 && o.bh <= r.h+0.001) {
        const s = Math.min(r.w-o.bw, r.h-o.bh);
        if (s < bScore) { bScore=s; best={r,o}; }
      }
  if (!best) return false;
  const { r, o } = best;
  sheet.pl.push({
    iid:item.iid, pid:item.id, name:item.name,
    x:r.x, y:r.y, pw:o.pw, ph:o.ph, rot:o.rot, ci:item.ci,
    polyPts:o.polyPts, holePts:o.holePts
  });
  const rW=r.w-o.bw, rH=r.h-o.bh, nr=[];
  if (rW < rH) {
    if (rW>0.5) nr.push({x:r.x+o.bw, y:r.y,       w:rW,  h:o.bh});
    if (rH>0.5) nr.push({x:r.x,      y:r.y+o.bh,  w:r.w, h:rH  });
  } else {
    if (rH>0.5) nr.push({x:r.x,      y:r.y+o.bh,  w:o.bw, h:rH });
    if (rW>0.5) nr.push({x:r.x+o.bw, y:r.y,        w:rW,  h:r.h});
  }
  sheet.fr = sheet.fr.filter(x => x !== r).concat(nr);
  return true;
}

function guillotinePack(parts, W, H, gap, rotSteps) {
  const items = [];
  parts.forEach((p, i) => {
    for (let q = 0; q < p.qty; q++)
      items.push({ ...p, iid:`${p.id}_${q}`, ci:i%PAL.length });
  });
  items.sort((a,b) => b.w*b.h - a.w*a.h || Math.max(b.w,b.h) - Math.max(a.w,a.h));
  const sheets=[], skipped=[];
  for (const it of items) {
    const ors = getOrients(it, gap, rotSteps);
    if (!ors.some(o => o.bw<=W+0.001 && o.bh<=H+0.001)) { skipped.push(it); continue; }
    let placed = false;
    for (const sh of sheets) if (placeItem(it,sh,W,H,gap,rotSteps)) { placed=true; break; }
    if (!placed) {
      const sh = { fr:[{x:0,y:0,w:W,h:H}], pl:[] };
      sheets.push(sh);
      placeItem(it, sh, W, H, gap, rotSteps);
    }
  }
  return { sheets:sheets.map((s,i) => ({id:i+1, pl:s.pl})), skipped };
}

// ═══════════════════════════════════════════════════════════
//  SVG SHEET CANVAS
// ═══════════════════════════════════════════════════════════
function SheetSVG({ data, W, H, sc, labels }) {
  const sw = W*sc, sh = H*sc;
  const gMm = W > 2000 ? 200 : W > 800 ? 100 : 50;
  return (
    <svg width={sw} height={sh} style={{ display:"block", borderRadius:2 }}>
      <defs>
        <pattern id="cncDots" x={0} y={0}
          width={gMm*sc} height={gMm*sc} patternUnits="userSpaceOnUse">
          <circle cx={gMm*sc} cy={gMm*sc} r={0.8} fill="#0b2040"/>
        </pattern>
      </defs>
      <rect width={sw} height={sh} fill="#030c18"/>
      <rect width={sw} height={sh} fill="url(#cncDots)"/>
      {[1,2,3,4,5,6].map(i => i*gMm).filter(x => x < W).map(x => (
        <line key={x} x1={x*sc} y1={sh-5} x2={x*sc} y2={sh}
          stroke="#0d2545" strokeWidth={1}/>
      ))}

      {data?.pl.map(p => {
        const bx=p.x*sc, by=p.y*sc, bw=p.pw*sc, bh=p.ph*sc;
        const col = PAL[p.ci];
        const fz = Math.max(6, Math.min(10, bw/(p.name.length*0.72+1.5), bh/3.8));
        const hasTxt = labels && bw > 28 && bh > 16;
        const hasDim = labels && bw > 56 && bh > 32;
        const ra = Math.round(p.rot||0);
        const rLbl = ra > 0 ? ` ${ra}°` : '';

        if (p.polyPts) {
          // Build compound SVG path: outer contour + holes → fill-rule evenodd
          const ptToStr = (pt, i) =>
            `${i===0?'M':'L'}${((p.x+pt.x)*sc).toFixed(2)},${((p.y+pt.y)*sc).toFixed(2)}`;
          const outerD  = p.polyPts.map(ptToStr).join(' ') + ' Z';
          const holesD  = (p.holePts||[]).map(hole =>
            hole.map(ptToStr).join(' ') + ' Z'
          ).join(' ');
          return (
            <g key={p.iid}>
              <path d={outerD + ' ' + holesD}
                fillRule="evenodd"
                fill={col} fillOpacity={0.18}
                stroke={col} strokeWidth={1.4}/>
              {/* Holes: highlight inner contours */}
              {(p.holePts||[]).map((hole, hi) => (
                <path key={hi}
                  d={hole.map(ptToStr).join(' ') + ' Z'}
                  fill="none" stroke={col} strokeWidth={0.7}
                  strokeDasharray="3 2" opacity={0.5}/>
              ))}
              <rect x={bx+1} y={by+1}
                width={Math.max(0,bw-2)} height={Math.max(0,bh-2)}
                fill="none" stroke={col} strokeWidth={0.5}
                strokeDasharray="4 3" opacity={0.18}/>
              {hasTxt && (
                <text x={bx+bw/2} y={by+bh/2}
                  textAnchor="middle" dominantBaseline="middle"
                  fill={col} fontSize={fz}
                  fontFamily="'JetBrains Mono','Courier New',monospace"
                  fontWeight={700} fillOpacity={0.9}>
                  {p.name}{rLbl}
                  {(p.holePts||[]).length>0 &&
                    <tspan fontSize={fz-2} fillOpacity={0.5}> ⌀{(p.holePts||[]).length}</tspan>}
                </text>
              )}
            </g>
          );
        }

        // ── Rectangle part ──────────────────────────────
        return (
          <g key={p.iid}>
            <rect x={bx+1} y={by+1}
              width={Math.max(0,bw-2)} height={Math.max(0,bh-2)}
              fill={col} fillOpacity={0.1}
              stroke={col} strokeWidth={1.2} rx={1.5}/>
            <rect x={bx+1} y={by+1}
              width={Math.max(0,bw-2)}
              height={Math.min(3.5, Math.max(0,bh-2))}
              fill={col} fillOpacity={0.85} rx={1.5}/>
            {hasTxt && (
              <text x={bx+bw/2} y={by+bh/2-(hasDim?fz*0.6:0)}
                textAnchor="middle" dominantBaseline="middle"
                fill={col} fontSize={fz}
                fontFamily="'JetBrains Mono','Courier New',monospace"
                fontWeight={700} fillOpacity={0.9}>
                {ra===90||ra===270 ? `↺ ` : ra>0 ? `${ra}° ` : ''}{p.name}
              </text>
            )}
            {hasDim && (
              <text x={bx+bw/2} y={by+bh/2+fz*0.75}
                textAnchor="middle" dominantBaseline="middle"
                fill={col} fontSize={Math.max(5,fz-2)}
                fontFamily="'JetBrains Mono','Courier New',monospace"
                fillOpacity={0.45}>
                {Math.round(p.pw)}×{Math.round(p.ph)}
              </text>
            )}
          </g>
        );
      })}

      <rect width={sw} height={sh} fill="none" stroke="#0d2545" strokeWidth={2}/>
      <text x={sw/2} y={sh-1} textAnchor="middle" fill="#0d2545"
        fontSize={8} fontFamily="monospace">{W} мм</text>
      <text x={4} y={sh/2} textAnchor="middle" fill="#0d2545"
        fontSize={8} fontFamily="monospace"
        transform={`rotate(-90,4,${sh/2})`}>{H} мм</text>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
//  EXPORT GENERATORS
// ═══════════════════════════════════════════════════════════

function escapeXml(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function sanitizeLayer(name) {
  return (name||"PART")
    .replace(/[<>\/\\":;?*|,=`\s]/g,"_")
    .slice(0,31) || "PART";
}

function dlFile(content, filename, mime) {
  const b = new Blob([content], {type: mime + ";charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = filename;
  a.click();
}

// ── SVG ─────────────────────────────────────────────────────
// All sheets side-by-side in one SVG file. Coordinates are
// in mm (viewBox = sheet dimensions). Y-down matches SVG spec,
// so screen coords can be used directly — no Y-flip needed.
function generateAllSVG(sheets, W, H) {
  const sheetGap = 40;  // mm between sheets
  const padTop   = 14;  // space above for sheet labels
  const padBot   = 12;  // space below for dimension text
  const totalW   = sheets.length * W + (sheets.length - 1) * sheetGap;
  const totalH   = H + padTop + padBot;

  const L = [];
  L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  L.push(`<svg xmlns="http://www.w3.org/2000/svg"`);
  L.push(`  width="${totalW}mm" height="${totalH}mm"`);
  L.push(`  viewBox="0 0 ${totalW} ${totalH}">`);
  L.push(`<title>CNCnest PRO — Карта раскроя (${sheets.length} листов)</title>`);
  L.push(`<style>`);
  L.push(`.bg{fill:#f8fafc;stroke:#334155;stroke-width:0.6}`);
  L.push(`.grid{stroke:#e2e8f0;stroke-width:0.18}`);
  L.push(`.rf{fill:#dbeafe;opacity:.65}`);
  L.push(`.rc{fill:none;stroke:#1e40af;stroke-width:0.35}`);
  L.push(`.pf{fill:#ede9fe;opacity:.65}`);
  L.push(`.pc{fill:none;stroke:#5b21b6;stroke-width:0.35}`);
  L.push(`.bb{fill:none;stroke:#5b21b6;stroke-width:0.2;stroke-dasharray:2 2;opacity:.4}`);
  L.push(`.lbl{font:5.5px "Courier New",monospace;text-anchor:middle;dominant-baseline:middle;fill:#1e3a8a}`);
  L.push(`.plbl{font:5.5px "Courier New",monospace;text-anchor:middle;dominant-baseline:middle;fill:#4c1d95}`);
  L.push(`.shd{font:bold 7px "Helvetica Neue",sans-serif;text-anchor:middle;fill:#475569}`);
  L.push(`.dim{font:4.5px "Courier New",monospace;text-anchor:middle;fill:#94a3b8}`);
  L.push(`</style>`);
  L.push(`<rect width="${totalW}" height="${totalH}" fill="white"/>`);

  const gMm = W > 2000 ? 200 : 100;

  sheets.forEach((sheet, si) => {
    const ox  = si * (W + sheetGap);  // sheet X offset
    const oy  = padTop;               // sheet Y offset (below label)
    const eff = sheet.pl.reduce((s,p)=>s+p.pw*p.ph,0) / (W*H) * 100;

    L.push(`\n<!-- ═ ЛИСТ ${sheet.id} ═ -->`);
    L.push(`<g id="sheet${sheet.id}">`);

    // Background
    L.push(`  <rect class="bg" x="${ox}" y="${oy}" width="${W}" height="${H}"/>`);

    // Grid
    for (let x = gMm; x < W; x += gMm)
      L.push(`  <line class="grid" x1="${ox+x}" y1="${oy}" x2="${ox+x}" y2="${oy+H}"/>`);
    for (let y = gMm; y < H; y += gMm)
      L.push(`  <line class="grid" x1="${ox}" y1="${oy+y}" x2="${ox+W}" y2="${oy+y}"/>`);

    // Parts
    for (const p of sheet.pl) {
      const ra  = Math.round(p.rot||0);
      const lbl = escapeXml(ra > 0 ? `${p.name} ${ra}°` : p.name);
      const bx  = ox+p.x, by = oy+p.y, bw = p.pw, bh = p.ph;

      if (p.polyPts) {
        const pts = p.polyPts
          .map(pt => `${(ox+p.x+pt.x).toFixed(2)},${(oy+p.y+pt.y).toFixed(2)}`)
          .join(" ");
        L.push(`  <polygon class="pf pc" points="${pts}"/>`);
        // Ghost bounding box
        L.push(`  <rect class="bb" x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}"/>`);
        if (bw > 22 && bh > 11)
          L.push(`  <text class="plbl" x="${(bx+bw/2).toFixed(2)}" y="${(by+bh/2).toFixed(2)}">${lbl}</text>`);
      } else {
        L.push(`  <rect class="rf" x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}"/>`);
        L.push(`  <rect class="rc" x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}"/>`);
        if (bw > 22 && bh > 11)
          L.push(`  <text class="lbl" x="${(bx+bw/2).toFixed(2)}" y="${(by+bh/2).toFixed(2)}">${lbl}</text>`);
      }
    }

    // Labels & dimensions
    L.push(`  <text class="shd" x="${ox+W/2}" y="${oy-4}">Лист ${sheet.id}  ·  КПД ${eff.toFixed(1)}%  ·  ${sheet.pl.length} дет.</text>`);
    L.push(`  <text class="dim" x="${ox+W/2}" y="${oy+H+7}">${W} мм</text>`);

    L.push(`</g>`);
  });

  L.push(`</svg>`);
  return L.join("\n");
}

// ── DXF ─────────────────────────────────────────────────────
// Format: AC1009 (R12) — максимальная совместимость.
// Не требует subclass-маркеров (100 AcDb…).
// Контуры: POLYLINE/VERTEX/SEQEND.
// Отверстия: отдельный слой HOLES (можно скрыть в CAM).
// Y: screen Y-down → DXF Y-up: y_dxf = H − y_screen.
function generateDXF(sheets, W, H) {
  const lines = [];
  // Каждый аргумент — отдельная строка в файле
  const w = (...args) => args.forEach(a => lines.push(String(a)));

  const sheetGap = 100; // мм между листами по X

  // ── HEADER ────────────────────────────────────────────────
  w("0","SECTION","2","HEADER");
  w("9","$ACADVER","1","AC1009");       // R12
  w("9","$INSUNITS","70","4");          // 4 = мм
  w("9","$LUNITS","70","2");            // decimal
  w("9","$MEASUREMENT","70","1");       // metric
  w("0","ENDSEC");

  // ── TABLES ────────────────────────────────────────────────
  const layerSet = new Set(["0","SHEET","LABELS","HOLES"]);
  sheets.forEach(sh => sh.pl.forEach(p => layerSet.add(sanitizeLayer(p.name))));

  w("0","SECTION","2","TABLES");

  // LTYPE
  w("0","TABLE","2","LTYPE","70","1");
  w("0","LTYPE");
  w("2","CONTINUOUS","70","0","3","Solid line","72","65","73","0","40","0.0");
  w("0","ENDTAB");

  // LAYER
  w("0","TABLE","2","LAYER","70",String(layerSet.size));
  const lyColor = { "0":7, SHEET:3, LABELS:9, HOLES:6 };
  layerSet.forEach(nm => {
    w("0","LAYER");
    w("2",nm);
    w("70","0");
    w("62",String(lyColor[nm] != null ? lyColor[nm] : 1));
    w("6","CONTINUOUS");
  });
  w("0","ENDTAB");

  w("0","ENDSEC");

  // ── ENTITIES ──────────────────────────────────────────────
  w("0","SECTION","2","ENTITIES");

  // R12 POLYLINE / VERTEX / SEQEND
  const r12poly = (layer, pts, closed = true) => {
    w("0","POLYLINE");
    w("8",layer);
    w("66","1");                        // vertices follow
    w("70", closed ? "1" : "0");        // 1 = замкнута
    pts.forEach(([x,y]) => {
      w("0","VERTEX");
      w("8",layer);
      w("10",x.toFixed(4));
      w("20",y.toFixed(4));
      w("30","0.0");
    });
    w("0","SEQEND");
    w("8",layer);
  };

  // R12 TEXT (простой, без выравнивания — самый совместимый вариант)
  const r12text = (layer, x, y, h, txt) => {
    // Заменяем не-ASCII (кириллицу) на латинские эквиваленты в метке
    const safe = txt.replace(/[^\x20-\x7E]/g, "?");
    if (!safe.trim()) return;
    w("0","TEXT");
    w("8",layer);
    w("10",x.toFixed(4));
    w("20",y.toFixed(4));
    w("30","0.0");
    w("40",h.toFixed(3));
    w("1",safe);
  };

  // Y-flip: экранные координаты (Y-вниз) → DXF (Y-вверх)
  const fy = y => H - y;

  sheets.forEach((sheet, si) => {
    const ox = si * (W + sheetGap);

    // Граница листа
    r12poly("SHEET", [
      [ox,    fy(0)],
      [ox+W,  fy(0)],
      [ox+W,  fy(H)],
      [ox,    fy(H)],
    ]);

    for (const p of sheet.pl) {
      const layer = sanitizeLayer(p.name);
      const ra  = Math.round(p.rot || 0);
      const lbl = ra > 0 ? `${p.name.replace(/[^\x20-\x7E]/g,"?")} ${ra}d` : p.name.replace(/[^\x20-\x7E]/g,"?");

      if (p.polyPts) {
        // Внешний контур полигона
        r12poly(layer, p.polyPts.map(pt => [
          ox + p.x + pt.x,
          fy(p.y + pt.y),
        ]));
        // Отверстия — отдельный слой HOLES
        (p.holePts || []).forEach(hole => {
          r12poly("HOLES", hole.map(pt => [
            ox + p.x + pt.x,
            fy(p.y + pt.y),
          ]));
        });
      } else {
        // Прямоугольная деталь — 4 угла
        r12poly(layer, [
          [ox+p.x,       fy(p.y)      ],
          [ox+p.x+p.pw,  fy(p.y)      ],
          [ox+p.x+p.pw,  fy(p.y+p.ph) ],
          [ox+p.x,       fy(p.y+p.ph) ],
        ]);
      }

      // Подпись на слое LABELS (в CAM скрыть этот слой)
      const th = Math.max(2, Math.min(8, p.ph*0.28, p.pw/(lbl.length*0.65+1)));
      r12text("LABELS", ox+p.x+p.pw/2, fy(p.y+p.ph/2), th, lbl);
    }
  });

  w("0","ENDSEC");
  w("0","EOF");

  return lines.join("\r\n") + "\r\n";
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════
const inp = (ext={}) => ({
  background:"#030c18", border:"1px solid #0d2545", borderRadius:3,
  padding:"4px 7px", color:"#7fa8cc", fontSize:11, outline:"none",
  boxSizing:"border-box",
  fontFamily:"'JetBrains Mono','Courier New',monospace", ...ext,
});
const effColor = v => v > 80 ? "#10b981" : v > 60 ? "#f59e0b" : "#ef4444";
const CAP = {
  fontSize:9, letterSpacing:"0.15em", color:"#1a3a5c",
  fontFamily:"'JetBrains Mono','Courier New',monospace",
  display:"block", marginBottom:6,
};
const DIV = { borderTop:"1px solid #0d2545", margin:"8px 0" };

// ═══════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [parts,   setParts]   = useState(DEMO);
  const [W,       setW]       = useState(2440);
  const [H,       setH]       = useState(1220);
  const [gap,     setGap]     = useState(3);
  const [res,     setRes]     = useState(null);
  const [cur,     setCur]     = useState(0);
  const [busy,    setBusy]    = useState(false);
  const [dirty,   setDirty]   = useState(false);
  const [labels,  setLabels]  = useState(true);
  const [sc,      setSc]      = useState(0.25);
  const [nid,     setNid]     = useState(5);
  const [form,    setForm]    = useState({ name:"", w:"", h:"", qty:"1", rot:true });
  const [eid,     setEid]     = useState(null);
  const [tab,     setTab]     = useState("parts");
  const [rotSteps,setRotSteps]= useState(4);
  const [arcTol,  setArcTol]  = useState(1.0);
  const [expOpen, setExpOpen] = useState(false);
  const [zoom,    setZoom]    = useState(1);
  const [panX,    setPanX]    = useState(0);
  const [panY,    setPanY]    = useState(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // Custom sheet sizes — persisted to localStorage in Electron
  const [customSheets, setCustomSheets] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cncnest_sheets') || '[]'); }
    catch { return []; }
  });
  const [customForm, setCustomForm] = useState({ n:"", w:"", h:"" });
  const fileRef   = useRef();
  const expRef    = useRef();
  const canvasRef = useRef();
  const panRef    = useRef({ active:false, sx:0, sy:0, px:0, py:0 });

  useEffect(() => { runCalc(DEMO,2440,1220,3,4); }, []);
  useEffect(() => {
    setSc(Math.max(0.05, Math.min(0.52, Math.min(614/W, 414/H)*0.92)));
  }, [W, H]);

  // ── CALCULATION ─────────────────────────────────────────
  function runCalc(p, sW, sH, g, rs) {
    const valid = p.filter(x => x.w>0 && x.h>0 && x.qty>0);
    if (!valid.length) return;
    setBusy(true); setDirty(false);
    setTimeout(() => {
      try { setRes(guillotinePack(valid,sW,sH,g,rs)); setCur(0); }
      catch(e) { console.error(e); }
      setBusy(false);
    }, 70);
  }
  const doCalc  = ()       => runCalc(parts, W, H, gap, rotSteps);
  const setSheet = (w, h) => { setW(w); setH(h); setDirty(true); };

  // ── PART FORM ───────────────────────────────────────────
  function submitForm() {
    const w = +form.w, h = +form.h, q = Math.max(1, +form.qty||1);
    if (!form.name.trim() || !w || !h) return;
    if (eid !== null) {
      setParts(p => p.map(x => x.id===eid
        ? {...x, name:form.name, w, h, qty:q, rot:form.rot} : x));
      setEid(null);
    } else {
      setParts(p => [...p, { id:nid, name:form.name.trim(), w, h, qty:q, rot:form.rot }]);
      setNid(n => n+1);
    }
    setForm({ name:"", w:"", h:"", qty:"1", rot:true });
    setDirty(true);
  }
  const startEdit  = p  => { setEid(p.id); setForm({name:p.name,w:""+p.w,h:""+p.h,qty:""+p.qty,rot:p.rot}); };
  const cancelEdit = () => { setEid(null); setForm({name:"",w:"",h:"",qty:"1",rot:true}); };
  const delPart    = id => { setParts(p=>p.filter(x=>x.id!==id)); if(eid===id) cancelEdit(); setDirty(true); };
  const changeQty  = (id, delta) => {
    setParts(p => p.map(x => x.id===id ? {...x, qty: Math.max(1, x.qty+delta)} : x));
    setDirty(true);
  };
  const setQtyDirect = (id, val) => {
    const q = Math.max(1, parseInt(val)||1);
    setParts(p => p.map(x => x.id===id ? {...x, qty:q} : x));
    setDirty(true);
  };

  // ── ZOOM / PAN ───────────────────────────────────────────
  const resetView = () => { setZoom(1); setPanX(0); setPanY(0); };

  // ── CUSTOM SHEET SIZES ───────────────────────────────────
  const addCustomSheet = () => {
    const w = +customForm.w, h = +customForm.h;
    if (!w || !h || w < 50 || h < 50) return;
    const name = customForm.n.trim() || `${w} × ${h} мм`;
    const updated = [...customSheets, { n:name, w, h }];
    setCustomSheets(updated);
    try { localStorage.setItem('cncnest_sheets', JSON.stringify(updated)); } catch {}
    setCustomForm({ n:"", w:"", h:"" });
  };
  const removeCustomSheet = (idx) => {
    const updated = customSheets.filter((_,i) => i !== idx);
    setCustomSheets(updated);
    try { localStorage.setItem('cncnest_sheets', JSON.stringify(updated)); } catch {}
  };

  const onCanvasWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setZoom(z => {
      const nz = Math.max(0.1, Math.min(8, z * factor));
      const scale = nz / z;
      setPanX(px => cx - (cx - px) * scale);
      setPanY(py => cy - (cy - py) * scale);
      return nz;
    });
  };

  const onCanvasMouseDown = (e) => {
    if (e.button !== 0) return;
    panRef.current = { active:true, sx:e.clientX, sy:e.clientY, px:panX, py:panY };
  };
  const onCanvasMouseMove = (e) => {
    if (!panRef.current.active) return;
    setPanX(panRef.current.px + (e.clientX - panRef.current.sx));
    setPanY(panRef.current.py + (e.clientY - panRef.current.sy));
  };
  const onCanvasMouseUp = () => { panRef.current.active = false; };

  // ── DRAG & DROP DXF ─────────────────────────────────────
  const onDragOver = (e) => { e.preventDefault(); setIsDraggingOver(true); };
  const onDragLeave = () => setIsDraggingOver(false);
  const onDrop = (e) => {
    e.preventDefault(); setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.dxf'));
    if (!files.length) { alert("Перетащите файлы .dxf"); return; }
    files.forEach(handleDXFFile);
  };

  // ── DXF IMPORT ──────────────────────────────────────────
  function handleDXFFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const { shapes, foundTypes } = parseDXF(e.target.result, arcTol);
        if (!shapes.length) {
          const supported = ['LWPOLYLINE','POLYLINE','SPLINE','CIRCLE','ELLIPSE'];
          const found = [...foundTypes].filter(t => t !== 'VERTEX' && t !== 'SEQEND');
          const unsupported = found.filter(t => !supported.includes(t));
          let msg = "В файле не найдено замкнутых контуров.\n\n";
          if (found.length) msg += `Найдены объекты: ${found.join(', ')}\n\n`;
          msg += "Поддерживаются:\n• LWPOLYLINE (замкн.) · POLYLINE/VERTEX · SPLINE · CIRCLE · ELLIPSE\n\n";
          if (unsupported.length) {
            msg += `Неподдерживаемые: ${unsupported.join(', ')}\n`;
            msg += "Совет: экспортируйте в DXF R2010 → 'Экспорт в полилинии'.";
          } else {
            msg += "Совет: убедитесь что контуры замкнуты (PEDIT → Close в AutoCAD).";
          }
          alert(msg); return;
        }
        // Group outer contours with their holes
        const grouped = groupContours(shapes);
        let id = nid;
        const baseName = file.name.replace(/\.dxf$/i,"");
        const added = grouped.map((s, i) => {
          const name = s.layer && s.layer !== "0" ? s.layer : `${baseName}_${i+1}`;
          return {
            id: id++, name, qty:1, rot:true,
            w: Math.round(s.w * 10) / 10,
            h: Math.round(s.h * 10) / 10,
            polygon: s.polygon,
            holes:   s.holes,
            source: "dxf",
          };
        });
        setNid(id);
        setParts(p => [...p, ...added]);
        setDirty(true);
      } catch(err) { alert("Ошибка разбора DXF: " + err.message); }
    };
    reader.readAsText(file);
  }

  // ── DEMO POLYGON SHAPES ─────────────────────────────────
  function addDemoPolygons() {
    // L-shape (400×300 with 200×150 notch)
    const lRaw = [{x:0,y:0},{x:400,y:0},{x:400,y:150},{x:200,y:150},{x:200,y:300},{x:0,y:300}];
    const lPoly = normPoly(lRaw); const lBB = getBBox(lPoly);
    // T-shape
    const tRaw = [{x:0,y:0},{x:500,y:0},{x:500,y:100},{x:300,y:100},{x:300,y:300},{x:200,y:300},{x:200,y:100},{x:0,y:100}];
    const tPoly = normPoly(tRaw); const tBB = getBBox(tPoly);
    // Regular hexagon r=120
    const hexPoly = normPoly(Array.from({length:6},(_,i)=>{const a=Math.PI/6+i*Math.PI/3;return{x:120*Math.cos(a),y:120*Math.sin(a)};}));
    const hexBB = getBBox(hexPoly);
    // Arc-rounded rectangle (16-segment arch top)
    const archRaw = [];
    for(let i=0;i<=8;i++){const a=Math.PI*i/8;archRaw.push({x:100+100*Math.cos(Math.PI-a),y:200+100*Math.sin(Math.PI-a)});}
    archRaw.push({x:200,y:0},{x:0,y:0});
    const archPoly = normPoly(archRaw); const archBB = getBBox(archPoly);

    let id = nid;
    const demo = [
      {id:id++,name:"Г-стойка",   w:lBB.w,  h:lBB.h,   qty:2,rot:true, polygon:lPoly,    source:"demo"},
      {id:id++,name:"Т-перемычка",w:tBB.w,  h:tBB.h,   qty:2,rot:true, polygon:tPoly,    source:"demo"},
      {id:id++,name:"Гексагон",   w:hexBB.w,h:hexBB.h, qty:3,rot:true, polygon:hexPoly,  source:"demo"},
      {id:id++,name:"Арка",       w:archBB.w,h:archBB.h,qty:2,rot:true, polygon:archPoly, source:"demo"},
    ];
    setNid(id);
    setParts(p => [...p, ...demo]);
    setDirty(true);
  }

  // ── EXPORT ──────────────────────────────────────────────
  function exportReport() {
    if (!res) return;
    const tA = sheets.reduce((s,sh)=>s+sh.pl.reduce((a,p)=>a+p.pw*p.ph,0),0);
    const lines = [
      "══════════════════════════════════════",
      "  CNCnest PRO v2  —  КАРТА РАСКРОЯ",
      "══════════════════════════════════════","",
      `Лист:           ${W} × ${H} мм`,
      `Зазор / рез:    ${gap} мм`,
      `Шагов поворота: ${rotSteps}  (${(360/rotSteps).toFixed(1)}° шаг)`,
      `Листов:         ${sheets.length}`,
      `КПД:            ${(tA/(sheets.length*shA)*100).toFixed(1)}%`,
      `Площ. деталей:  ${(tA/1e6).toFixed(4)} м²`,
      `Отходы:         ${((sheets.length*shA-tA)/1e6).toFixed(4)} м²`, "",
    ];
    sheets.forEach((sh,i) => {
      const e = sh.pl.reduce((s,p)=>s+p.pw*p.ph,0)/shA*100;
      lines.push(`── Лист ${i+1}  (${sh.pl.length} дет., КПД ${e.toFixed(1)}%) ──`);
      sh.pl.forEach(p => lines.push(
        `  ${p.name.padEnd(16)} X:${String(Math.round(p.x)).padStart(5)}` +
        `  Y:${String(Math.round(p.y)).padStart(5)}` +
        `  ${Math.round(p.pw)}×${Math.round(p.ph)} мм` +
        `  угол: ${Math.round(p.rot||0)}°` +
        (p.polyPts ? " [полигон]" : "")
      ));
      lines.push("");
    });
    if (res.skipped?.length) {
      lines.push("⚠ Не помещаются:");
      res.skipped.forEach(p => lines.push(`  ${p.name}  ${Math.round(p.w)}×${Math.round(p.h)} мм`));
    }
    const b = new Blob([lines.join("\n")], {type:"text/plain;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = "cnc_nesting_v2.txt"; a.click();
  }

  // ── COMPUTED ────────────────────────────────────────────
  const sheets  = res?.sheets || [];
  const shA     = W * H;
  const totA    = sheets.reduce((s,sh)=>s+sh.pl.reduce((a,p)=>a+p.pw*p.ph,0),0);
  const eff     = sheets.length ? totA/(sheets.length*shA)*100 : 0;
  const curSh   = sheets[cur];
  const curEff  = curSh ? curSh.pl.reduce((s,p)=>s+p.pw*p.ph,0)/shA*100 : 0;
  const show    = res && !dirty;

  // Close export dropdown when clicking outside
  useEffect(() => {
    if (!expOpen) return;
    const handler = e => { if (expRef.current && !expRef.current.contains(e.target)) setExpOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expOpen]);

  // ── DOWNLOAD SVG ────────────────────────────────────────
  function downloadSVG() {
    if (!show) return;
    setExpOpen(false);
    dlFile(generateAllSVG(sheets, W, H), "cnc_nesting.svg", "image/svg+xml");
  }

  // ── DOWNLOAD DXF ────────────────────────────────────────
  function downloadDXF() {
    if (!show) return;
    setExpOpen(false);
    dlFile(generateDXF(sheets, W, H), "cnc_nesting.dxf", "application/dxf");
  }

  // ── DOWNLOAD TXT ────────────────────────────────────────
  function downloadTXT() {
    setExpOpen(false);
    exportReport();
  }

  const PBG = { background:"#050e1c", flexShrink:0 };

  // ════════════════════════════════════════════════════════
  return (
    <div style={{height:"100vh",display:"flex",flexDirection:"column",
      background:"#030c18",color:"#7fa8cc",overflow:"hidden",
      fontFamily:"'Barlow','Helvetica Neue',Helvetica,sans-serif"}}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;900&family=JetBrains+Mono:wght@400;700&display=swap');
        *{box-sizing:border-box}
        input[type=range]{accent-color:#00e5ff}
        input[type=checkbox],input[type=radio]{accent-color:#00e5ff;cursor:pointer}
        select option{background:#030c18}
        ::-webkit-scrollbar{width:4px;background:#030c18}
        ::-webkit-scrollbar-thumb{background:#0d2545;border-radius:2px}
        @keyframes scan{0%{top:-3px}100%{top:100%}}
        @keyframes blink{0%,100%{opacity:.45}50%{opacity:1}}
        button:focus{outline:none}
      `}</style>

      {/* ══════════ HEADER ══════════ */}
      <div style={{height:46,...PBG,borderBottom:"1px solid #0d2545",
        display:"flex",alignItems:"center",padding:"0 16px",gap:14}}>

        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <svg width={22} height={22} viewBox="0 0 22 22">
            <circle cx={11} cy={11} r={9}   fill="none" stroke="#00e5ff" strokeWidth={1.4}/>
            <circle cx={11} cy={11} r={3.5} fill="none" stroke="#00e5ff" strokeWidth={1}/>
            {[[11,2,11,6],[11,16,11,20],[2,11,6,11],[16,11,20,11]].map(([x1,y1,x2,y2],i)=>(
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#00e5ff" strokeWidth={1.4}/>
            ))}
          </svg>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:900,
            fontSize:18,letterSpacing:"0.06em",color:"#d4eeff"}}>CNCNEST</span>
          <span style={{fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:"#00e5ff",
            border:"1px solid #00e5ff33",padding:"1px 5px",borderRadius:2}}>PRO v2</span>
        </div>

        <div style={{flex:1}}/>

        {show && <>
          {[
            ["ЛИСТОВ",  sheets.length,                               null],
            ["ДЕТАЛЕЙ", sheets.reduce((s,sh)=>s+sh.pl.length,0),    null],
            ["КПД",     `${eff.toFixed(1)}%`,                        effColor(eff)],
            ["ШАГ",     `${(360/rotSteps).toFixed(0)}°`,            "#a78bfa"],
          ].map(([k,v,c]) => (
            <div key={k} style={{textAlign:"center",lineHeight:1.25}}>
              <div style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,
                fontSize:14,color:c||"#00e5ff"}}>{v}</div>
              <div style={{fontSize:9,letterSpacing:"0.1em",color:"#1a3a5c"}}>{k}</div>
            </div>
          ))}
          <div style={{width:1,height:22,background:"#0d2545"}}/>
        </>}

        {dirty&&res && (
          <span style={{fontSize:10,color:"#f59e0b",
            fontFamily:"'JetBrains Mono',monospace",animation:"blink 1.4s infinite"}}>
            ⚠ ИЗМЕНЕНО
          </span>
        )}

        {/* ── Export dropdown ──────────────────────────── */}
        <div ref={expRef} style={{position:"relative"}}>
          <button onClick={()=>setExpOpen(v=>!v)} disabled={!show}
            style={{
              background: show?"#00e5ff08":"none",
              border:`1px solid ${show?"#00e5ff44":"#06111f"}`,
              color: show?"#00e5ff":"#0a1e35",
              borderRadius:3,padding:"5px 13px",
              cursor:show?"pointer":"default",
              fontFamily:"'Barlow Condensed',sans-serif",
              fontWeight:700,fontSize:13,letterSpacing:"0.08em",
              display:"flex",alignItems:"center",gap:5,
            }}>
            ↓ ЭКСПОРТ
            <span style={{fontSize:9,opacity:.7}}>{expOpen?"▲":"▼"}</span>
          </button>

          {expOpen && (
            <div style={{
              position:"absolute",top:"calc(100% + 4px)",right:0,
              background:"#050e1c",border:"1px solid #0d2545",
              borderRadius:4,zIndex:200,minWidth:200,
              boxShadow:"0 8px 32px rgba(0,0,0,.6)",overflow:"hidden",
            }}>
              {[
                ["SVG","Векторная карта раскроя",  "image/svg+xml", "#10b981", downloadSVG],
                ["DXF","Файл для CAM / станка",    "application/dxf","#00e5ff", downloadDXF],
                ["TXT","Текстовый отчёт с коорд.", "text/plain",    "#a78bfa",  downloadTXT],
              ].map(([fmt, desc, , col, fn]) => (
                <button key={fmt} onClick={fn}
                  style={{
                    display:"flex",alignItems:"center",gap:10,
                    width:"100%",background:"none",
                    border:"none",borderBottom:"1px solid #0d2545",
                    padding:"9px 12px",cursor:"pointer",textAlign:"left",
                    transition:"background .1s",
                  }}
                  onMouseEnter={e=>e.currentTarget.style.background="#0d2545"}
                  onMouseLeave={e=>e.currentTarget.style.background="none"}>
                  <div style={{
                    fontFamily:"'JetBrains Mono',monospace",fontSize:11,
                    fontWeight:700,color:col,minWidth:32,
                  }}>{fmt}</div>
                  <div style={{fontSize:10,color:"#4a6fa8",lineHeight:1.3}}>{desc}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={doCalc} disabled={busy}
          style={{background:busy?"transparent":"#00e5ff0e",
            border:`1px solid ${busy?"#0d2545":"#00e5ff"}`,
            color:busy?"#1a3a5c":"#00e5ff",borderRadius:3,padding:"5px 20px",
            cursor:busy?"wait":"pointer",fontFamily:"'Barlow Condensed',sans-serif",
            fontWeight:700,fontSize:14,letterSpacing:"0.1em"}}>
          {busy ? "⏳ РАСЧЁТ…" : "▶ РАССЧИТАТЬ"}
        </button>
      </div>

      {/* ══════════ BODY ══════════ */}
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        {/* ── LEFT PANEL ── */}
        <div style={{width:256,...PBG,borderRight:"1px solid #0d2545",
          display:"flex",flexDirection:"column",overflow:"hidden",
          outline: isDraggingOver ? "2px solid #00e5ff" : "none",
          background: isDraggingOver ? "#051420" : PBG.background}}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}>

          {/* Sheet params (always visible) */}
          <div style={{padding:"10px 12px",borderBottom:"1px solid #0d2545"}}>
            <span style={CAP}>◈ ПАРАМЕТРЫ ЛИСТА</span>
            <select onChange={e=>{
                const all = [...STD_SHEETS, ...customSheets];
                const s = all.find(x=>x.n===e.target.value);
                if(s) setSheet(s.w, s.h);
              }}
              style={inp({width:"100%",marginBottom:6,cursor:"pointer"})}>
              <option value="">— Выберите формат —</option>
              {customSheets.length > 0 && (
                <optgroup label="── Мои форматы ──">
                  {customSheets.map((s,i) => (
                    <option key={`c${i}`}>{s.n}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="── Стандартные ──">
                {STD_SHEETS.map(s=><option key={s.n}>{s.n}</option>)}
              </optgroup>
            </select>
            <div style={{display:"flex",gap:5,marginBottom:5}}>
              {[["Ширина [мм]",W,v=>setSheet(+v,H)],["Высота [мм]",H,v=>setSheet(W,+v)]].map(([l,v,fn])=>(
                <div key={l} style={{flex:1}}>
                  <div style={{fontSize:9,color:"#1a3a5c",marginBottom:2}}>{l}</div>
                  <input type="number" value={v} onChange={e=>fn(e.target.value)}
                    style={inp({width:"100%"})}/>
                </div>
              ))}
              <div>
                <div style={{fontSize:9,color:"#1a3a5c",marginBottom:2}}>Рез</div>
                <input type="number" step="0.5" min="0" value={gap}
                  onChange={e=>{setGap(+e.target.value);setDirty(true);}}
                  style={inp({width:44})}/>
              </div>
            </div>
            {/* ── Add current size to library ── */}
            <div style={{display:"flex",gap:4,marginTop:4}}>
              <input placeholder="Название (необязательно)" value={customForm.n}
                onChange={e=>setCustomForm(f=>({...f,n:e.target.value}))}
                onKeyDown={e=>e.key==="Enter"&&addCustomSheet()}
                style={inp({flex:1,fontSize:9,padding:"3px 5px"})}/>
              <button onClick={addCustomSheet} title="Сохранить текущий размер в библиотеку"
                style={{background:"#10b98118",border:"1px solid #10b98155",
                  color:"#10b981",borderRadius:2,padding:"3px 8px",cursor:"pointer",
                  fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:700,
                  whiteSpace:"nowrap"}}
                onMouseEnter={()=>setCustomForm(f=>({
                  ...f, w:String(W), h:String(H),
                  n:f.n||`${W} × ${H} мм`
                }))}>
                + СОХРАНИТЬ
              </button>
            </div>
            {/* Custom sheets list */}
            {customSheets.length > 0 && (
              <div style={{marginTop:4,display:"flex",flexWrap:"wrap",gap:3}}>
                {customSheets.map((s,i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:2,
                    background:"#10b98112",border:"1px solid #10b98133",
                    borderRadius:2,padding:"2px 5px",cursor:"pointer"}}
                    onClick={()=>setSheet(s.w,s.h)}>
                    <span style={{fontSize:8,color:"#10b981",
                      fontFamily:"'JetBrains Mono',monospace"}}>{s.n}</span>
                    <button onClick={e=>{e.stopPropagation();removeCustomSheet(i);}}
                      style={{background:"none",border:"none",color:"#ef444466",
                        cursor:"pointer",fontSize:9,padding:"0 1px",lineHeight:1}}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tab bar */}
          <div style={{display:"flex",borderBottom:"1px solid #0d2545",flexShrink:0}}>
            {[["parts","ДЕТАЛИ"],["settings","НАСТРОЙКИ"]].map(([t,l])=>(
              <button key={t} onClick={()=>setTab(t)}
                style={{flex:1,background:tab===t?"#030c18":"transparent",
                  border:"none",borderBottom:`2px solid ${tab===t?"#00e5ff":"transparent"}`,
                  color:tab===t?"#00e5ff":"#1a3a5c",padding:"7px",cursor:"pointer",
                  fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                  fontSize:11,letterSpacing:"0.1em"}}>
                {l}
              </button>
            ))}
          </div>

          {/* ═══ ДЕТАЛИ TAB ═══════════════════════════════ */}
          {tab === "parts" && <>
            <div style={{flex:1,overflowY:"auto",padding:"10px 12px"}}>

              {/* Import row */}
              <div style={{display:"flex",gap:5,marginBottom:6}}>
                <button onClick={()=>fileRef.current.click()}
                  style={{flex:1,background:"#00e5ff0a",border:"1px solid #00e5ff33",
                    color:"#00e5ff",borderRadius:2,padding:"5px 6px",cursor:"pointer",
                    fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                    fontSize:12,letterSpacing:"0.06em"}}>
                  📁 ИМПОРТ DXF
                </button>
                <input ref={fileRef} type="file" accept=".dxf" multiple
                  style={{display:"none"}}
                  onChange={e=>{
                    Array.from(e.target.files).forEach(handleDXFFile);
                    e.target.value='';
                  }}/>
                <button onClick={addDemoPolygons} title="Добавить демо-формы"
                  style={{background:"#a78bfa0a",border:"1px solid #a78bfa33",
                    color:"#a78bfa",borderRadius:2,padding:"5px 7px",cursor:"pointer",
                    fontSize:13}}>⬡</button>
              </div>
              {/* Drag & drop hint */}
              <div style={{
                border:`1px dashed ${isDraggingOver?"#00e5ff":"#0d2545"}`,
                borderRadius:3, padding:"5px 8px", marginBottom:8,
                textAlign:"center", fontSize:9, color:"#1a3a5c",
                fontFamily:"'JetBrains Mono',monospace",
                background: isDraggingOver?"#00e5ff0a":"transparent",
                transition:"all .15s",
              }}>
                {isDraggingOver ? "⬇ Отпустите DXF файлы…" : "↑ или перетащите .dxf сюда"}
              </div>

              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <span style={CAP}>◈ ДЕТАЛИ [{parts.length}]</span>
                {parts.length > 0 && (
                  <button onClick={()=>{ if(window.confirm('Очистить весь список деталей?')) { setParts([]); setRes(null); setDirty(false); cancelEdit(); }}}
                    style={{background:"none",border:"1px solid #ef444433",
                      color:"#ef444488",borderRadius:2,padding:"1px 7px",
                      cursor:"pointer",fontSize:9,
                      fontFamily:"'JetBrains Mono',monospace"}}>
                    ✕ ОЧИСТИТЬ
                  </button>
                )}
              </div>

              {parts.length===0 && (
                <div style={{color:"#0d2545",textAlign:"center",marginTop:16,fontSize:11}}>
                  Список пуст
                </div>
              )}

              {parts.map((p,i) => (
                <div key={p.id} style={{
                  background:eid===p.id?"#05142a":"transparent",
                  border:`1px solid ${eid===p.id?"#00e5ff33":"#0d2545"}`,
                  borderLeft:`2px solid ${PAL[i%PAL.length]}`,
                  borderRadius:2,padding:"5px 8px",marginBottom:4,
                }}>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                        fontSize:13,color:"#b8d4ee",overflow:"hidden",
                        textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {p.source==="dxf"  && <span style={{fontSize:9,color:"#a78bfa",marginRight:3}}>DXF</span>}
                        {p.source==="demo" && <span style={{fontSize:9,color:"#f59e0b",marginRight:3}}>⬡</span>}
                        {p.name}
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:4,marginTop:2}}>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",
                          fontSize:9,color:"#1a3a5c"}}>
                          {Math.round(p.w)}×{Math.round(p.h)}мм
                          {p.rot     && <span style={{color:"#00e5ff44",marginLeft:3}}>⟳</span>}
                          {p.polygon && <span style={{color:"#a78bfa44",marginLeft:3}}>⬡</span>}
                          {(p.holes||[]).length>0 && <span style={{color:"#f59e0b44",marginLeft:3}}>⌀{p.holes.length}</span>}
                        </span>
                        {/* Inline qty editor */}
                        <div style={{display:"flex",alignItems:"center",
                          marginLeft:"auto",gap:2}}>
                          <button
                            onClick={e=>{e.stopPropagation();changeQty(p.id,-1);}}
                            style={{background:"#0d2545",border:"none",color:"#4a8ab5",
                              borderRadius:2,width:16,height:16,fontSize:11,
                              cursor:"pointer",lineHeight:"1",padding:0}}>−</button>
                          <input type="number" min="1" value={p.qty}
                            onChange={e=>setQtyDirect(p.id, e.target.value)}
                            onClick={e=>e.stopPropagation()}
                            style={{...inp({width:32,textAlign:"center",
                              padding:"1px 3px",fontSize:10})}}/>
                          <button
                            onClick={e=>{e.stopPropagation();changeQty(p.id,+1);}}
                            style={{background:"#0d2545",border:"none",color:"#4a8ab5",
                              borderRadius:2,width:16,height:16,fontSize:11,
                              cursor:"pointer",lineHeight:"1",padding:0}}>+</button>
                        </div>
                      </div>
                    </div>
                    <button onClick={()=>startEdit(p)}
                      style={{background:"none",border:"none",color:"#1e6fa8",cursor:"pointer",fontSize:12,padding:"1px 3px"}}>✏</button>
                    <button onClick={()=>delPart(p.id)}
                      style={{background:"none",border:"none",color:"#ef444455",cursor:"pointer",fontSize:12,padding:"1px 3px"}}>✕</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Add / Edit form */}
            <div style={{padding:"10px 12px",borderTop:"1px solid #0d2545",background:"#040a15"}}>
              <span style={{...CAP,color:eid!==null?"#00e5ff":"#1a3a5c"}}>
                {eid!==null ? "◈ РЕДАКТОР" : "◈ НОВАЯ ДЕТАЛЬ"}
              </span>
              <input placeholder="Название" value={form.name}
                onChange={e=>setForm(f=>({...f,name:e.target.value}))}
                onKeyDown={e=>e.key==="Enter"&&submitForm()}
                style={inp({width:"100%",marginBottom:5})}/>
              <div style={{display:"flex",gap:4,marginBottom:5}}>
                <input type="number" placeholder="Ш мм" value={form.w}
                  onChange={e=>setForm(f=>({...f,w:e.target.value}))} style={inp({flex:1})}/>
                <input type="number" placeholder="В мм" value={form.h}
                  onChange={e=>setForm(f=>({...f,h:e.target.value}))} style={inp({flex:1})}/>
                <input type="number" min="1" placeholder="×N" value={form.qty}
                  onChange={e=>setForm(f=>({...f,qty:e.target.value}))} style={inp({width:38})}/>
              </div>
              <label style={{display:"flex",alignItems:"center",gap:5,marginBottom:7,
                cursor:"pointer",fontSize:10,color:"#1e4a78",
                fontFamily:"'JetBrains Mono',monospace"}}>
                <input type="checkbox" checked={form.rot}
                  onChange={e=>setForm(f=>({...f,rot:e.target.checked}))}/>
                Разрешить поворот
              </label>
              <div style={{display:"flex",gap:5}}>
                <button onClick={submitForm}
                  style={{flex:1,background:"#00e5ff0e",border:"1px solid #00e5ff33",
                    color:"#00e5ff",borderRadius:2,padding:"5px",cursor:"pointer",
                    fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                    fontSize:13,letterSpacing:"0.06em"}}>
                  {eid!==null ? "💾 СОХРАНИТЬ" : "+ ДОБАВИТЬ"}
                </button>
                {eid!==null && (
                  <button onClick={cancelEdit}
                    style={{background:"none",border:"1px solid #0d2545",color:"#1a3a5c",
                      borderRadius:2,padding:"5px 9px",cursor:"pointer",fontSize:11}}>
                    ✕
                  </button>
                )}
              </div>
            </div>
          </>}

          {/* ═══ НАСТРОЙКИ TAB ════════════════════════════ */}
          {tab === "settings" && (
            <div style={{flex:1,overflowY:"auto",padding:"12px 14px"}}>

              {/* ── Rotation Steps ─────────────────────── */}
              <span style={CAP}>◈ ШАГИ ПОВОРОТА</span>
              <div style={{fontSize:10,color:"#2a4a68",marginBottom:10,lineHeight:1.6}}>
                Число дискретных положений при автоподборе угла детали.
                Применяется к контурам из DXF и деталям с флагом ⟳.
                Прямоугольные детали всегда используют только 0° и 90°.
              </div>

              {ROT_OPTS.map(({v,l}) => {
                const active = rotSteps === v;
                const dotCount = Math.min(v, 16);
                return (
                  <label key={v} style={{
                    display:"flex",alignItems:"center",gap:9,
                    marginBottom:4,cursor:"pointer",padding:"6px 8px",borderRadius:3,
                    background:active?"#0d2545":"transparent",
                    border:`1px solid ${active?"#00e5ff44":"transparent"}`,
                    transition:"all .1s",
                  }}>
                    <input type="radio" name="rotSteps" checked={active}
                      onChange={()=>{setRotSteps(v);setDirty(true);}}/>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,
                        color:active?"#00e5ff":"#2a5080"}}>
                        {l}
                      </div>
                      {/* Dot visualisation */}
                      <div style={{display:"flex",gap:2,marginTop:3,flexWrap:"wrap"}}>
                        {Array.from({length:dotCount},(_,i) => (
                          <div key={i} style={{
                            width:5,height:5,borderRadius:"50%",
                            background:active?"#00e5ff":"#0d2545",
                          }}/>
                        ))}
                        {v > 16 && (
                          <span style={{fontSize:8,color:"#1a3a5c",lineHeight:"6px"}}>…</span>
                        )}
                      </div>
                    </div>
                    {active && (
                      <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:8,
                        color:"#00e5ff88",whiteSpace:"nowrap"}}>
                        {(360/v).toFixed(1)}°/шаг
                      </span>
                    )}
                  </label>
                );
              })}

              <div style={DIV}/>

              {/* ── Arc Tolerance ──────────────────────── */}
              <span style={CAP}>◈ ТОЧНОСТЬ АППРОКСИМАЦИИ ДУГ</span>
              <div style={{fontSize:10,color:"#2a4a68",marginBottom:8,lineHeight:1.5}}>
                Шаг разбивки кривых при импорте DXF (мм).
                Меньше → точнее форма, медленнее загрузка.
              </div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"#1a3a5c"}}>Допуск</span>
                <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,
                  color:"#00e5ff",fontWeight:700}}>{arcTol.toFixed(1)} мм</span>
              </div>
              <input type="range" min={0.1} max={5} step={0.1} value={arcTol}
                onChange={e=>setArcTol(+e.target.value)}
                style={{width:"100%",marginBottom:3}}/>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:8,color:"#0d2545"}}>0.1 точно</span>
                <span style={{fontSize:8,color:"#0d2545"}}>5.0 грубо</span>
              </div>

              <div style={DIV}/>

              {/* ── Info ───────────────────────────────── */}
              <div style={{background:"#0d254514",border:"1px solid #0d2545",
                borderRadius:3,padding:"8px 10px"}}>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:8,
                  color:"#1e4a78",marginBottom:5,letterSpacing:"0.1em"}}>ℹ АЛГОРИТМ</div>
                <div style={{fontSize:9,color:"#1a3a5c",lineHeight:1.7}}>
                  <b style={{color:"#2a5080"}}>Guillotine BSSF</b> — Best Short Side Fit.<br/>
                  DXF: LWPOLYLINE (замкн.), CIRCLE, ELLIPSE.<br/>
                  Полигоны используют {rotSteps} шагов поворота.<br/>
                  Прямоугольники — только 0° / 90°.
                </div>
              </div>

              <div style={DIV}/>

              {/* ── Demo shapes button ─────────────────── */}
              <button onClick={()=>{setTab("parts");addDemoPolygons();}}
                style={{width:"100%",background:"#a78bfa0a",
                  border:"1px solid #a78bfa33",color:"#a78bfa",
                  borderRadius:3,padding:"6px",cursor:"pointer",
                  fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                  fontSize:12,letterSpacing:"0.06em"}}>
                ⬡ ДОБАВИТЬ ДЕМО-КОНТУРЫ
              </button>
            </div>
          )}
        </div>

        {/* ── CENTER ── */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>

          {/* Nav toolbar */}
          {show && (
            <div style={{height:34,...PBG,borderBottom:"1px solid #0d2545",
              display:"flex",alignItems:"center",padding:"0 10px",gap:8,flexShrink:0}}>
              {["◀","▶"].map((ch,i) => {
                const dis = i===0 ? cur===0 : cur>=sheets.length-1;
                return (
                  <button key={ch} disabled={dis}
                    onClick={()=>setCur(s=>i===0?Math.max(0,s-1):Math.min(sheets.length-1,s+1))}
                    style={{background:"none",
                      border:`1px solid ${dis?"#0a1e35":"#1a3a5c"}`,
                      color:dis?"#0a1e35":"#1e6fa8",borderRadius:2,
                      padding:"1px 8px",cursor:dis?"default":"pointer",
                      fontSize:11,fontFamily:"'JetBrains Mono',monospace"}}>
                    {ch}
                  </button>
                );
              })}
              <span style={{fontFamily:"'JetBrains Mono',monospace",
                fontSize:11,color:"#1e4a78",minWidth:74}}>
                [{String(cur+1).padStart(2,"0")}/{String(sheets.length).padStart(2,"0")}]
              </span>
              <div style={{width:1,height:16,background:"#0d2545"}}/>
              <span style={{fontSize:10,color:"#1a3a5c",fontFamily:"'JetBrains Mono',monospace"}}>
                n=<b style={{color:"#4a8ab5"}}>{curSh?.pl.length||0}</b>
              </span>
              <span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",
                color:effColor(curEff),fontWeight:700}}>
                EFF={curEff.toFixed(1)}%
              </span>
              <div style={{flex:1}}/>
              <label style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",
                fontSize:10,color:"#1a3a5c",fontFamily:"'JetBrains Mono',monospace"}}>
                <input type="checkbox" checked={labels} onChange={e=>setLabels(e.target.checked)}/>
                LBL
              </label>
              <div style={{width:1,height:16,background:"#0d2545"}}/>
              <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,
                color:"#00e5ff88",minWidth:42}}>
                {(zoom*100).toFixed(0)}%
              </span>
              <button onClick={resetView}
                style={{background:"none",border:"1px solid #0d2545",color:"#1e6fa8",
                  borderRadius:2,padding:"1px 7px",cursor:"pointer",fontSize:10,
                  fontFamily:"'JetBrains Mono',monospace"}}>
                ⟲ RESET
              </button>
            </div>
          )}

          {/* Canvas viewport — zoom with wheel, pan with drag */}
          <div ref={canvasRef}
            style={{flex:1, overflow:"hidden", background:"#020a14",
              cursor:"grab", position:"relative", userSelect:"none"}}
            onWheel={onCanvasWheel}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onMouseLeave={onCanvasMouseUp}>

            {/* ── BUSY overlay ── */}
            {busy && (
              <div style={{position:"absolute",inset:0,zIndex:20,
                display:"flex",alignItems:"center",justifyContent:"center",
                background:"#020a14",pointerEvents:"none"}}>
                <div style={{textAlign:"center"}}>
                  <div style={{width:160,height:90,border:"1px solid #0d2545",
                    position:"relative",overflow:"hidden",
                    margin:"0 auto 14px",background:"#030c18"}}>
                    {Array.from({length:9},(_,i)=>(
                      <div key={i} style={{position:"absolute",left:0,right:0,
                        top:`${i*11}%`,height:1,background:"#0d2545"}}/>
                    ))}
                    <div style={{position:"absolute",left:0,right:0,height:2,
                      background:"linear-gradient(90deg,transparent,#00e5ff,transparent)",
                      animation:"scan 1.1s linear infinite"}}/>
                  </div>
                  <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,
                    color:"#00e5ff",animation:"blink 1.1s infinite"}}>
                    OPTIMIZING · {rotSteps} STEPS · {parts.reduce((s,p)=>s+p.qty,0)} PARTS…
                  </div>
                </div>
              </div>
            )}

            {/* ── DIRTY overlay — button must receive clicks → NO pointerEvents:none ── */}
            {!busy && dirty && res && (
              <div style={{position:"absolute",inset:0,zIndex:20,
                display:"flex",alignItems:"center",justifyContent:"center",
                background:"#020a1aee"}}>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:28,marginBottom:10,color:"#f59e0b",
                    animation:"blink 1.5s infinite"}}>⚠</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                    fontSize:18,color:"#f59e0b",letterSpacing:"0.06em",marginBottom:14}}>
                    ПАРАМЕТРЫ ИЗМЕНЕНЫ
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); doCalc(); }}
                    style={{background:"#f59e0b0e",border:"1px solid #f59e0b",
                      color:"#f59e0b",borderRadius:3,padding:"10px 32px",cursor:"pointer",
                      fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                      fontSize:17,letterSpacing:"0.08em"}}>
                    ▶ ПЕРЕСЧИТАТЬ
                  </button>
                </div>
              </div>
            )}

            {/* ── EMPTY overlay ── */}
            {!busy && !res && (
              <div style={{position:"absolute",inset:0,zIndex:20,
                display:"flex",alignItems:"center",justifyContent:"center",
                pointerEvents:"none"}}>
                <div style={{textAlign:"center",pointerEvents:"auto"}}>
                  <div style={{width:76,height:76,border:"1px solid #0d2545",
                    margin:"0 auto 14px",display:"flex",alignItems:"center",
                    justifyContent:"center"}}>
                    <svg width={44} height={44} viewBox="0 0 44 44" fill="none">
                      <rect x={4} y={4} width={36} height={36} stroke="#0d2545" strokeWidth={1.5}/>
                      <rect x={8}  y={11} width={11} height={15} stroke="#1a3a5c" strokeWidth={1}/>
                      <rect x={25} y={11} width={11} height={7}  stroke="#1a3a5c" strokeWidth={1}/>
                      <rect x={25} y={22} width={11} height={10} stroke="#1a3a5c" strokeWidth={1}/>
                      <rect x={8}  y={29} width={11} height={6}  stroke="#1a3a5c" strokeWidth={1}/>
                      <polygon points="8,11 19,11 19,21" stroke="#1a3a5c" strokeWidth={0.5} fill="none" strokeDasharray="2 2"/>
                    </svg>
                  </div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,
                    fontSize:17,color:"#0d2545",letterSpacing:"0.06em",marginBottom:4}}>
                    ДОБАВЬТЕ ДЕТАЛИ
                  </div>
                  <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"#0a1e35"}}>
                    DXF IMPORT · {rotSteps} ROT.STEPS · GUILLOTINE BSSF
                  </div>
                  <button onClick={()=>{setTab("parts");addDemoPolygons();}}
                    style={{marginTop:12,background:"transparent",
                      border:"1px solid #a78bfa44",color:"#a78bfa88",
                      borderRadius:2,padding:"4px 14px",cursor:"pointer",
                      fontSize:11,fontFamily:"'Barlow Condensed',sans-serif",
                      fontWeight:600}}>
                    ⬡ Демо-контуры
                  </button>
                </div>
              </div>
            )}

            {/* ── Zoom hint ── */}
            {show && (
              <div style={{position:"absolute",bottom:8,right:12,zIndex:10,
                fontFamily:"'JetBrains Mono',monospace",fontSize:8,
                color:"#0d2545",pointerEvents:"none"}}>
                🖱 колесо — зум · перетащить — пан
              </div>
            )}

            {/* ── Transform layer — ONLY SheetSVG, no pointer events needed ── */}
            <div style={{
              position:"absolute", top:0, left:0, width:"100%", height:"100%",
              transform:`translate(${panX}px,${panY}px) scale(${zoom})`,
              transformOrigin:"0 0", pointerEvents:"none",
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>
              {show && curSh && (
                <SheetSVG data={curSh} W={W} H={H} sc={sc} labels={labels}/>
              )}
            </div>
          </div>{/* /canvas viewport */}
        </div>

        {/* ── RIGHT PANEL ── */}
        <div style={{width:188,...PBG,borderLeft:"1px solid #0d2545",
          padding:"10px 12px",overflowY:"auto",flexShrink:0}}>
          {show ? (
            <>
              <span style={CAP}>◈ СТАТИСТИКА</span>

              {/* Donut gauge */}
              <div style={{textAlign:"center",marginBottom:12}}>
                <svg width={80} height={80} style={{display:"block",margin:"0 auto"}}>
                  <circle cx={40} cy={40} r={30} fill="none" stroke="#0d2545" strokeWidth={9}/>
                  <circle cx={40} cy={40} r={30} fill="none"
                    stroke={effColor(eff)} strokeWidth={9}
                    strokeDasharray={`${188.5*eff/100} 188.5`}
                    strokeLinecap="round" transform="rotate(-90 40 40)"
                    style={{transition:"stroke-dasharray .6s ease"}}/>
                  <text x={40} y={40} textAnchor="middle" dominantBaseline="middle"
                    fill={effColor(eff)} fontSize={13} fontWeight={700}
                    fontFamily="'JetBrains Mono',monospace">
                    {Math.round(eff)}%
                  </text>
                </svg>
                <div style={{fontSize:9,letterSpacing:"0.12em",color:"#1a3a5c",marginTop:3}}>КПД</div>
              </div>

              {[
                ["ЛИСТОВ",   sheets.length],
                ["ДЕТАЛЕЙ",  sheets.reduce((s,sh)=>s+sh.pl.length,0)],
                ["S_ЛИСТА",  `${(shA/1e6).toFixed(3)} м²`],
                ["S_ДЕТ",    `${(totA/1e6).toFixed(3)} м²`],
                ["ОТХОДЫ",   `${((sheets.length*shA-totA)/1e6).toFixed(3)} м²`],
              ].map(([k,v]) => (
                <div key={k} style={{display:"flex",justifyContent:"space-between",
                  alignItems:"baseline",marginBottom:5}}>
                  <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:8,
                    letterSpacing:"0.06em",color:"#1a3a5c"}}>{k}</span>
                  <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,
                    color:"#7fa8cc",fontWeight:700}}>{v}</span>
                </div>
              ))}

              <div style={DIV}/>
              <span style={CAP}>◈ ЛИСТЫ</span>

              {sheets.map((sh, i) => {
                const e = sh.pl.reduce((s,p)=>s+p.pw*p.ph,0)/shA*100;
                const active = i === cur;
                return (
                  <div key={i} style={{marginBottom:7,cursor:"pointer"}}
                    onClick={() => setCur(i)}>
                    <div style={{display:"flex",justifyContent:"space-between",
                      alignItems:"center",marginBottom:2}}>
                      <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,
                        fontWeight:active?700:400,
                        color:active?"#00e5ff":"#1e4a78"}}>
                        {active?"▶ ":"  "}{String(i+1).padStart(2,"0")}
                        <span style={{fontSize:8,opacity:.45,marginLeft:3}}>×{sh.pl.length}</span>
                      </span>
                      <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,
                        fontWeight:700,color:effColor(e)}}>
                        {e.toFixed(0)}%
                      </span>
                    </div>
                    <div style={{height:3,background:"#0d2545",borderRadius:1}}>
                      <div style={{height:"100%",borderRadius:1,
                        width:`${Math.min(100,e)}%`,background:effColor(e),
                        transition:"width .4s ease"}}/>
                    </div>
                  </div>
                );
              })}

              {res.skipped?.length > 0 && <>
                <div style={DIV}/>
                <div style={{border:"1px solid #92400e55",borderRadius:2,
                  padding:"6px 8px",background:"#1a080066"}}>
                  <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:8,
                    letterSpacing:"0.1em",color:"#f59e0b",marginBottom:4}}>
                    ⚠ НЕ ВХОДЯТ:
                  </div>
                  {res.skipped.map((p,j) => (
                    <div key={j} style={{fontFamily:"'JetBrains Mono',monospace",
                      fontSize:8,color:"#ef4444",marginBottom:1}}>
                      {p.name} {Math.round(p.w)}×{Math.round(p.h)}
                    </div>
                  ))}
                </div>
              </>}
            </>
          ) : (
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,
              color:"#0d2545",textAlign:"center",marginTop:32,lineHeight:2}}>
              ОЖИДАНИЕ<br/>РАСЧЁТА…
            </div>
          )}
        </div>

      </div>{/* /body */}
    </div>
  );
}
