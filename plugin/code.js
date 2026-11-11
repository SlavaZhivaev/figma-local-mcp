figma.showUI(__html__, {width:380, height:370, themeColors:true});
const MAX_OPS = 500;
function place(parent,n,index) {
  if (typeof index !== 'number' || !isFinite(index)) { parent.appendChild(n); return; }
  let i = Math.max(0, Math.min(Math.trunc(index), parent.children.length));
  // Figma resolves the index against a list that still contains the node, so moving a child
  // forward inside the same parent lands it one slot early. Compensate, so index always means
  // the position the node ends up at. A fresh clone counts too: clone() drops the copy in
  // right after its source.
  const at = parent.children.indexOf(n);
  if (at !== -1 && i > at) i = Math.min(i + 1, parent.children.length);
  parent.insertChild(i, n);
}
const words = s => new Set(s.split(/\s+/).filter(Boolean));
// Plain assignments. Text-only ones among them (textCase…) run after fonts are loaded.
const SIMPLE = words(`name opacity visible blendMode clipsContent
  cornerRadius topLeftRadius topRightRadius bottomLeftRadius bottomRightRadius cornerSmoothing
  itemSpacing counterAxisSpacing paddingTop paddingRight paddingBottom paddingLeft
  primaryAxisAlignItems counterAxisAlignItems counterAxisAlignContent itemReverseZIndex strokesIncludedInLayout
  strokeWeight strokeTopWeight strokeRightWeight strokeBottomWeight strokeLeftWeight strokeAlign strokeCap strokeJoin dashPattern
  textAlignHorizontal textAlignVertical textCase textDecoration paragraphSpacing paragraphIndent textWrapStyle
  gridRowCount gridColumnCount gridRowGap gridColumnGap gridRowSizes gridColumnSizes
  gridRowAnchorIndex gridColumnAnchorIndex gridRowSpan gridColumnSpan gridChildHorizontalAlign gridChildVerticalAlign`);
const TEXT_ONLY = words('characters fontFamily fontStyle fontSize lineHeight letterSpacing textAutoResize ranges');
const LAYOUT = words('layoutMode layoutWrap primaryAxisSizingMode counterAxisSizingMode layoutPositioning layoutAlign layoutGrow layoutSizingHorizontal layoutSizingVertical');
const KNOWN = new Set([...SIMPLE, ...TEXT_ONLY, ...LAYOUT, ...words('x y rotation width height fill fills stroke strokes effects fillStyleId strokeStyleId effectStyleId textStyleId gridStyleId componentProperties bind link')]);
const RANGE_KEYS = words('start end text fontFamily fontStyle fontSize fill fills textDecoration textCase letterSpacing lineHeight');

// Any page of the file: with dynamic page loading a page that was never opened must be loaded first.
function pageNode(n) { let p=n; while (p && p.type !== 'PAGE') p=p.parent; return p; }
async function node(id, refs) {
  const n = refs[id] || await figma.getNodeByIdAsync(id);
  if (!n || n.removed) throw Error('Node not found: '+id);
  const pg=n.type === 'PAGE' ? n : pageNode(n);
  if (n.type === 'DOCUMENT' || !pg) throw Error('Not a layer: '+id);
  if (pg !== figma.currentPage) await pg.loadAsync();
  return n;
}
async function findPage(ref) {
  if (!ref) return null;
  const s=String(ref).trim(), low=s.toLowerCase();
  const pg=figma.root.children.find(p=>p.id === s) || figma.root.children.find(p=>p.name === s) || figma.root.children.find(p=>p.name.toLowerCase().indexOf(low) !== -1);
  if (!pg) throw Error('Page not found: '+s+' (pages: '+figma.root.children.map(p=>p.name).join(', ')+')');
  if (pg !== figma.currentPage) await pg.loadAsync();
  return pg;
}
async function showNode(n) {
  const pg=n.type === 'PAGE' ? n : pageNode(n);
  if (pg && pg !== figma.currentPage) await figma.setCurrentPageAsync(pg);
  if (n.type !== 'PAGE') { figma.currentPage.selection=[n]; figma.viewport.scrollAndZoomIntoView([n]); }
}
// Exports, CSS and image bytes need Figma's renderer, which stalls while the app is minimized or in
// the background. Fail with a clear message instead of holding the bridge for minutes.
function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, rej)=>{ timer=setTimeout(()=>rej(Error((what || 'Figma')+' не ответила за '+Math.round(ms/1000)+' с. Разверните окно Figma и не сворачивайте её, пока идёт команда.')), ms); })])
    .finally(()=>clearTimeout(timer));
}
const fontCache=new Map();
// loadFontAsync never settles for a font Figma cannot provide, which would wedge the
// handler forever. Cap it, and cache successful loads so big batches stay fast.
function loadFont(font) {
  const key=font.family+'\u0000'+font.style;
  if (!fontCache.has(key)) {
    const guarded=Promise.race([
      figma.loadFontAsync(font),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('Font unavailable: '+font.family+' '+font.style)),8000))
    ]).catch(e=>{fontCache.delete(key);throw e;});
    fontCache.set(key,guarded);
  }
  return fontCache.get(key);
}
// Every font already used in the node must be loaded before Figma lets us touch its text.
async function loadTextFonts(n) {
  let fonts;
  if (n.fontName !== figma.mixed) fonts=[n.fontName];
  else if (typeof n.getRangeAllFontNames === 'function') fonts=n.getRangeAllFontNames(0, n.characters.length);
  else fonts=n.getStyledTextSegments(['fontName']).map(s=>s.fontName);
  for (const f of fonts) await loadFont(f);
}

// --- value parsers -------------------------------------------------------------------------
function color(s, what) {
  if (typeof s === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) {
    const h=i=>parseInt(s.slice(i,i+2),16)/255;
    return {r:h(1), g:h(3), b:h(5), a:s.length===9 ? h(7) : 1};
  }
  // rgb(), hsl(), lab(), oklch() strings or {space:'OKLCH', l, c, h}: Figma converts and remembers the source.
  if (s && (typeof s === 'string' || typeof s === 'object') && figma.util && figma.util.rgba) {
    try { const c=figma.util.rgba(s); return {r:c.r, g:c.g, b:c.b, a:c.a, src:s}; } catch (e) {}
  }
  throw Error(what+' must be #RRGGBB, #RRGGBBAA, a CSS colour (rgb, hsl, lab, oklch) or {space, …}');
}
function solid(c, opacity, visible) {
  if (c.src && figma.util.solidPaint) { try { return figma.util.solidPaint(c.src, {opacity:opacity*c.a, visible}); } catch (e) {} }
  return {type:'SOLID', color:{r:c.r,g:c.g,b:c.b}, opacity:opacity*c.a, visible};
}
// CSS angle (0 = to top, 90 = to right, default 180 = to bottom) → Figma gradientTransform,
// which maps the layer's normalized box onto gradient space where the axis runs (0,.5)→(1,.5).
function linearTransform(angle, W, H) {
  W=W||1; H=H||1;
  const a=angle*Math.PI/180, dx=Math.sin(a), dy=-Math.cos(a), len=Math.abs(W*dx)+Math.abs(H*dy);
  const sx=(W/2-dx*len/2)/W, sy=(H/2-dy*len/2)/H, ex=(W/2+dx*len/2)/W, ey=(H/2+dy*len/2)/H;
  const vx=ex-sx, vy=ey-sy, L=vx*vx+vy*vy;
  return [[vx/L, vy/L, -(vx*sx+vy*sy)/L], [-vy/L, vx/L, (vy*sx-vx*sy)/L+0.5]];
}
function paint(v, n, what) {
  if (typeof v === 'string') return solid(color(v,what), 1, true);
  if (!v || typeof v !== 'object') throw Error(what+' must be a color string, a paint object or null');
  const type=v.type || 'SOLID', opacity=v.opacity === undefined ? 1 : v.opacity, visible=v.visible !== false;
  if (type === 'SOLID') return solid(color(v.color,what), opacity, visible);
  if (/^GRADIENT_(LINEAR|RADIAL|ANGULAR|DIAMOND)$/.test(type)) {
    if (!Array.isArray(v.stops) || v.stops.length < 2) throw Error(what+': gradient needs at least 2 stops');
    const gradientStops=v.stops.map((s,i)=>{
      const c=color(s.color, what+' stop');
      return {position: typeof s.position === 'number' ? s.position : i/(v.stops.length-1), color:{r:c.r,g:c.g,b:c.b,a:c.a}};
    });
    const gradientTransform=v.gradientTransform ||
      (type === 'GRADIENT_LINEAR' ? linearTransform(v.angle === undefined ? 180 : v.angle, n.width, n.height) : [[1,0,0],[0,1,0]]);
    return {type, gradientStops, gradientTransform, opacity, visible};
  }
  if (type === 'IMAGE') {
    // Server turns {path} into base64; a hash re-uses an image already in the file.
    const imageHash=v.imageHash || (typeof v.data === 'string' ? figma.createImage(figma.base64Decode(v.data.replace(/^data:[^,]*,/,''))).hash : null);
    if (!imageHash) throw Error(what+': IMAGE needs path, data or imageHash');
    const out={type, imageHash, scaleMode:v.scaleMode || 'FILL', opacity, visible};
    if (v.rotation) out.rotation=v.rotation;
    if (v.scalingFactor) out.scalingFactor=v.scalingFactor;
    return out;
  }
  if (type === 'SHADER') {
    if (typeof v.id !== 'string') throw Error(what+': SHADER needs id (see figma.listAvailableShaders())');
    return {type, id:v.id, properties:v.properties || {}, opacity, visible};
  }
  throw Error(what+': unsupported paint type '+type);
}
// Shaders have to be materialised in the file before a paint or effect can point at them.
async function importShaders(values) {
  if (typeof figma.importShaderById !== 'function') return;
  const ids=new Set();
  for (const v of values) for (const x of (Array.isArray(v) ? v : [v])) if (x && typeof x === 'object' && x.type === 'SHADER' && x.id) ids.add(x.id);
  for (const id of ids) await figma.importShaderById(id);
}
const paints=(v,n,what)=>v === null ? [] : (Array.isArray(v) ? v : [v]).map(x=>paint(x,n,what));
function effects(v) {
  if (v === null) return [];
  if (!Array.isArray(v)) throw Error('effects must be an array or null');
  return v.map(e=>{
    if (!e || typeof e !== 'object') throw Error('effect must be an object');
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const c=color(e.color || '#000000', 'effect color');
      const out={type:e.type, color:{r:c.r,g:c.g,b:c.b,a:c.a*(e.opacity === undefined ? 1 : e.opacity)},
        offset:{x:e.x || 0, y:e.y || 0}, radius:e.blur || 0, spread:e.spread || 0, visible:e.visible !== false, blendMode:'NORMAL'};
      if (e.type === 'DROP_SHADOW' && e.showShadowBehindNode !== undefined) out.showShadowBehindNode=!!e.showShadowBehindNode;
      return out;
    }
    if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR')
      return {type:e.type, radius:e.radius || 0, visible:e.visible !== false, blurType:'NORMAL'};
    if (e.type === 'SHADER') {
      if (typeof e.id !== 'string') throw Error('SHADER effect needs id');
      return {type:'SHADER', id:e.id, properties:e.properties || {}, visible:e.visible !== false};
    }
    if (e.type === 'NOISE' || e.type === 'TEXTURE' || e.type === 'GLASS') return Object.assign({visible:true}, e);
    throw Error('Unsupported effect type: '+e.type);
  });
}
function setEffects(n, list) {
  try { n.effects=list; }
  catch (e) {
    // Older Figma builds predate progressive blur and reject the blurType field.
    if (!list.some(x=>'blurType' in x)) throw e;
    n.effects=list.map(x=>{ const c=Object.assign({},x); delete c.blurType; return c; });
  }
}
function unitValue(v, what, bare) {
  if (typeof v === 'number') return {unit:bare, value:v};
  if (typeof v === 'string') {
    const m=/^(-?\d+(?:\.\d+)?)\s*(px|%)$/i.exec(v.trim());
    if (m) return {unit:m[2] === '%' ? 'PERCENT' : 'PIXELS', value:parseFloat(m[1])};
  }
  if (v && typeof v === 'object' && (v.unit === 'PIXELS' || v.unit === 'PERCENT') && typeof v.value === 'number') return {unit:v.unit, value:v.value};
  throw Error(what+' must be a number, "12px", "120%" or {unit:"PIXELS"|"PERCENT", value}');
}
function lineHeight(v) {
  if (v === 'AUTO' || (v && v.unit === 'AUTO')) return {unit:'AUTO'};
  return unitValue(v, 'lineHeight', 'PIXELS');
}
const letterSpacing=v=>unitValue(v, 'letterSpacing', 'PERCENT');

// --- applying props ------------------------------------------------------------------------
async function applyRanges(n, ranges) {
  if (!Array.isArray(ranges)) throw Error('ranges must be an array');
  const chars=n.characters;
  for (const r of ranges) {
    for (const k of Object.keys(r)) if (!RANGE_KEYS.has(k)) throw Error('Unsupported range property: '+k);
    let spans;
    if (typeof r.text === 'string' && r.text) {
      // Every occurrence: counting characters by hand is the usual source of off-by-one ranges.
      spans=[];
      for (let i=chars.indexOf(r.text); i !== -1; i=chars.indexOf(r.text, i+r.text.length)) spans.push([i, i+r.text.length]);
      if (!spans.length) throw Error('Range text not found: '+r.text);
    } else {
      if (!(Number.isInteger(r.start) && Number.isInteger(r.end) && 0 <= r.start && r.start < r.end && r.end <= chars.length))
        throw Error('Range '+r.start+'–'+r.end+' is outside the text (length '+chars.length+')');
      spans=[[r.start, r.end]];
    }
    for (const [s,e] of spans) {
      if ('fontFamily' in r || 'fontStyle' in r) {
        const cur=n.getRangeFontName(s, s+1), f={family:r.fontFamily || cur.family, style:r.fontStyle || cur.style};
        await loadFont(f); n.setRangeFontName(s, e, f);
      }
      if ('fontSize' in r) n.setRangeFontSize(s, e, r.fontSize);
      if ('fills' in r || 'fill' in r) n.setRangeFills(s, e, paints('fills' in r ? r.fills : r.fill, n, 'fill'));
      if ('textDecoration' in r) n.setRangeTextDecoration(s, e, r.textDecoration);
      if ('textCase' in r) n.setRangeTextCase(s, e, r.textCase);
      if ('letterSpacing' in r) n.setRangeLetterSpacing(s, e, letterSpacing(r.letterSpacing));
      if ('lineHeight' in r) n.setRangeLineHeight(s, e, lineHeight(r.lineHeight));
    }
  }
}
// bind: {"fill": "VariableID:1:2", "itemSpacing": "VariableID:1:3", ...}
async function bindVariables(n, bind) {
  if (!bind || typeof bind !== 'object') throw Error('bind must be an object: {field: variableId}');
  for (const field of Object.keys(bind)) {
    const v=bind[field] === null ? null : await figma.variables.getVariableByIdAsync(bind[field]);
    if (bind[field] !== null && !v) throw Error('Variable not found: '+bind[field]);
    if (field === 'fill' || field === 'stroke') {
      const key=field === 'fill' ? 'fills' : 'strokes';
      const list=n[key].length ? n[key].slice() : [{type:'SOLID', color:{r:0,g:0,b:0}}];
      list[0]=figma.variables.setBoundVariableForPaint(list[0], 'color', v);
      n[key]=list;
    } else n.setBoundVariable(field, v);
  }
}
// The node is already in its parent. Order matters, Figma silently resets things otherwise:
// layoutMode → text (font → characters → styles) → plain props → resize → textAutoResize →
// axis sizing modes (resize forces FIXED) → child sizing → paints/effects → ranges → position.
async function props(n,p) {
  const keys=Object.keys(p);
  for (const k of keys) if (!KNOWN.has(k)) throw Error('Unsupported property: '+k);
  const has=k=>Object.prototype.hasOwnProperty.call(p,k);
  const set=(k,v)=>{ if (!(k in n)) throw Error('Property '+k+' is not supported by '+n.type); n[k]=v; };
  if (n.type !== 'TEXT') for (const k of keys) if (TEXT_ONLY.has(k)) throw Error('Property '+k+' is not supported by '+n.type);

  if (has('layoutMode')) set('layoutMode', p.layoutMode);
  if (has('layoutWrap')) set('layoutWrap', p.layoutWrap);

  if (n.type === 'TEXT' && keys.length) {
    await loadTextFonts(n);
    if (has('fontFamily') || has('fontStyle')) {
      const cur=n.fontName !== figma.mixed ? n.fontName : n.getRangeFontName(0,1);
      const font={family:p.fontFamily || cur.family, style:p.fontStyle || cur.style};
      await loadFont(font); n.fontName=font;
    }
    if (has('characters')) n.characters=String(p.characters);
    if (has('fontSize')) n.fontSize=p.fontSize;
    if (has('lineHeight')) n.lineHeight=lineHeight(p.lineHeight);
    if (has('letterSpacing')) n.letterSpacing=letterSpacing(p.letterSpacing);
  }
  for (const k of keys) if (SIMPLE.has(k)) set(k, p[k]);

  if (has('width') || has('height')) {
    const w=has('width') ? p.width : n.width, h=has('height') ? p.height : n.height;
    if (n.type === 'TEXT') {
      // A fixed width usually means "wrap inside this column", so keep the height hugging
      // the text unless a height or an explicit mode was given.
      const prev=n.textAutoResize;
      n.resize(w, h);
      n.textAutoResize=has('textAutoResize') ? p.textAutoResize : has('height') ? 'NONE' : prev === 'NONE' ? 'NONE' : 'HEIGHT';
    } else if (n.type === 'SECTION') n.resizeWithoutConstraints(w, h);
    else if ('resize' in n) n.resize(w, h);
    else throw Error(n.type+' cannot be resized');
  } else if (has('textAutoResize')) n.textAutoResize=p.textAutoResize;

  for (const k of ['primaryAxisSizingMode','counterAxisSizingMode','layoutPositioning','layoutAlign','layoutGrow','layoutSizingHorizontal','layoutSizingVertical'])
    if (has(k)) set(k, p[k]);

  await importShaders([p.fills, p.fill, p.strokes, p.stroke, p.effects].filter(v=>v !== undefined && v !== null));
  if (has('fills') || has('fill')) set('fills', paints(has('fills') ? p.fills : p.fill, n, 'fill'));
  if (has('strokes') || has('stroke')) set('strokes', paints(has('strokes') ? p.strokes : p.stroke, n, 'stroke'));
  if (has('effects')) { if (!('effects' in n)) throw Error('Property effects is not supported by '+n.type); setEffects(n, effects(p.effects)); }
  for (const k of ['fillStyleId','strokeStyleId','effectStyleId','textStyleId','gridStyleId']) if (has(k)) {
    const setter='set'+k[0].toUpperCase()+k.slice(1)+'Async';
    if (typeof n[setter] === 'function') await n[setter](p[k]); else set(k, p[k]);
  }
  if (has('componentProperties')) {
    if (n.type !== 'INSTANCE') throw Error('componentProperties works only on an INSTANCE');
    n.setProperties(p.componentProperties);
  }
  if (has('bind')) await bindVariables(n, p.bind);
  if (has('link')) n.setSharedPluginData(CL_NS, 'href', p.link ? String(p.link) : '');   // prototype link: page file name or URL
  // Last among styles: a whole-node fill would otherwise paint over the range colours.
  if (has('ranges')) await applyRanges(n, p.ranges);

  for (const k of ['rotation','x','y']) if (has(k)) set(k, p[k]);
}

// --- reading ---------------------------------------------------------------------------------
const r2=v=>typeof v === 'number' ? Math.round(v*100)/100 : v;
const mix=v=>v === figma.mixed ? 'MIXED' : v;
function hex(c, a) {
  const t=x=>Math.round(x*255).toString(16).padStart(2,'0').toUpperCase();
  return '#'+t(c.r)+t(c.g)+t(c.b)+(a !== undefined && a < 0.998 ? t(a) : '');
}
// Same shapes figma_apply accepts, so a read value can be sent straight back.
function paintOut(p) {
  if (p.type === 'SOLID') {
    const h=hex(p.color, p.opacity === undefined ? 1 : p.opacity), src=p.color && p.color.sourceColor;
    return src && src.space !== 'SRGB' ? {type:'SOLID', color:h, sourceColor:src} : h;
  }
  if (p.type.indexOf('GRADIENT_') === 0) {
    const g={type:p.type, stops:p.gradientStops.map(s=>({color:hex(s.color, s.color.a), position:r2(s.position)})),
      gradientTransform:p.gradientTransform.map(row=>row.map(x=>Math.round(x*1e4)/1e4))};
    if (p.opacity !== undefined && p.opacity < 1) g.opacity=r2(p.opacity);
    return g;
  }
  if (p.type === 'IMAGE') return {type:'IMAGE', imageHash:p.imageHash, scaleMode:p.scaleMode};
  if (p.type === 'SHADER') return {type:'SHADER', id:p.id, properties:p.properties};
  return p.type;
}
function paintsOut(v) {
  if (v === figma.mixed) return 'MIXED';
  const out=v.filter(p=>p.visible !== false).map(paintOut);
  return out.length ? out : undefined;
}
function effectOut(e) {
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
    return {type:e.type, color:hex(e.color, e.color.a), x:r2(e.offset.x), y:r2(e.offset.y), blur:r2(e.radius), spread:r2(e.spread || 0)};
  if (e.type === 'SHADER') return {type:'SHADER', id:e.id, properties:e.properties};
  if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') return {type:e.type, radius:r2(e.radius)};
  return {type:e.type};
}
const unitOut=v=>v === figma.mixed ? 'MIXED' : v.unit === 'AUTO' ? 'AUTO' : {unit:v.unit, value:r2(v.value)};
function styleOut(n, out) {
  if ('visible' in n && !n.visible) out.visible=false;
  if ('opacity' in n && n.opacity < 1) out.opacity=r2(n.opacity);
  if ('fills' in n) { const f=paintsOut(n.fills); if (f) out.fills=f; }
  if ('strokes' in n && n.strokes.length) {
    const s=paintsOut(n.strokes);
    if (s) { out.strokes=s; out.strokeWeight=mix(n.strokeWeight); out.strokeAlign=n.strokeAlign; }
  }
  if ('effects' in n) { const e=n.effects.filter(x=>x.visible !== false).map(effectOut); if (e.length) out.effects=e; }
  if ('cornerRadius' in n) {
    if (n.cornerRadius === figma.mixed) for (const k of ['topLeftRadius','topRightRadius','bottomRightRadius','bottomLeftRadius']) out[k]=n[k];
    else if (n.cornerRadius) out.cornerRadius=r2(n.cornerRadius);
  }
  if (n.type === 'TEXT') {
    out.fontFamily=n.fontName === figma.mixed ? 'MIXED' : n.fontName.family;
    out.fontStyle=n.fontName === figma.mixed ? 'MIXED' : n.fontName.style;
    out.fontSize=mix(n.fontSize);
    out.lineHeight=unitOut(n.lineHeight);
    const ls=unitOut(n.letterSpacing); if (ls === 'MIXED' || ls.value) out.letterSpacing=ls;
    out.textAutoResize=n.textAutoResize;
    if (n.textAlignHorizontal !== 'LEFT') out.textAlignHorizontal=n.textAlignHorizontal;
    if (n.textCase !== 'ORIGINAL') out.textCase=mix(n.textCase);
    if (n.textDecoration !== 'NONE') out.textDecoration=mix(n.textDecoration);
    if ('textWrapStyle' in n && n.textWrapStyle && n.textWrapStyle !== 'AUTO') out.textWrapStyle=mix(n.textWrapStyle);
  }
  if ('layoutMode' in n && n.layoutMode === 'GRID') {
    for (const k of ['gridRowCount','gridColumnCount','gridRowGap','gridColumnGap','gridRowSizes','gridColumnSizes']) if (k in n) out[k]=n[k];
  }
  if (n.parent && n.parent.layoutMode === 'GRID') {
    for (const k of ['gridRowAnchorIndex','gridColumnAnchorIndex','gridRowSpan','gridColumnSpan','gridChildHorizontalAlign','gridChildVerticalAlign']) if (k in n) out[k]=n[k];
  }
  if ('animations' in n) { try { if (n.animations && n.animations.length) out.animations=n.animations.length; } catch (e) {} }
  if ('layoutMode' in n && n.layoutMode !== 'NONE' && n.layoutMode !== 'GRID') {
    for (const k of ['itemSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','primaryAxisSizingMode','counterAxisSizingMode','primaryAxisAlignItems','counterAxisAlignItems']) out[k]=r2(n[k]);
    if (n.layoutWrap === 'WRAP') { out.layoutWrap='WRAP'; out.counterAxisSpacing=r2(n.counterAxisSpacing); }
  }
  if (n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE') {
    if (n.layoutPositioning === 'ABSOLUTE') out.layoutPositioning='ABSOLUTE';
    else { out.layoutSizingHorizontal=n.layoutSizingHorizontal; out.layoutSizingVertical=n.layoutSizingVertical; }
  }
}
function readTree(roots, maxDepth, maxNodes) {
  // Big pages blow the budget on the first deep branch, so depth 0-1 gives a usable overview.
  const D = Math.max(0, Math.min(Math.trunc(maxDepth === undefined ? 4 : maxDepth), 4));
  const N = Math.max(1, Math.min(Math.trunc(maxNodes === undefined ? 200 : maxNodes), 200));
  let count=0;
  function read(n,depth) {
    if (++count>N) return null;
    const out={id:n.id,name:n.name,type:n.type};
    for (const k of ['x','y','width','height','characters','layoutMode']) if(k in n) out[k]=typeof n[k] === 'string' ? n[k].slice(0,1000) : r2(n[k]);
    if (n.type !== 'PAGE') styleOut(n, out);
    if ('children' in n) {
      out.childCount=n.children.length;
      if(depth<D) { out.children=[]; for(const c of n.children) { if(count>=N)break; const child=read(c,depth+1); if(child)out.children.push(child); } }
    }
    return out;
  }
  const result=[]; for(const n of roots) {if(count>=N)break; const top=read(n,0); if(top)result.push(top);}
  const pg=roots.length ? (roots[0].type === 'PAGE' ? roots[0] : pageNode(roots[0])) : figma.currentPage;
  return {page:{id:pg.id,name:pg.name},nodes:result,depth:D,limit:N,truncated:count>N};
}
// IDs of a fresh copy's children, in tree order, so nobody has to guess offsets.
function descendants(n, out) {
  out=out || [];
  if ('children' in n) for (const c of n.children) {
    if (out.length >= 300) break;
    out.push({id:c.id, name:c.name, type:c.type});
    descendants(c, out);
  }
  return out;
}
async function screenshot(args) {
  const sel=figma.currentPage.selection;
  const n=args.nodeId ? await node(args.nodeId,{}) : sel.length === 1 ? sel[0] : null;
  if (!n) throw Error('Pass nodeId or select exactly one layer');
  if (n.type === 'PAGE' || !('exportAsync' in n)) throw Error(n.type+' cannot be exported');
  const side=Math.max(n.width, n.height) || 1;
  const maxSide=Math.max(64, Math.min(Number(args.maxSide) || 2048, 4096));
  let scale=Math.max(0.05, Math.min(Number(args.scale) || 1, 4));
  if (side*scale > maxSide) scale=maxSide/side;
  let format='PNG', bytes=await withTimeout(n.exportAsync({format, constraint:{type:'SCALE', value:scale}}), 30000, 'Экспорт');
  // Keep the image under the model's per-image size limit.
  if (bytes.length > 3.5*1024*1024) { format='JPG'; bytes=await withTimeout(n.exportAsync({format, constraint:{type:'SCALE', value:scale}}), 30000, 'Экспорт'); }
  return {nodeId:n.id, name:n.name, scale:r2(scale), width:Math.round(n.width*scale), height:Math.round(n.height*scale),
    mimeType:format === 'PNG' ? 'image/png' : 'image/jpeg', data:figma.base64Encode(bytes)};
}

// --- design to code ---------------------------------------------------------------------------
async function cssTree(args) {
  const sel=figma.currentPage.selection;
  const roots=args.nodeId ? [await node(args.nodeId,{})] : sel.length ? sel : null;
  if (!roots) throw Error('Pass nodeId or select a layer');
  const D=Math.max(0, Math.min(Math.trunc(args.depth === undefined ? 2 : args.depth), 4));
  const N=Math.max(1, Math.min(Math.trunc(args.limit || 150), 300));
  let count=0;
  async function walk(n, depth) {
    if (++count > N) return null;
    const out={id:n.id, name:n.name, type:n.type, width:r2(n.width), height:r2(n.height)};
    if (n.type === 'TEXT') out.characters=n.characters.slice(0,2000);
    if (typeof n.getCSSAsync === 'function') { try { out.css=await withTimeout(n.getCSSAsync(), 15000, 'CSS слоя'); } catch (e) { out.cssError=String(e.message||e); } }
    if ('children' in n && depth < D) {
      out.children=[];
      for (const c of n.children) { if (count >= N) break; const x=await walk(c, depth+1); if (x) out.children.push(x); }
    } else if ('children' in n) out.childCount=n.children.length;
    return out;
  }
  const nodes=[]; for (const r of roots) { if (count >= N) break; const x=await walk(r,0); if (x) nodes.push(x); }
  return {nodes, truncated:count > N};
}

// --- export -----------------------------------------------------------------------------------
async function exportNode(args) {
  const n=await node(args.nodeId,{});
  if (!('exportAsync' in n)) throw Error(n.type+' cannot be exported');
  const format=String(args.format || 'PNG').toUpperCase();
  const settings={format};
  if (format === 'PNG' || format === 'JPG') settings.constraint={type:'SCALE', value:Math.max(0.05, Math.min(Number(args.scale) || 2, 4))};
  if (format === 'SVG') settings.svgOutlineText=!!args.svgOutlineText;
  const bytes=await withTimeout(n.exportAsync(settings), 30000, 'Экспорт');
  return {nodeId:n.id, name:n.name, format, data:figma.base64Encode(bytes)};
}

// --- pages ------------------------------------------------------------------------------------
async function pages(args) {
  if (args.create) { const pg=figma.createPage(); pg.name=String(args.create); await figma.setCurrentPageAsync(pg); }
  if (args.switchTo) await figma.setCurrentPageAsync(await findPage(args.switchTo));
  if (args.focus) await showNode(await node(args.focus, {}));
  const out={current:{id:figma.currentPage.id, name:figma.currentPage.name}, pages:[]};
  for (const pg of figma.root.children) {
    const e={id:pg.id, name:pg.name};
    try { await pg.loadAsync(); e.frames=pg.children.length; e.top=pg.children.slice(0, 12).map(n=>({id:n.id, name:n.name, type:n.type})); } catch (err) {}
    out.pages.push(e);
  }
  // Search the whole file: layer names and text, page by page.
  if (args.find) {
    const q=String(args.find).toLowerCase(), N=Math.max(1, Math.min(Math.trunc(args.limit || 50), 300)), found=[];
    for (const pg of figma.root.children) {
      if (found.length >= N) break;
      await pg.loadAsync();
      const hits=pg.findAll(n=>n.name.toLowerCase().indexOf(q) !== -1 || (n.type === 'TEXT' && n.characters.toLowerCase().indexOf(q) !== -1));
      for (const n of hits) {
        if (found.length >= N) break;
        const top=(()=>{ let t=n; while (t.parent && t.parent.type !== 'PAGE') t=t.parent; return t; })();
        found.push({id:n.id, name:n.name, type:n.type, page:pg.name, pageId:pg.id, inside:top !== n ? top.name : undefined, text:n.type === 'TEXT' ? n.characters.slice(0, 120) : undefined});
      }
    }
    out.found=found; out.query=args.find;
  }
  return out;
}

// --- what the file already has: variables, styles, components, shaders ---------------------------
function valueOut(v) {
  if (v && typeof v === 'object' && 'r' in v && 'g' in v && 'b' in v) return hex(v, v.a === undefined ? 1 : v.a);
  if (v && typeof v === 'object' && v.type === 'VARIABLE_ALIAS') return {alias:v.id};
  return v;
}
async function library(args) {
  const want=new Set(args.include && args.include.length ? args.include : ['variables','styles','components']);
  const q=args.query ? String(args.query).toLowerCase() : null;
  const hit=name=>!q || String(name).toLowerCase().indexOf(q) !== -1;
  const N=Math.max(1, Math.min(Math.trunc(args.limit || 300), 2000));
  const out={};
  if (want.has('variables') && figma.variables) {
    const cols=await figma.variables.getLocalVariableCollectionsAsync();
    out.collections=[];
    for (const c of cols) {
      const col={id:c.id, name:c.name, modes:c.modes.map(m=>({id:m.modeId, name:m.name})), variables:[]};
      for (const id of c.variableIds) {
        if (col.variables.length >= N) break;
        const v=await figma.variables.getVariableByIdAsync(id);
        if (!v || !hit(v.name)) continue;
        const values={};
        for (const m of c.modes) values[m.name]=valueOut(v.valuesByMode[m.modeId]);
        col.variables.push({id:v.id, name:v.name, type:v.resolvedType, scopes:v.scopes, values});
      }
      out.collections.push(col);
    }
  }
  if (want.has('styles')) {
    const pick=list=>list.filter(s=>hit(s.name)).slice(0,N);
    out.paintStyles=pick(await figma.getLocalPaintStylesAsync()).map(s=>({id:s.id, name:s.name, paints:paintsOut(s.paints)}));
    out.textStyles=pick(await figma.getLocalTextStylesAsync()).map(s=>({id:s.id, name:s.name, fontFamily:s.fontName.family, fontStyle:s.fontName.style, fontSize:s.fontSize, lineHeight:unitOut(s.lineHeight)}));
    out.effectStyles=pick(await figma.getLocalEffectStylesAsync()).map(s=>({id:s.id, name:s.name, effects:s.effects.map(effectOut)}));
  }
  if (want.has('components')) {
    await figma.loadAllPagesAsync();
    const found=figma.root.findAllWithCriteria({types:['COMPONENT','COMPONENT_SET']});
    out.components=[];
    for (const c of found) {
      if (out.components.length >= N) break;
      if (c.type === 'COMPONENT' && c.parent && c.parent.type === 'COMPONENT_SET') continue;
      if (!hit(c.name)) continue;
      const item={id:c.id, key:c.key, name:c.name, type:c.type, page:pageOf(c)};
      try { if (c.componentPropertyDefinitions) item.properties=c.componentPropertyDefinitions; } catch (e) {}
      if (c.type === 'COMPONENT_SET') item.variants=c.children.slice(0,100).map(v=>({id:v.id, name:v.name}));
      out.components.push(item);
    }
  }
  if (want.has('shaders') && typeof figma.listAvailableShaders === 'function') {
    try { out.shaders=JSON.parse(JSON.stringify(await figma.listAvailableShaders())); } catch (e) { out.shadersError=String(e.message||e); }
  }
  if (want.has('animations') && figma.motion && typeof figma.motion.figmaAnimationStyles === 'function') {
    try { out.animationStyles=JSON.parse(JSON.stringify(await figma.motion.figmaAnimationStyles())); } catch (e) { out.animationsError=String(e.message||e); }
  }
  return out;
}
function pageOf(n) { let p=n; while (p && p.type !== 'PAGE') p=p.parent; return p ? p.name : null; }

// --- HTML to layers (layout comes from the plugin window, see ui.html) -------------------------
let fontIndex=null;
async function fontsIndex() {
  if (!fontIndex) {
    fontIndex=new Map();
    for (const f of await figma.listAvailableFontsAsync()) {
      const k=f.fontName.family.toLowerCase();
      if (!fontIndex.has(k)) fontIndex.set(k, {family:f.fontName.family, styles:[]});
      fontIndex.get(k).styles.push(f.fontName.style);
    }
  }
  return fontIndex;
}
const WEIGHTS=[[100,/thin|hairline/],[200,/extra ?light|ultra ?light/],[300,/light/],[600,/semi ?bold|demi ?bold/],[800,/extra ?bold|ultra ?bold/],[900,/black|heavy/],[500,/medium/],[700,/bold/]];
function styleWeight(s) { s=s.toLowerCase(); for (const [w,re] of WEIGHTS) if (re.test(s)) return w; return 400; }
const GENERIC={'sans-serif':'inter','system-ui':'inter','-apple-system':'inter','blinkmacsystemfont':'inter','ui-sans-serif':'inter','helvetica':'inter','arial':'inter',
  'serif':'georgia','monospace':'roboto mono','ui-monospace':'roboto mono','menlo':'roboto mono','consolas':'roboto mono'};
function pickFont(css, weight, italic, idx, warns) {
  const fams=String(css || '').split(',').map(x=>x.trim().replace(/^["']|["']$/g,'')).filter(Boolean);
  let fam=null;
  for (const f of fams) { fam=idx.get(f.toLowerCase()) || (GENERIC[f.toLowerCase()] && idx.get(GENERIC[f.toLowerCase()])); if (fam) break; }
  if (!fam) { fam=idx.get('inter') || idx.values().next().value; warns.add('Шрифт «'+(fams[0]||'?')+'» не установлен — заменён на '+fam.family); }
  let best=fam.styles[0], score=1e9;
  for (const s of fam.styles) {
    const sc=Math.abs(styleWeight(s)-weight) + ((/italic|oblique/i.test(s)) !== italic ? 1000 : 0);
    if (sc < score) { score=sc; best=s; }
  }
  return {family:fam.family, style:best};
}
const CASE={uppercase:'UPPER', lowercase:'LOWER', capitalize:'TITLE'};
const ALIGN={left:'LEFT', start:'LEFT', center:'CENTER', right:'RIGHT', end:'RIGHT', justify:'JUSTIFIED'};
function dataImageHash(url) {
  const m=/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(url || '');
  return m ? figma.createImage(figma.base64Decode(m[2])).hash : null;
}
function svgFromDataUrl(url) {
  const m=/^data:image\/svg\+xml(;base64)?,(.*)$/i.exec(url || '');
  if (!m) return null;
  if (m[1]) { const b=figma.base64Decode(m[2]); let s=''; for (let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); try { return decodeURIComponent(escape(s)); } catch (e) { return s; } }
  return decodeURIComponent(m[2]);
}
function radii(n, r) {
  if (!r) return;
  if (r.every(x=>x === r[0])) n.cornerRadius=r[0];
  else { n.topLeftRadius=r[0]; n.topRightRadius=r[1]; n.bottomRightRadius=r[2]; n.bottomLeftRadius=r[3]; }
}
async function buildHtml(a) {
  const t=a.tree; if (!t || !Array.isArray(t.nodes)) throw Error('No layout received from the plugin window');
  const warns=new Set(t.warnings || []), idx=await fontsIndex();
  const parent=a.parentId ? await node(a.parentId,{}) : figma.currentPage;
  if (!('appendChild' in parent)) throw Error('Invalid parent');
  const root=figma.createFrame(); parent.appendChild(root);
  root.name=a.name || t.title || 'HTML'; root.resize(Math.max(1,t.w), Math.max(1,t.h));
  root.fills=t.bg ? paints(t.bg, root, 'fill') : []; root.clipsContent=true;
  if (typeof a.x === 'number' || typeof a.y === 'number') { root.x=a.x || 0; root.y=a.y || 0; }
  else if (!a.parentId) { root.x=Math.round(figma.viewport.center.x - t.w/2); root.y=Math.round(figma.viewport.center.y - t.h/2); }
  let made=1;
  async function make(d, into, ox, oy) {
    const X=d.x-ox, Y=d.y-oy;
    if (d.k === 'frame') {
      const f=figma.createFrame(); into.appendChild(f);
      f.name=d.name; f.resize(Math.max(0.01,d.w), Math.max(0.01,d.h)); f.x=X; f.y=Y;
      const v=d.v || {}, fills=[];
      if (v.fill) fills.push(paint(v.fill, f, 'fill'));
      for (const g of v.gradients || []) { try { fills.push(paint(g, f, 'fill')); } catch (e) { warns.add('Градиент пропущен: '+e.message); } }
      if (v.image) { try { const h=dataImageHash(v.image); if (h) fills.push({type:'IMAGE', imageHash:h, scaleMode:/contain/.test(v.imageSize||'') ? 'FIT' : 'FILL'}); } catch (e) { warns.add('Фоновая картинка пропущена'); } }
      f.fills=fills;
      if (v.stroke) {
        f.strokes=[paint(v.stroke, f, 'stroke')]; f.strokeAlign='INSIDE';
        const w=v.strokeWeights;
        if (w.every(x=>x === w[0])) f.strokeWeight=w[0];
        else { f.strokeTopWeight=w[0]; f.strokeRightWeight=w[1]; f.strokeBottomWeight=w[2]; f.strokeLeftWeight=w[3]; }
        if (v.dash) f.dashPattern=v.dash;
      }
      radii(f, v.radii);
      if (v.effects && v.effects.length) setEffects(f, effects(v.effects));
      if (v.opacity !== undefined) f.opacity=v.opacity;
      f.clipsContent=!!v.clip;
      if (d.href) f.setSharedPluginData(CL_NS, 'href', d.href);
      if (d.input) f.setSharedPluginData(CL_NS, 'input', JSON.stringify(d.input));
      return f;
    }
    if (d.k === 'text') {
      const s=d.style, n=figma.createText(); into.appendChild(n);
      const font=pickFont(s.family, s.weight, s.italic, idx, warns);
      await loadFont(font); n.fontName=font;
      n.characters=d.chars;
      n.fontSize=Math.max(1, s.size);
      n.lineHeight=s.lh ? {unit:'PIXELS', value:s.lh} : {unit:'AUTO'};
      if (s.ls) n.letterSpacing={unit:'PIXELS', value:s.ls};
      n.fills=[paint(s.color, n, 'fill')];
      if (CASE[s.tt]) n.textCase=CASE[s.tt];
      if (s.deco && s.deco !== 'NONE') n.textDecoration=s.deco;
      n.textAlignHorizontal=ALIGN[s.align] || 'LEFT';
      for (const r of d.ranges || []) {
        if (r.e <= r.s || r.e > d.chars.length) continue;
        if (r.family !== undefined || r.weight !== undefined || r.italic !== undefined) {
          const f2=pickFont(r.family || s.family, r.weight || s.weight, r.italic === undefined ? s.italic : r.italic, idx, warns);
          await loadFont(f2); n.setRangeFontName(r.s, r.e, f2);
        }
        if (r.size) n.setRangeFontSize(r.s, r.e, r.size);
        if (r.color) n.setRangeFills(r.s, r.e, [paint(r.color, n, 'fill')]);
        if (r.deco) n.setRangeTextDecoration(r.s, r.e, r.deco);
      }
      if (d.multi) { n.resize(Math.max(1,d.w), Math.max(1,d.h)); n.textAutoResize='HEIGHT'; }
      else n.textAutoResize='WIDTH_AND_HEIGHT';
      n.name=d.chars.slice(0,40).replace(/\s+/g,' ');
      n.x=X; n.y=Y;
      if (a.track) n.setSharedPluginData(CL_NS, 't', d.chars);
      if (d.href) n.setSharedPluginData(CL_NS, 'href', d.href);   // code layer preview: lets edits flow back into the source
      return n;
    }
    if (d.k === 'svg') {
      try { const n=figma.createNodeFromSvg(d.svg); into.appendChild(n); n.name=d.name; n.x=X; n.y=Y; if (d.href) n.setSharedPluginData(CL_NS, 'href', d.href); return n; }
      catch (e) { warns.add('SVG не разобрался — вместо него прямоугольник'); }
    }
    // Images, and SVG that failed to parse.
    const svg=d.src ? svgFromDataUrl(d.src) : null;
    if (svg) { try { const n=figma.createNodeFromSvg(svg); into.appendChild(n); n.resize(Math.max(0.01,d.w), Math.max(0.01,d.h)); n.name=d.name; n.x=X; n.y=Y; return n; } catch (e) {} }
    const r=figma.createRectangle(); into.appendChild(r);
    r.name=d.name || 'Картинка'; r.resize(Math.max(0.01,d.w), Math.max(0.01,d.h)); r.x=X; r.y=Y;
    let hash=null; try { hash=dataImageHash(d.src); } catch (e) {}
    if (hash) r.fills=[{type:'IMAGE', imageHash:hash, scaleMode:d.fit === 'contain' ? 'FIT' : 'FILL'}];
    else { r.fills=[{type:'SOLID', color:{r:0.894,g:0.925,b:0.992}}]; if (d.k === 'image') warns.add('Картинки по внешним ссылкам заменены заглушками'); }
    radii(r, d.radii);
    if (d.href) r.setSharedPluginData(CL_NS, 'href', d.href);
    return r;
  }
  async function add(list, into, ox, oy) {
    for (const d of list) {
      let n=null;
      try { n=await make(d, into, ox, oy); } catch (e) { warns.add('Элемент '+(d.name||d.k)+' пропущен: '+(e.message||e)); }
      if (!n) continue;
      made++;
      if (d.children && d.children.length) await add(d.children, n, d.x, d.y);
    }
  }
  try { await add(t.nodes, root, 0, 0); } finally { figma.commitUndo(); }
  if (!a.keepView && pageNode(root) === figma.currentPage) { figma.currentPage.selection=[root]; figma.viewport.scrollAndZoomIntoView([root]); }
  return {id:root.id, name:root.name, width:r2(root.width), height:r2(root.height), nodes:made, warnings:[...warns]};
}

// --- code layers ------------------------------------------------------------------------------
// Figma's own Code Layers are not reachable from the Plugin API, so a local code layer is a frame
// that carries its source code in shared plugin data (chunked: one entry holds at most 100 kB)
// and shows an editable preview built by the HTML importer. The plugin window runs it live.
const CL_NS='figma_local', CL_CHUNK=30000;   // 30k chars stays under 100 kB even for 3-byte UTF-8
function codeMeta(n) { try { const s=n.getSharedPluginData(CL_NS,'codeLayer'); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function readCode(n) {
  const k=parseInt(n.getSharedPluginData(CL_NS,'chunks') || '0', 10); let s='';
  for (let i=0; i<k; i++) s+=n.getSharedPluginData(CL_NS,'code.'+i);
  return s;
}
function writeCode(n, code, meta) {
  const old=parseInt(n.getSharedPluginData(CL_NS,'chunks') || '0', 10), parts=[];
  for (let i=0; i<code.length; i+=CL_CHUNK) parts.push(code.slice(i, i+CL_CHUNK));
  if (parts.length > 800) throw Error('Код больше 24 млн символов — слишком большой для слоя');
  parts.forEach((p,i)=>n.setSharedPluginData(CL_NS, 'code.'+i, p));
  for (let i=parts.length; i<old; i++) n.setSharedPluginData(CL_NS, 'code.'+i, '');
  n.setSharedPluginData(CL_NS, 'chunks', String(parts.length));
  n.setSharedPluginData(CL_NS, 'codeLayer', JSON.stringify(meta));
}
// The selection is often a layer inside the preview: walk up to the code layer.
function codeLayerOf(n) { for (let p=n; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT'; p=p.parent) if (codeMeta(p)) return p; return null; }
async function findCodeLayer(id) {
  const start=id ? await node(id,{}) : figma.currentPage.selection[0];
  const c=start ? codeLayerOf(start) : null;
  if (!c) throw Error(id ? 'Not a code layer: '+id : 'Select a code layer or pass id');
  return c;
}
// --- canvas controls: ⤢ and ▶ above every code layer, like Figma's own Code Layers -----------------
// They are separate top-level nodes next to the layer, so one click selects them; selecting one is
// the "press". ▶ plays the prototype in place (the plugin window laid over the screen at the
// current zoom), ⤢ opens the big player.
const PLAY_SVG='<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="6" fill="#0D99FF"/><path d="M11 8.5v11l9-5.5z" fill="#fff"/></svg>';
const EXPAND_SVG='<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="6" fill="#FFFFFF" fill-opacity="0.01"/><path d="M16 7h5v5M21 7l-6 6M12 21H7v-5M7 21l6-6" stroke="#0D99FF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function headerIds(box) { try { return JSON.parse(box.getSharedPluginData(CL_NS, 'header') || '[]'); } catch (e) { return []; } }
async function alignHeader(box) {
  const ids=headerIds(box); if (!ids.length) return;
  const [play, expand]=await Promise.all(ids.map(id=>figma.getNodeByIdAsync(id)));
  if (play && !play.removed && play.parent === box.parent) { play.x=box.x+box.width-28; play.y=box.y-38; }
  if (expand && !expand.removed && expand.parent === box.parent) { expand.x=box.x+box.width-62; expand.y=box.y-38; }
}
async function ensureHeader(box) {
  const ids=headerIds(box);
  const nodes=await Promise.all(ids.map(id=>figma.getNodeByIdAsync(id)));
  if (nodes.length === 2 && nodes.every(n=>n && !n.removed && n.parent === box.parent)) { await alignHeader(box); return; }
  for (const n of nodes) if (n && !n.removed) n.remove();
  const parent=box.parent, at=parent.children.indexOf(box)+1;
  const mk=(svg, name, action)=>{ const n=figma.createNodeFromSvg(svg); parent.insertChild(at, n); n.name=name; n.setSharedPluginData(CL_NS, 'clAction', action); n.setSharedPluginData(CL_NS, 'clTarget', box.id); return n; };
  const play=mk(PLAY_SVG, '▶ Запустить на месте', 'play'), expand=mk(EXPAND_SVG, '⤢ Открыть большим окном', 'expand');
  box.setSharedPluginData(CL_NS, 'header', JSON.stringify([play.id, expand.id]));
  await alignHeader(box);
}
// Follow the layer when it moves or changes size.
function onNodeChange(ev) {
  for (const ch of ev.nodeChanges) {
    if (ch.type !== 'PROPERTY_CHANGE' || !ch.node || ch.node.removed) continue;
    if (!ch.properties.some(p=>p === 'x' || p === 'y' || p === 'width' || p === 'height' || p === 'relativeTransform')) continue;
    if (codeMeta(ch.node)) alignHeader(ch.node).catch(()=>{});
  }
}
let watchedPage=null;
function watchPage() { try { if (watchedPage !== figma.currentPage) { figma.currentPage.on('nodechange', onNodeChange); watchedPage=figma.currentPage; } } catch (e) {} }
watchPage();
figma.on('currentpagechange', watchPage);
// Selecting ▶ / ⤢ presses it.
async function canvasAction(sel) {
  const action=sel.getSharedPluginData(CL_NS, 'clAction'); if (!action) return false;
  const box=await figma.getNodeByIdAsync(sel.getSharedPluginData(CL_NS, 'clTarget'));
  if (!box || box.removed || !codeMeta(box)) { figma.notify('Слой кода для этой кнопки не найден'); return true; }
  figma.currentPage.selection=[box];
  try { await runCodeLayer(box.id, {restart:true, inPlace:action === 'play'}); } catch (e) { figma.notify(String(e.message||e), {error:true}); }
  return true;
}
// The plugin window shows a "Run" bar while a code layer is selected.
function notifySelection() {
  try {
    const s0=figma.currentPage.selection[0];
    if (s0 && figma.currentPage.selection.length === 1 && s0.getSharedPluginData(CL_NS, 'clAction')) { canvasAction(s0); return; }
    const sel=s0, c=sel ? codeLayerOf(sel) : null;
    let link=null;
    if (c && sel !== c && sel.parent !== c) {
      const pp=packParts(readCode(c));
      const pages=pp ? Object.keys(pp.pages) : screensOf(c).map(f=>f.getSharedPluginData(CL_NS, 'page')).filter(Boolean);
      link={id:sel.id, name:sel.name, href:sel.getSharedPluginData(CL_NS, 'href'), pages};
    }
    figma.ui.postMessage({type:'codeSel', layer:c ? {id:c.id, name:(codeMeta(c) || {}).name || c.name} : null, link});
  } catch (e) {}
}
figma.on('selectionchange', notifySelection);
figma.on('currentpagechange', notifySelection);
// Hands the source to the plugin window, which runs it in a sandboxed frame (scripts only: no access
// to this window, the pairing key or the document) - the local counterpart of playing a Code Layer.
// Prototype rebuilt from the screens on the canvas: every visual edit, new block and link counts.
async function buildFromDesign(box) {
  const screens=screensOf(box); if (!screens.length) return null;
  const pp=packParts(readCode(box)), pages={};
  let entry=null;
  for (const f of screens) {
    const name=f.getSharedPluginData(CL_NS, 'page') || (pp ? pp.entry : 'index.html');
    const ctx=await designContext({nodeId:f.id, screenshot:false, inline:true, links:true, limit:2000});
    pages[name]=ctx.html; if (!entry) entry=name;
  }
  if (pp && pages[pp.entry] !== undefined) entry=pp.entry;
  if (!pp || Object.keys(pages).length < 2) return pages[entry];
  const pack='<script id="__figma_pages" type="application/json" data-entry="'+entry+'">'+JSON.stringify(pages).replace(/</g,'\\u003c')+'</script>'+pp.router;
  const h=pages[entry], at=h.search(/<\/body>(?![\s\S]*<\/body>)/i);
  return at < 0 ? h+pack : h.slice(0, at)+pack+h.slice(at);
}
const runnerWaits=new Map(); let runnerSeq=0;
async function runCodeLayer(id, opts) {
  opts=opts || {};
  let sync=null, mode='code', built=null;
  const box0=await findCodeLayer(id);
  if (opts.restart || !opts.keep) {
    // Untouched: run the source. Only texts changed: carry them into the source. Anything else
    // (moved, recoloured, added blocks): run a prototype rebuilt from the screens.
    const kind=opts.mode === 'code' ? 'none' : opts.mode === 'design' ? 'design' : changesIn(box0);
    if (kind === 'design') { built=await buildFromDesign(box0); if (built) mode='design'; }
    else if (kind === 'text') { try { sync=await syncCodeLayer(box0.id); } catch (e) { sync={error:String(e.message||e)}; } }
  }
  const c=box0, m=codeMeta(c), token=++runnerSeq;
  try { await ensureHeader(c); } catch (e) {}
  figma.ui.show();
  const done=new Promise(res=>{ runnerWaits.set(token, res); setTimeout(()=>{ if(runnerWaits.delete(token)) res(null); }, opts.extract ? 45000 : 9000); });
  // In place: lay the window over the entry screen at the current zoom.
  let inPlace=null;
  if (opts.inPlace) {
    if (pageNode(c) !== figma.currentPage) { await figma.setCurrentPageAsync(pageNode(c)); figma.viewport.scrollAndZoomIntoView([c]); }
    const scr=screensOf(c), pp2=packParts(readCode(c));
    const target=scr.find(f=>pp2 && f.getSharedPluginData(CL_NS, 'page') === pp2.entry) || scr[0] || c;
    const z=figma.viewport.zoom, tr=target.absoluteTransform, head=37;
    inPlace={w:Math.max(200, Math.round(target.width*z)), h:Math.max(150, Math.round(target.height*z)), scale:z};
    try { figma.ui.reposition(tr[0][2], tr[1][2]-head/z); } catch (e) {}
  }
  figma.ui.postMessage({type:'runCode', token, id:c.id, name:m.name, mode, inPlace, code:built || readCode(c), w:m.viewport.w, h:m.viewport.h,
    keep:!opts.restart, page:opts.page || null, click:opts.click || null, fill:opts.fill || null, extract:!!opts.extract});
  const r=await done;
  let extracted;
  if (opts.extract) {
    if (r && r.tree) { try { extracted=await extractState({id:c.id, tree:r.tree, page:r.page, label:opts.label}); } catch (e) { extracted={error:String(e.message||e)}; } }
    else extracted={error:(r && r.extractError) || 'окно плагина не ответило — выведите Figma на экран и повторите'};
  }
  return {id:c.id, name:m.name, running:true, source:mode === 'design' ? 'макет (собран из слоёв)' : 'код', page:r && r.page, pages:(r && r.pages) || m.pages || null, result:r && r.result, synced:sync && sync.synced ? sync : undefined, extracted};
}
// --- what the user changed since the preview was drawn -----------------------------------------
// Two fingerprints per screen: layout (everything but text content) and full (with text). Text
// boxes that hug their content change size with the text, so their size is left out of layout.
function fingerprint(root, withText) {
  let s='';
  const num=v=>v === figma.mixed ? 'm' : Math.round(v*10)/10;
  const paint=list=>list === figma.mixed ? 'm' : JSON.stringify(list.filter(p=>p.visible !== false).map(p=>p.type === 'SOLID' ? [num(p.color.r),num(p.color.g),num(p.color.b),num(p.opacity === undefined ? 1 : p.opacity)] : p.type === 'IMAGE' ? p.imageHash : p.type));
  (function walk(n) {
    s+=n.type+'|'+num(n.x)+','+num(n.y);
    if (n.type !== 'TEXT' || n.textAutoResize === 'NONE') s+=','+num(n.width)+','+num(n.height);
    if ('visible' in n && !n.visible) s+='|h';
    if ('opacity' in n) s+='|o'+num(n.opacity);
    if ('fills' in n) s+='|f'+paint(n.fills);
    if ('strokes' in n && n.strokes.length) s+='|s'+paint(n.strokes)+num(n.strokeWeight);
    if ('cornerRadius' in n) s+='|r'+num(n.cornerRadius);
    if ('effects' in n && n.effects.length) s+='|e'+n.effects.length;
    if (n.type === 'TEXT') { s+='|t'+num(n.fontSize)+(n.fontName === figma.mixed ? 'm' : n.fontName.family+n.fontName.style); if (withText) s+='|'+n.characters; }
    const href=n.getSharedPluginData(CL_NS, 'href'); if (href) s+='|a'+href;
    if ('children' in n) { s+='['; for (const c of n.children) walk(c); s+=']'; }
    s+=';';
  })(root);
  let h=5381; for (let i=0; i<s.length; i++) h=((h<<5)+h+s.charCodeAt(i))|0;
  return h+':'+s.length;
}
function stampScreen(frame) {
  frame.setSharedPluginData(CL_NS, 'sigL', fingerprint(frame, false));
  frame.setSharedPluginData(CL_NS, 'sigT', fingerprint(frame, true));
}
function screensOf(box) { return box.children.filter(f=>f.getSharedPluginData(CL_NS, 'sigL')); }
// none | text | design
function changesIn(box) {
  let kind='none';
  for (const f of screensOf(box)) {
    if (fingerprint(f, false) !== f.getSharedPluginData(CL_NS, 'sigL')) return 'design';
    if (fingerprint(f, true) !== f.getSharedPluginData(CL_NS, 'sigT')) kind='text';
  }
  return kind;
}
// Every packed page as its own editable screen, side by side inside the code layer.
async function buildPages(box, trees) {
  const warns=new Set(); let x=0, h=1;
  box.fills=[]; box.clipsContent=false;
  for (const p of trees) {
    const built=await buildHtml({tree:p.tree, parentId:box.id, x, y:0, name:p.page, track:true});
    const frame=await figma.getNodeByIdAsync(built.id);
    frame.setSharedPluginData(CL_NS, 'page', p.page);
    stampScreen(frame);
    for (const w of built.warnings) warns.add(w);
    x+=built.width+80; h=Math.max(h, built.height);
  }
  box.resize(Math.max(1, x-80), h);
  return [...warns];
}
// --- edits in the preview flow back into the source ------------------------------------------------
function packParts(code) {
  const m=/<script id="__figma_pages" type="application\/json" data-entry="([^"]*)">([\s\S]*?)<\/script>(<script id="__figma_router">[\s\S]*?<\/script>)/.exec(code);
  if (!m) return null;
  return {start:m.index, end:m.index+m[0].length, entry:m[1], pages:JSON.parse(m[2]), router:m[3]};
}
const escHtml=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function replaceText(html, from, to) {
  for (const [f, r] of [[from, to], [escHtml(from), escHtml(to)], [from.replace(/\u00a0/g,'&nbsp;'), to.replace(/\u00a0/g,'&nbsp;')]]) {
    let i=html.indexOf('>'+f);
    if (i !== -1) return html.slice(0, i+1)+r+html.slice(i+1+f.length);
    i=html.indexOf(f);
    if (i !== -1 && f.length > 2) return html.slice(0, i)+r+html.slice(i+f.length);
  }
  // Text split by inline tags (<b>…</b>): replace only the part that changed, if it is unique.
  let p=0; while (p < from.length && p < to.length && from[p] === to[p]) p++;
  let s=0; while (s < from.length-p && s < to.length-p && from[from.length-1-s] === to[to.length-1-s]) s++;
  const cf=from.slice(p, from.length-s), ct=to.slice(p, to.length-s);
  if (cf.length >= 3) {
    for (const [f, r] of [[cf, ct], [escHtml(cf), escHtml(ct)]]) {
      const i=html.indexOf(f);
      if (i !== -1 && html.indexOf(f, i+1) === -1) return html.slice(0, i)+r+html.slice(i+f.length);
    }
  }
  return null;
}
async function syncCodeLayer(id) {
  const box=await findCodeLayer(id), pp0=packParts(readCode(box));
  let code=readCode(box); const pp=pp0;
  const changes=[], missed=[];
  for (const pf of box.children) {
    const page=pf.getSharedPluginData(CL_NS, 'page') || (pp ? pp.entry : null);
    const texts='findAllWithCriteria' in pf ? pf.findAllWithCriteria({types:['TEXT']}) : [];
    for (const tn of texts) {
      const orig=tn.getSharedPluginData(CL_NS, 't');
      if (orig && orig !== tn.characters) changes.push({page, node:tn, from:orig, to:tn.characters});
    }
  }
  if (!changes.length) return {id:box.id, synced:0, missed:[]};
  let entryHtml=pp ? code.slice(0, pp.start)+code.slice(pp.end) : code;
  let synced=0;
  for (const c of changes) {
    const isEntry=!pp || c.page === pp.entry;
    const target=isEntry ? entryHtml : pp.pages[c.page];
    const out=target === undefined ? null : replaceText(target, c.from, c.to);
    if (out === null) { missed.push((c.page ? c.page+': ' : '')+c.from.slice(0,60)); continue; }
    if (isEntry) { entryHtml=out; if (pp) pp.pages[pp.entry]=out; } else pp.pages[c.page]=out;
    c.node.setSharedPluginData(CL_NS, 't', c.to); synced++;
  }
  if (pp) {
    const pack='<script id="__figma_pages" type="application/json" data-entry="'+pp.entry+'">'+JSON.stringify(pp.pages).replace(/</g,'\\u003c')+'</script>'+pp.router;
    const at=entryHtml.search(/<\/body>(?![\s\S]*<\/body>)/i);
    code=at < 0 ? entryHtml+pack : entryHtml.slice(0, at)+pack+entryHtml.slice(at);
  } else code=entryHtml;
  if (synced) {
    for (const f of screensOf(box)) if (fingerprint(f, false) === f.getSharedPluginData(CL_NS, 'sigL')) stampScreen(f);
    const meta=codeMeta(box); meta.version=(meta.version || 0)+1; meta.updated=new Date().toISOString();
    writeCode(box, code, meta); figma.commitUndo();
  }
  return {id:box.id, synced, missed, version:codeMeta(box).version};
}
async function codeLayer(a) {
  if (typeof a.html !== 'string' || !a.html) throw Error('No code received');
  let box, prev=null;
  if (a.id) { box=await findCodeLayer(a.id); prev=codeMeta(box); for (const c of box.children.slice()) c.remove(); if (!a.keepRequests) box.setSharedPluginData(CL_NS, 'requests', ''); }
  else {
    const parent=a.parentId ? await node(a.parentId,{}) : figma.currentPage;
    if (!('appendChild' in parent)) throw Error('Invalid parent');
    box=figma.createFrame(); parent.appendChild(box);
  }
  const name=a.name || (prev && prev.name) || (a.tree && a.tree.title) || 'Код';
  const vw=Math.round(a.width || (prev && prev.viewport && prev.viewport.w) || 1440), vh=Math.round(a.height || (prev && prev.viewport && prev.viewport.h) || 900);
  box.name='</> '+name; box.clipsContent=true; box.fills=[{type:'SOLID', color:{r:1,g:1,b:1}}];
  let warnings=a.renderError ? ['Превью не отрисовалось, потому что Figma не на экране ('+a.renderError+'). Слой создан с исходником; плагин сам дорисует превью, как только Figma снова окажется на экране.'] : [], mode=a.preview || 'layers';
  if (mode !== 'none' && a.trees && a.trees.length > 1 && mode === 'layers') {
    warnings=warnings.concat(await buildPages(box, a.trees));
  } else if (mode !== 'none' && a.tree) {
    const built=await buildHtml({tree:a.tree, parentId:box.id, x:0, y:0, name:'Превью', track:true});
    warnings=built.warnings; box.resize(Math.max(1,built.width), Math.max(1,built.height));
    if (mode === 'layers') stampScreen(await figma.getNodeByIdAsync(built.id));
    if (mode === 'image') {
      const pv=await figma.getNodeByIdAsync(built.id);
      const bytes=await withTimeout(pv.exportAsync({format:'PNG', constraint:{type:'SCALE', value:1}}), 30000, 'Экспорт');
      box.fills=[{type:'IMAGE', imageHash:figma.createImage(bytes).hash, scaleMode:'FILL'}]; pv.remove();
    }
  } else {
    box.resize(vw, Math.min(vh, 400));
    const t=figma.createText(); box.appendChild(t);
    await loadFont({family:'Inter', style:'Regular'}); t.fontName={family:'Inter', style:'Regular'};
    t.characters='</> '+name+'\nСлой кода. Выделите его и нажмите «▶ Запустить» в окне Figma Local MCP.'; t.fontSize=16; t.x=24; t.y=24;
  }
  if (!a.id) {
    if (typeof a.x === 'number' || typeof a.y === 'number') { box.x=a.x || 0; box.y=a.y || 0; }
    else if (!a.parentId) { box.x=Math.round(figma.viewport.center.x - box.width/2); box.y=Math.round(figma.viewport.center.y - box.height/2); }
  }
  const keep=(k)=>a[k] !== undefined ? a[k] : (prev && prev[k]) || null;
  writeCode(box, a.html, {name, viewport:{w:vw, h:vh}, preview:mode, pages:a.pages || (prev && prev.pages) || null, source:keep('source'), repo:keep('repo'), version:((prev && prev.version) || 0)+1, updated:new Date().toISOString()});
  figma.commitUndo();
  try { await ensureHeader(box); } catch (e) {}
  if (pageNode(box) === figma.currentPage) { figma.currentPage.selection=[box]; figma.viewport.scrollAndZoomIntoView([box]); notifySelection(); }
  return {id:box.id, name, width:r2(box.width), height:r2(box.height), viewport:{w:vw, h:vh}, chars:a.html.length, preview:mode, version:codeMeta(box).version, warnings};
}
// Draw the preview of a code layer that was created while Figma could not render.
async function refreshPreview(m) {
  const box=await figma.getNodeByIdAsync(m.id); if (!box || box.removed || !codeMeta(box)) return;
  const meta=codeMeta(box);
  for (const c of box.children.slice()) c.remove();
  if (m.trees && m.trees.length > 1 && m.preview !== 'image') { await buildPages(box, m.trees); meta.preview='layers'; box.setSharedPluginData(CL_NS, 'codeLayer', JSON.stringify(meta)); figma.commitUndo(); figma.notify('Превью слоя кода «'+meta.name+'» готово'); return; }
  const built=await buildHtml({tree:m.tree, parentId:box.id, x:0, y:0, name:'Превью', track:true});
  box.resize(Math.max(1,built.width), Math.max(1,built.height));
  if (m.preview !== 'image') stampScreen(await figma.getNodeByIdAsync(built.id));
  if (m.preview === 'image') {
    const pv=await figma.getNodeByIdAsync(built.id);
    const bytes=await withTimeout(pv.exportAsync({format:'PNG', constraint:{type:'SCALE', value:1}}), 30000, 'Экспорт');
    box.fills=[{type:'IMAGE', imageHash:figma.createImage(bytes).hash, scaleMode:'FILL'}]; pv.remove();
  }
  meta.preview=m.preview; box.setSharedPluginData(CL_NS, 'codeLayer', JSON.stringify(meta));
  figma.commitUndo();
  figma.notify('Превью слоя кода «'+meta.name+'» готово');
}
function requestsOf(n) { try { return JSON.parse(n.getSharedPluginData(CL_NS, 'requests') || '[]'); } catch (e) { return []; } }
async function codeLayerGet(a) {
  const c=await findCodeLayer(a.id), out={id:c.id, meta:codeMeta(c), requests:requestsOf(c)};
  if (!a.metaOnly) out.code=readCode(c);
  return out;
}
// Point and edit: what the user asked to change, pointing at an element in the running prototype.
async function addRequest(m) {
  const box=await findCodeLayer(m.id), list=requestsOf(box), r=m.req || {};
  list.push({page:r.page || null, selector:String(r.selector || '').slice(0, 300), tag:r.tag, text:String(r.text || '').slice(0, 200), html:String(r.html || '').slice(0, 600),
    rect:r.rect, note:String(r.note || '').slice(0, 1000), version:(codeMeta(box) || {}).version, at:new Date().toISOString()});
  box.setSharedPluginData(CL_NS, 'requests', JSON.stringify(list.slice(-50)));
  figma.notify('Правка для ИИ сохранена ('+list.length+'). Скажите ИИ: «сделай правки из слоя кода»');
}
// Extract designs: the running page's current state as editable layers in a section next to the layer.
async function extractState(m) {
  if (!m.tree) throw Error('Снимок не получен');
  const box=await findCodeLayer(m.id), meta=codeMeta(box);
  const host=box.parent.type === 'PAGE' || box.parent.type === 'SECTION' ? box.parent : pageNode(box);
  let sec=await figma.getNodeByIdAsync(box.getSharedPluginData(CL_NS, 'shotsSection') || '0:0').catch(()=>null);
  if (!sec || sec.removed || sec.type !== 'SECTION') {
    sec=figma.createSection(); host.appendChild(sec); sec.name='◉ Снимки · '+meta.name;
    const ab=box.absoluteBoundingBox;
    if (host === box.parent) { sec.x=box.x; sec.y=box.y+box.height+240; } else { sec.x=ab.x; sec.y=ab.y+ab.height+240; }
    sec.resizeWithoutConstraints(400, 400);
    box.setSharedPluginData(CL_NS, 'shotsSection', sec.id);
  }
  let x=80; for (const c of sec.children) x=Math.max(x, c.x+c.width+80);
  const n=sec.children.length+1;
  const built=await buildHtml({tree:m.tree, parentId:sec.id, x, y:80, name:n+'. '+(m.label || m.page || meta.name), keepView:true});
  let w=0, h=0; for (const c of sec.children) { w=Math.max(w, c.x+c.width); h=Math.max(h, c.y+c.height); }
  sec.resizeWithoutConstraints(w+80, h+80);
  figma.commitUndo();
  return {id:built.id, name:n+'. '+(m.label || m.page || meta.name), sectionId:sec.id, width:built.width, height:built.height, nodes:built.nodes, warnings:built.warnings};
}
// Build selection: design frames -> pages of a code layer. Prototype Navigate reactions between them
// (and to frames they lead to) become links, URL reactions external links.
const TRANSLIT={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
function slug(s) { return String(s).replace(/\.html?$/i, '').toLowerCase().replace(/[а-яё]/g, c=>TRANSLIT[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'screen'; }
function navTargets(n) {
  const out=[];
  for (const r of ('reactions' in n ? n.reactions || [] : [])) for (const x of (r.actions || (r.action ? [r.action] : []))) if (x && x.type === 'NODE' && x.destinationId && x.navigation !== 'OVERLAY' && x.navigation !== 'SCROLL_TO') out.push(x.destinationId);
  return out;
}
// Back, Close and overlays from Figma prototype interactions, as a few lines of page script.
const PROTO_SCRIPT='<style>.__figma_ov{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:1000}.__figma_ov[hidden]{display:none}</style>'+
  '<script>document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href^=\'#__\']");'+
  'if(!a){var o=e.target.classList&&e.target.classList.contains("__figma_ov")?e.target:null;if(o&&o.getAttribute("data-close")==="1")o.hidden=true;return;}'+
  'var h=a.getAttribute("href");e.preventDefault();'+
  'if(h==="#__back"){var open=document.querySelector(".__figma_ov:not([hidden])");if(open){open.hidden=true;return;}if(window.parent!==window)parent.postMessage({__figmaBack:true},"*");else history.back();}'+
  'else if(h==="#__close"){var c=a.closest(".__figma_ov")||document.querySelector(".__figma_ov:not([hidden])");if(c)c.hidden=true;}'+
  'else if(h.indexOf("#__ov-")===0){var t=document.getElementById(h.slice(1));if(t)t.hidden=false;}},true);<\/script>';
async function framesCode(a) {
  let start=[];
  if (a.ids && a.ids.length) for (const id of a.ids) start.push(await node(id, {}));
  else start=figma.currentPage.selection.slice();
  start=start.filter(n=>n && 'children' in n && n.type !== 'PAGE' && n.type !== 'SECTION');
  if (!start.length) throw Error('Выделите один или несколько фреймов-экранов (или передайте frames: [id…])');
  // Follow prototype links from the chosen screens, so a flow comes with the screens it leads to.
  const frames=[], seen=new Set(), queue=start.slice();
  while (queue.length && frames.length < 12) {
    const f=queue.shift(); if (seen.has(f.id)) continue; seen.add(f.id); frames.push(f);
    const ids=new Set(); for (const n of [f].concat(f.findAll(()=>true))) for (const d of navTargets(n)) ids.add(d);
    for (const id of ids) { const d=await figma.getNodeByIdAsync(id); if (d && !d.removed && 'children' in d && !seen.has(d.id)) queue.push(d); }
  }
  const used=new Set(), pageOf={};
  frames.forEach((f,i)=>{ let name=i === 0 ? 'index.html' : slug(f.name)+'.html', k=2; while (used.has(name)) name=slug(f.name)+'-'+(k++)+'.html'; used.add(name); pageOf[f.id]=name; });
  const pages={}, warns=new Set();
  for (const f of frames) {
    const overlays=new Set();
    const ctx=await designContext({nodeId:f.id, screenshot:false, inline:true, links:true, pageOf, overlays, limit:2000});
    for (const w of ctx.warnings) warns.add(w);
    let extra='';
    // Overlays (Open overlay) become hidden layers of the page, opened by their trigger.
    for (const id of overlays) {
      const ov=await figma.getNodeByIdAsync(id); if (!ov || ov.removed) continue;
      const oc=await designContext({nodeId:ov.id, screenshot:false, inline:true, links:true, pageOf, overlays:new Set(), limit:1000});
      const css=(/<style>([\s\S]*?)<\/style>/.exec(oc.html) || [])[1] || '', body=(/<body>([\s\S]*?)<\/body>/.exec(oc.html) || [])[1] || '';
      const bg=ov.overlayBackground && ov.overlayBackground.type === 'SOLID_COLOR' ? 'rgba('+[ov.overlayBackground.color.r, ov.overlayBackground.color.g, ov.overlayBackground.color.b].map(v=>Math.round(v*255)).join(',')+','+r2(ov.overlayBackground.color.a)+')' : 'transparent';
      const pos=ov.overlayPositionType === 'BOTTOM_CENTER' ? 'align-items:flex-end' : ov.overlayPositionType === 'TOP_CENTER' ? 'align-items:flex-start' : '';
      extra+='<style>'+css.replace(/\*\{box-sizing[^}]*\}\s*body\{[^}]*\}/, '')+'</style><div class="__figma_ov" id="__ov-'+id.replace(/[^0-9a-z]/gi, '-')+'" data-close="'+(ov.overlayBackgroundInteraction === 'CLOSE_ON_CLICK_OUTSIDE' ? 1 : 0)+'" style="background:'+bg+';'+pos+'" hidden>'+body+'</div>';
      warns.add('Оверлей «'+ov.name+'» встроен в страницу '+pageOf[f.id]);
    }
    // After delay (auto-advance) between screens.
    for (const r of f.reactions || []) {
      const x=(r.actions || (r.action ? [r.action] : []))[0];
      if (r.trigger && r.trigger.type === 'AFTER_TIMEOUT' && x && x.type === 'NODE' && pageOf[x.destinationId])
        extra+='<script>setTimeout(function(){var a=document.createElement("a");a.href="'+pageOf[x.destinationId]+'";a.hidden=true;document.body.appendChild(a);a.click();},'+Math.round((r.trigger.timeout || 1)*1000)+');<\/script>';
    }
    if (extra || /href="#__/.test(ctx.html)) extra+=PROTO_SCRIPT;
    pages[pageOf[f.id]]=extra ? ctx.html.replace(/<\/body>(?![\s\S]*<\/body>)/i, ()=>extra+'</body>') : ctx.html;
  }
  if (frames.length > start.length) warns.add('Добавлены экраны, куда ведут переходы прототипа: '+frames.slice(start.length).map(f=>f.name).join(', '));
  return {pages, entry:'index.html', name:start[0].name, width:Math.round(start[0].width), screens:frames.map(f=>({id:f.id, name:f.name, page:pageOf[f.id]})), warnings:[...warns]};
}
async function codeLayerList() {
  const out=[];
  let pg=null;
  const walk=n=>{ if (n.type === 'CODE_INSTANCE') { out.push({id:n.id, name:n.name, page:pg.name, native:true}); return; } if (codeMeta(n)) { out.push({id:n.id, name:codeMeta(n).name, version:codeMeta(n).version, page:pg.name, requests:requestsOf(n).length || undefined}); return; } if ('children' in n) for (const c of n.children) walk(c); };
  for (pg of figma.root.children) { await pg.loadAsync(); walk(pg); }
  return {page:figma.currentPage.name, codeLayers:out};
}

// --- design → code (the local get_design_context) ------------------------------------------------
const LAYOUT_KEYS=new Set(['width','height','position','left','top','right','bottom','display','flex-direction','gap','row-gap','column-gap','padding',
  'justify-content','align-items','align-content','align-self','flex','flex-grow','flex-shrink','flex-basis','flex-wrap','transform','inset']);
const VECTORISH=/^(VECTOR|BOOLEAN_OPERATION|STAR|POLYGON|LINE)$/;
const JUSTIFY={MIN:'flex-start', CENTER:'center', MAX:'flex-end', SPACE_BETWEEN:'space-between', SPACE_EVENLY:'space-evenly', SPACE_AROUND:'space-around'};
const ALIGNI={MIN:'flex-start', CENTER:'center', MAX:'flex-end', BASELINE:'baseline'};
const px=v=>(Math.round(v*100)/100)+'px';
function hasText(n) { if (n.type === 'TEXT') return true; if ('children' in n) for (const c of n.children) if (hasText(c)) return true; return false; }
function hasVector(n) { if (VECTORISH.test(n.type)) return true; if ('children' in n) for (const c of n.children) if (hasVector(c)) return true; return false; }
const isIcon=n=>VECTORISH.test(n.type) || ('children' in n && n.width <= 128 && n.height <= 128 && hasVector(n) && !hasText(n) && !(n.fills && n.fills.some && n.fills.some(f=>f.type === 'IMAGE')));
function imageExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49) return 'webp';
  return 'png';
}
async function imageAsset(hash, assets) {
  const name='img-'+hash.slice(0,16);
  for (const k of Object.keys(assets)) if (k.indexOf(name) === 0) return k;
  const img=figma.getImageByHash(hash); if (!img) return null;
  const bytes=await withTimeout(img.getBytesAsync(), 20000, 'Картинка'), file=name+'.'+imageExt(bytes);
  assets[file]=figma.base64Encode(bytes);
  return file;
}
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
async function designContext(a) {
  const root=await node(a.nodeId,{});
  const N=Math.max(1, Math.min(Math.trunc(a.limit || 500), 2000));
  let count=0; const rules=[], assets={}, fonts=new Set(), components=new Map(), warns=new Set();
  // Where a layer leads: a code-layer link, or a prototype reaction to one of the screens being built.
  function linkOf(n) {
    const own=n.getSharedPluginData(CL_NS, 'href'); if (!a.pageOf) return own;
    for (const r of ('reactions' in n ? n.reactions || [] : [])) {
      if (r.trigger && r.trigger.type !== 'ON_CLICK' && r.trigger.type !== 'ON_PRESS') continue;
      for (const x of (r.actions || (r.action ? [r.action] : []))) {
        if (!x) continue;
        if (x.type === 'NODE' && x.navigation === 'OVERLAY' && x.destinationId && a.overlays) { a.overlays.add(x.destinationId); return '#__ov-'+x.destinationId.replace(/[^0-9a-z]/gi, '-'); }
        if (x.type === 'NODE' && a.pageOf[x.destinationId] && x.navigation !== 'SCROLL_TO') return a.pageOf[x.destinationId];
        if (x.type === 'BACK') return '#__back';
        if (x.type === 'CLOSE') return '#__close';
        if (x.type === 'URL' && x.url) return x.url;
      }
    }
    // A code-layer link only if it still names one of the pages being built.
    return own && (Object.values(a.pageOf).includes(own) || /^[a-z]+:/i.test(own)) ? own : '';
  }
  async function el(n, parent, depth, inLink) {
    if (++count > N) { warns.add('Узлов больше '+N+' — код обрезан'); return ''; }
    if ('visible' in n && !n.visible) return '';
    const cls='n'+n.id.replace(/[^0-9a-z]+/gi,'-').replace(/^-|-$/g,'');
    const s={};
    const inFlow=parent && parent.layoutMode && parent.layoutMode !== 'NONE' && parent.layoutMode !== 'GRID' && n.layoutPositioning !== 'ABSOLUTE';
    if (!parent) { s.position='relative'; s.width=px(n.width); s.height=px(n.height); }
    else if (!inFlow) { s.position='absolute'; s.left=px(n.x); s.top=px(n.y); s.width=px(n.width); s.height=px(n.height); }
    else {
      const row=parent.layoutMode === 'HORIZONTAL', H=n.layoutSizingHorizontal, V=n.layoutSizingVertical;
      if (H === 'FIXED') s.width=px(n.width); else if (H === 'FILL') { if (row) s.flex='1 1 0'; else s['align-self']='stretch'; }
      if (V === 'FIXED') s.height=px(n.height); else if (V === 'FILL') { if (!row) s.flex='1 1 0'; else s['align-self']='stretch'; }
      if (!s.flex) s['flex-shrink']='0';
    }
    if (n.type === 'TEXT') {
      if (n.textAutoResize === 'WIDTH_AND_HEIGHT') { delete s.width; s['white-space']='nowrap'; }
      if (n.textAutoResize !== 'NONE') delete s.height;
    }
    // Icons and lone vectors: inline SVG keeps them crisp and editable in code.
    if (parent && isIcon(n)) {
      try {
        let svg=await withTimeout(n.exportAsync({format:'SVG_STRING'}), 30000, 'Экспорт');
        svg=svg.replace(/<svg\b/, '<svg class="'+cls+'" aria-hidden="true"');
        rules.push('.'+cls+'{'+Object.entries(s).map(([k,v])=>k+':'+v).join(';')+'}');
        const iconLink=a.links && !inLink ? linkOf(n) : '';
        return iconLink ? '<a href="'+esc(iconLink)+'" style="cursor:pointer">'+svg+'</a>' : svg;
      } catch (e) { warns.add('SVG для '+n.name+' не выгрузился'); }
    }
    if ('layoutMode' in n && (n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL')) {
      s.display='flex'; s['flex-direction']=n.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
      if (n.itemSpacing) s.gap=px(n.itemSpacing);
      if (n.paddingTop || n.paddingRight || n.paddingBottom || n.paddingLeft) s.padding=[n.paddingTop,n.paddingRight,n.paddingBottom,n.paddingLeft].map(px).join(' ');
      if (JUSTIFY[n.primaryAxisAlignItems]) s['justify-content']=JUSTIFY[n.primaryAxisAlignItems];
      if (ALIGNI[n.counterAxisAlignItems]) s['align-items']=ALIGNI[n.counterAxisAlignItems];
      if (n.layoutWrap === 'WRAP') { s['flex-wrap']='wrap'; if (n.counterAxisSpacing) s['row-gap']=px(n.counterAxisSpacing); }
      if (n.children.some(c=>c.layoutPositioning === 'ABSOLUTE') && !s.position) s.position='relative';
    } else if ('layoutMode' in n && n.layoutMode === 'GRID') {
      s.display='grid';
      if (n.gridColumnCount) s['grid-template-columns']='repeat('+n.gridColumnCount+', 1fr)';
      if (n.gridRowCount) s['grid-template-rows']='repeat('+n.gridRowCount+', auto)';
      if (n.gridRowGap) s['row-gap']=px(n.gridRowGap);
      if (n.gridColumnGap) s['column-gap']=px(n.gridColumnGap);
    } else if ('children' in n && n.children.length && !s.position) s.position='relative';
    if ('clipsContent' in n && n.clipsContent) s.overflow='hidden';
    // Paint, border, radius, shadow, typography: Figma's own CSS (keeps var(--token) references).
    if (typeof n.getCSSAsync === 'function') {
      try { const css=await withTimeout(n.getCSSAsync(), 15000, 'CSS слоя'); for (const k of Object.keys(css)) if (!LAYOUT_KEYS.has(k) && !/^\/\*/.test(k)) s[k]=css[k]; } catch (e) {}
    }
    if ('fills' in n && Array.isArray(n.fills)) {
      const img=n.fills.find(f=>f.type === 'IMAGE' && f.visible !== false && f.imageHash);
      if (img) {
        const file=await imageAsset(img.imageHash, assets);
        if (file) { delete s.background; s['background-image']=a.inline ? 'url(data:image/'+(file.split('.').pop() === 'jpg' ? 'jpeg' : file.split('.').pop())+';base64,'+assets[file]+')' : 'url(assets/'+file+')'; s['background-size']=img.scaleMode === 'FIT' ? 'contain' : img.scaleMode === 'TILE' ? 'auto' : 'cover'; s['background-position']='center'; s['background-repeat']=img.scaleMode === 'TILE' ? 'repeat' : 'no-repeat'; }
      }
    }
    if (n.type === 'TEXT') {
      if (n.fontName !== figma.mixed) fonts.add(n.fontName.family);
      if (n.textAlignHorizontal && n.textAlignHorizontal !== 'LEFT') s['text-align']=n.textAlignHorizontal === 'JUSTIFIED' ? 'justify' : n.textAlignHorizontal.toLowerCase();
    }
    // Prototype from the design: layers that lead somewhere become links, input layers real fields.
    const myLink=a.links && !inLink && parent ? linkOf(n) : '';
    const inputMeta=a.links && n.type !== 'TEXT' ? n.getSharedPluginData(CL_NS, 'input') : '';
    if (inputMeta) {
      let im={}; try { im=JSON.parse(inputMeta); } catch (e) {}
      const tx='findOne' in n ? n.findOne(x=>x.type === 'TEXT') : null;
      if (tx && typeof tx.getCSSAsync === 'function') { try { const tc=await withTimeout(tx.getCSSAsync(), 15000, 'CSS слоя'); for (const k of ['color','font-family','font-size','font-weight','line-height','letter-spacing']) if (tc[k]) s[k]=tc[k]; } catch (e) {} }
      if (tx) s['padding-left']=px(tx.x);
      s.border=s.border || '0'; s.outline='none'; s['box-sizing']='border-box';
      rules.push('.'+cls+'{'+Object.entries(s).map(([k,v])=>k+':'+v).join(';')+'}');
      const ph=esc(im.placeholder || (tx && !im.value ? tx.characters : '')), val=esc(im.value || '');
      const nm2=im.name ? ' name="'+esc(im.name)+'"' : '';
      if (im.tag === 'textarea') return '<textarea class="'+cls+'"'+nm2+' placeholder="'+ph+'">'+val+'</textarea>';
      if (im.type === 'checkbox' || im.type === 'radio') return '<input class="'+cls+'" type="'+im.type+'"'+nm2+(im.checked ? ' checked' : '')+' style="appearance:auto;margin:0">';
      return '<input class="'+cls+'" type="'+(/^(text|email|tel|number|password|search|date|url)$/.test(im.type) ? im.type : 'text')+'"'+nm2+' placeholder="'+ph+'" value="'+val+'">';
    }
    if (myLink) { s.cursor='pointer'; if (n.type !== 'TEXT') s['text-decoration']='none'; }
    rules.push('.'+cls+'{'+Object.entries(s).map(([k,v])=>k+':'+v).join(';')+'}');
    let attrs=' class="'+cls+'" data-name="'+esc(n.name)+'"';
    if (myLink) attrs+=' href="'+esc(myLink)+'"';
    if (n.type === 'INSTANCE') {
      try { const mc=await n.getMainComponentAsync(); if (mc) { const cname=mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent.name : mc.name; attrs+=' data-component="'+esc(cname)+'" data-variant="'+esc(mc.name)+'"'; components.set(cname, (components.get(cname) || 0)+1); } } catch (e) {}
    }
    if (n.type === 'TEXT') {
      let inner='';
      try {
        const segs=n.getStyledTextSegments(['fontName','fontSize','fills','textDecoration']);
        for (const g of segs) {
          if (g.fontName) fonts.add(g.fontName.family);
          const t=esc(g.characters).replace(/\n/g,'<br>');
          const st=[];
          // Several styles in one text: every run states its own look, so nothing depends on
          // which run Figma's CSS for the whole node happened to describe.
          if (segs.length > 1) {
            st.push("font-family:'"+g.fontName.family.replace(/'/g,'')+"'", 'font-weight:'+styleWeight(g.fontName.style));
            if (/italic|oblique/i.test(g.fontName.style)) st.push('font-style:italic');
            st.push('font-size:'+px(g.fontSize));
            const f=g.fills && g.fills[0];
            if (f && f.type === 'SOLID') st.push('color:'+hex(f.color, f.opacity));
            if (g.textDecoration && g.textDecoration !== 'NONE') st.push('text-decoration:'+(g.textDecoration === 'UNDERLINE' ? 'underline' : 'line-through'));
          }
          inner+=st.length ? '<span style="'+st.join(';')+'">'+t+'</span>' : t;
        }
      } catch (e) { inner=esc(n.characters).replace(/\n/g,'<br>'); }
      return myLink ? '<a'+attrs+' style="display:block;text-decoration:none">'+inner+'</a>' : '<p'+attrs+'>'+inner+'</p>';
    }
    let kids='';
    if ('children' in n) for (const c of n.children) kids+=await el(c, n, depth+1, inLink || !!myLink);
    return myLink ? '<a'+attrs+' style="display:block">'+kids+'</a>' : '<div'+attrs+'>'+kids+'</div>';
  }
  const body=await el(root, null, 0);
  const fam=[...fonts].filter(f=>!/^(Inter|SF Pro|Arial|Helvetica)/i.test(f));
  const fontLink=fam.length ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'+fam.map(f=>'family='+encodeURIComponent(f).replace(/%20/g,'+')+':ital,wght@0,400;0,500;0,700;0,900;1,400').join('&')+'&display=swap">\n' : '';
  const html='<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>'+esc(root.name)+'</title>\n'+fontLink+
    '<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:'+(fam[0] ? '"'+fam[0]+'", ' : '')+'Inter, system-ui, sans-serif;-webkit-font-smoothing:antialiased}\n'+rules.join('\n')+'\n</style>\n</head>\n<body>\n'+body+'\n</body>\n</html>\n';
  const out={nodeId:root.id, name:root.name, width:r2(root.width), height:r2(root.height), nodes:Math.min(count,N), html, assets,
    components:[...components].map(([name,uses])=>({name, uses})), fonts:[...fonts], warnings:[...warns]};
  if (a.screenshot !== false && 'exportAsync' in root) {
    const side=Math.max(root.width, root.height) || 1, scale=Math.min(2, 1024/side);
    out.screenshot=figma.base64Encode(await withTimeout(root.exportAsync({format:'PNG', constraint:{type:'SCALE', value:scale}}), 30000, 'Экспорт'));
  }
  return out;
}

// --- variables used by a node (the local get_variable_defs) --------------------------------------
async function variableDefs(a) {
  const root=await node(a.nodeId,{});
  const out={}, done=new Set(); let count=0;
  async function add(alias, consumer, field) {
    if (!alias || !alias.id || done.has(alias.id)) return;
    done.add(alias.id);
    const v=await figma.variables.getVariableByIdAsync(alias.id); if (!v) return;
    let value=null; try { value=valueOut(v.resolveForConsumer(consumer).value); } catch (e) {}
    let collection=null; try { const c=await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId); collection=c && c.name; } catch (e) {}
    out[v.name]={value, type:v.resolvedType, id:v.id, collection, firstUsedOn:{node:consumer.name, field}};
  }
  async function walk(n) {
    if (++count > 3000) return;
    const bv=n.boundVariables || {};
    for (const k of Object.keys(bv)) for (const al of (Array.isArray(bv[k]) ? bv[k] : [bv[k]])) await add(al, n, k);
    for (const key of ['fills','strokes']) if (Array.isArray(n[key])) for (const p of n[key]) if (p.boundVariables && p.boundVariables.color) await add(p.boundVariables.color, n, key);
    if (Array.isArray(n.effects)) for (const e of n.effects) if (e.boundVariables) for (const k of Object.keys(e.boundVariables)) await add(e.boundVariables[k], n, 'effects.'+k);
    if (n.type === 'TEXT' && typeof n.getStyledTextSegments === 'function') {
      try { for (const g of n.getStyledTextSegments(['boundVariables'])) for (const k of Object.keys(g.boundVariables || {})) await add(g.boundVariables[k], n, k); } catch (e) {}
    }
    if ('children' in n) for (const c of n.children) await walk(c);
  }
  await walk(root);
  return {nodeId:root.id, name:root.name, variables:out, count:Object.keys(out).length};
}

// --- assets (the local download_assets) ----------------------------------------------------------
async function assetsOf(a) {
  const root=await node(a.nodeId,{});
  const format=String(a.format || 'PNG').toUpperCase(), scale=Math.max(0.05, Math.min(Number(a.scale) || 2, 4));
  const settings={format}; if (format === 'PNG' || format === 'JPG') settings.constraint={type:'SCALE', value:scale};
  const out={nodeId:root.id, name:root.name, export:{format, data:figma.base64Encode(await withTimeout(root.exportAsync(settings), 30000, 'Экспорт'))}, images:{}, svgs:[]};
  let svgCount=0;
  async function walk(n) {
    if ('visible' in n && !n.visible) return;
    if ('fills' in n && Array.isArray(n.fills)) for (const f of n.fills) if (f.type === 'IMAGE' && f.imageHash && Object.keys(out.images).length < 20) await imageAsset(f.imageHash, out.images);
    if (n !== root && isIcon(n)) {
      if (svgCount < 20) { try { out.svgs.push({name:n.name, nodeId:n.id, svg:await withTimeout(n.exportAsync({format:'SVG_STRING'}), 30000, 'Экспорт')}); svgCount++; } catch (e) {} }
      return;
    }
    if ('children' in n) for (const c of n.children) await walk(c);
  }
  await walk(root);
  return out;
}

// --- motion (the local get_motion_context) -------------------------------------------------------
function jsonSafe(v) { try { return JSON.parse(JSON.stringify(v, (k,x)=>x === figma.mixed ? 'MIXED' : x)); } catch (e) { return String(e.message || e); } }
async function motionOf(a) {
  const root=await node(a.nodeId,{});
  const out=[]; let count=0;
  function grab(n) {
    const item={id:n.id, name:n.name, type:n.type}; let any=false;
    for (const k of ['animations','manualKeyframeTracks','timelines','animationStyles']) {
      if (!(k in n)) continue;
      let v; try { v=n[k]; } catch (e) { continue; }
      const val=jsonSafe(v);
      const empty=val === null || val === undefined || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length);
      if (empty) continue;
      item[k]=val;
      if (k !== 'timelines') any=true;   // every frame has a default timeline; only real animation counts
    }
    if (any) out.push(item);
  }
  function walk(n) { if (++count > 2000) return; grab(n); if (a.recursive && 'children' in n) for (const c of n.children) walk(c); }
  walk(root);
  const res={nodeId:root.id, animated:out};
  if (figma.motion) { try { res.playheadPosition=figma.motion.playheadPosition; } catch (e) {} }
  if (!out.length) res.note='На узле нет Motion-анимаций'+(a.recursive ? '' : ' (передайте recursive: true, чтобы проверить детей)');
  return res;
}

// --- accessibility pass (the cloud "Run an accessibility pass") ---------------------------------
function relLum(c) { const f=v=>v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); }
const contrastOf=(a, b)=>{ const x=relLum(a), y=relLum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
function topSolid(n) {
  if (!('fills' in n) || n.fills === figma.mixed) return null;
  const f=n.fills.slice().reverse().find(p=>p.visible !== false && p.type === 'SOLID' && (p.opacity === undefined || p.opacity >= 0.5));
  return f ? f.color : null;
}
const boxOf=n=>{ const t=n.absoluteTransform; return {x:t[0][2], y:t[1][2], w:n.width, h:n.height}; };
const inside=(a, b)=>a.x >= b.x-0.5 && a.y >= b.y-0.5 && a.x+a.w <= b.x+b.w+0.5 && a.y+a.h <= b.y+b.h+0.5;
// What is painted behind a layer: an earlier sibling that covers it, else the nearest filled ancestor.
function backdrop(n) {
  const me=boxOf(n);
  for (let cur=n; cur.parent && cur.parent.type !== 'PAGE'; cur=cur.parent) {
    const sibs=cur.parent.children, i=sibs.indexOf(cur);
    for (let j=i-1; j >= 0; j--) { const s=sibs[j]; if (s.visible === false) continue; const c=topSolid(s); if (c && inside(me, boxOf(s))) return c; }
    const pc=topSolid(cur.parent); if (pc) return pc;
  }
  return {r:1, g:1, b:1};
}
async function a11y(a) {
  const root=a.nodeId ? await node(a.nodeId,{}) : (figma.currentPage.selection[0] || null);
  if (!root) throw Error('Pass nodeId or select a frame');
  const issues=[]; let texts=0, targets=0, count=0;
  const add=(n, kind, level, detail)=>{ if (issues.length < 300) issues.push({id:n.id, name:n.name.slice(0,60), kind, level, detail}); };
  function walk(n) {
    if (++count > 5000 || ('visible' in n && !n.visible)) return;
    if (n.type === 'TEXT' && n.characters.trim()) {
      texts++;
      const fc=topSolid(n), size=n.fontSize === figma.mixed ? 16 : n.fontSize;
      const bold=n.fontName !== figma.mixed && styleWeight(n.fontName.style) >= 700;
      if (fc) {
        const ratio=contrastOf(fc, backdrop(n)), large=size >= 24 || (size >= 18.66 && bold), need=large ? 3 : 4.5;
        if (ratio < need) add(n, 'contrast', ratio < need-1 ? 'error' : 'warning', 'Контраст '+ratio.toFixed(2)+':1, нужно не меньше '+need+':1 ('+(large ? 'крупный' : 'обычный')+' текст '+size+'px)');
      }
      if (size < 12) add(n, 'font-size', 'warning', 'Кегль '+size+'px — мельче 12px трудно читать');
    }
    const link=n.getSharedPluginData(CL_NS, 'href'), input=n.getSharedPluginData(CL_NS, 'input');
    const looksButton=/button|btn|кнопк|ссылк|link/i.test(n.name) && n.type !== 'TEXT';
    if ((link || input || looksButton) && n.type !== 'PAGE') {
      targets++;
      const m=Math.min(n.width, n.height);
      if (m < 24) add(n, 'target-size', 'error', 'Нажимаемая область '+Math.round(n.width)+'×'+Math.round(n.height)+' — меньше 24px (WCAG 2.5.8)');
      else if (m < 44) add(n, 'target-size', 'warning', 'Нажимаемая область '+Math.round(n.width)+'×'+Math.round(n.height)+' — для пальца лучше от 44px');
    }
    if ('children' in n) for (const ch of n.children) walk(ch);
  }
  walk(root);
  const errors=issues.filter(i=>i.level === 'error').length;
  return {nodeId:root.id, name:root.name, checked:{texts, targets, layers:Math.min(count,5000)}, errors, warnings:issues.length-errors, issues,
    note:'Контраст считается по сплошной заливке текста и того, что под ним; градиенты и картинки под текстом проверь глазами.'};
}

// --- native Figma prototype from a code layer (plays without this plugin) ------------------------
// Screens become top-level frames in a section, every layer that leads somewhere gets an on-click
// "navigate to" reaction, the entry screen becomes a flow starting point - the toolbar Play button,
// Present mode and shared prototype links then work for anyone, no plugin needed.
async function figmaPrototype(a) {
  const box=await findCodeLayer(a.id), meta=codeMeta(box), pp=packParts(readCode(box));
  if (pageNode(box) !== figma.currentPage) await figma.setCurrentPageAsync(pageNode(box));   // flows live on the page
  const screens=screensOf(box);
  if (!screens.length) throw Error('У слоя кода нет экранов-превью: обновите слой с preview:"layers", когда Figma на экране');
  const entryName=pp ? pp.entry : (screens[0].getSharedPluginData(CL_NS, 'page') || 'index.html');
  // Replace the section made last time for this layer.
  const prevId=box.getSharedPluginData(CL_NS, 'protoSection');
  if (prevId) { const old=await figma.getNodeByIdAsync(prevId); if (old && !old.removed) old.remove(); }
  const secName='▶ Прототип · '+meta.name;
  for (const n of figma.currentPage.children.filter(n=>n.type === 'SECTION' && n.name === secName)) n.remove();   // leftovers of an interrupted run
  const sec=figma.createSection(); figma.currentPage.appendChild(sec);
  sec.name=secName;
  box.setSharedPluginData(CL_NS, 'protoSection', sec.id);
  const abs=box.absoluteTransform;
  const pad=80, gap=120;
  const byPage={};
  let x=pad, h=0;
  for (const f of screens) {
    const copy=f.clone(); sec.appendChild(copy);
    const page=f.getSharedPluginData(CL_NS, 'page') || entryName;
    copy.name=page; copy.x=x; copy.y=pad; copy.clipsContent=true;
    byPage[page]=copy; x+=copy.width+gap; h=Math.max(h, copy.height);
  }
  sec.resizeWithoutConstraints(Math.max(200, x-gap+pad), h+pad*2);
  sec.x=abs[0][2]; sec.y=abs[1][2]+box.height+200;
  let links=0; const missing=new Set();
  const setReaction=async (n, dest)=>{
    const r=[{trigger:{type:'ON_CLICK'}, actions:[{type:'NODE', destinationId:dest.id, navigation:'NAVIGATE', transition:{type:'DISSOLVE', easing:{type:'EASE_OUT'}, duration:0.2}, preserveScrollPosition:false}]}];
    if (typeof n.setReactionsAsync === 'function') await n.setReactionsAsync(r); else n.reactions=r;
  };
  for (const page of Object.keys(byPage)) {
    const found=byPage[page].findAll(n=>!!n.getSharedPluginData(CL_NS, 'href'));
    for (const n of found) {
      const href=n.getSharedPluginData(CL_NS, 'href').split('#')[0].split('?')[0].replace(/^\.\//, '');
      if (!href) continue;
      // Only the outermost link layer reacts, so a button and its label do not both fire.
      let p=n.parent, nested=false; while (p && p !== byPage[page]) { if (p.getSharedPluginData(CL_NS, 'href')) { nested=true; break; } p=p.parent; }
      if (nested) continue;
      const dest=byPage[href];
      if (dest === byPage[page]) continue;   // a link to the screen you are on: nothing to navigate to
      if (!dest) { missing.add(href); continue; }
      try { await setReaction(n, dest); links++; } catch (e) { missing.add(href+' ('+(e.message||e)+')'); }
    }
  }
  const entry=byPage[entryName] || Object.values(byPage)[0];
  // Keep the page's other flows; drop ones pointing at removed screens and duplicates (Figma rejects them).
  const seen=new Set([entry.id]), flows=[];
  for (const fp of figma.currentPage.flowStartingPoints) {
    if (fp.name === meta.name || seen.has(fp.nodeId)) continue;
    const n=await figma.getNodeByIdAsync(fp.nodeId); if (!n || n.removed) continue;
    seen.add(fp.nodeId); flows.push({nodeId:fp.nodeId, name:fp.name});
  }
  figma.currentPage.flowStartingPoints=flows.concat([{nodeId:entry.id, name:meta.name}]);
  figma.commitUndo();
  figma.currentPage.selection=[entry]; figma.viewport.scrollAndZoomIntoView([sec]);
  return {sectionId:sec.id, entryId:entry.id, screens:Object.keys(byPage), links, missing:[...missing],
    howToPlay:'Выделите экран «'+entryName+'» и нажмите ▶ (Present) справа вверху или откройте вкладку Prototype → Flow «'+meta.name+'». Поделиться — Share → Copy prototype link.'};
}

// --- who and where (the local whoami) ------------------------------------------------------------
function info() {
  let user=null; try { if (figma.currentUser) user={id:figma.currentUser.id, name:figma.currentUser.name}; } catch (e) {}
  let fileKey=null; try { fileKey=figma.fileKey || null; } catch (e) {}
  return {pluginVersion:'2.4.0', connectionVersion, user, file:figma.root.name, fileKey, editorType:figma.editorType, page:{id:figma.currentPage.id, name:figma.currentPage.name}, pages:figma.root.children.map(p=>p.name),
    selection:figma.currentPage.selection.slice(0,10).map(n=>({id:n.id, name:n.name, type:n.type}))};
}

let busy=false, connectionVersion=null;
figma.ui.onmessage=async job=>{
  if(job && job.type==='clientInfo'){connectionVersion=String(job.version||'');return;}
  if(job && job.type==='save'){try{await figma.clientStorage.setAsync('bridge',job.value);}catch(e){}return;}
  if(job && job.type==='clear'){try{await figma.clientStorage.deleteAsync('bridge');}catch(e){}return;}
  // Figma reloads the plugin on every file change, so the pairing comes back from
  // clientStorage. The UI asks for it itself: pushing it at startup races the iframe,
  // which may not have registered its message handler yet. clientStorage needs the
  // manifest "id" - without it Figma refuses access outright.
  if(job && job.type==='restore?'){
    let value=null, ui=null;
    try{value=await figma.clientStorage.getAsync('bridge');}catch(e){}
    try{ui=await figma.clientStorage.getAsync('ui');}catch(e){}
    if(value||ui)figma.ui.postMessage({type:'restore',value,ui});
    return;
  }
  // Window chrome: collapse to a strip, drag-resize, hide while the bridge keeps polling.
  if(job && job.type==='setLink'){try{const n=await figma.getNodeByIdAsync(job.id);if(n){n.setSharedPluginData(CL_NS,'href',job.href||'');figma.notify(job.href?'Ссылка «'+n.name+'» → '+job.href:'Ссылка у «'+n.name+'» убрана');}}catch(e){}return;}
  if(job && job.type==='makePrototype'){try{const r=await figmaPrototype({id:job.id});figma.notify('Прототип Figma готов: '+r.screens.length+' экр., '+r.links+' переходов. Нажмите ▶ справа вверху.');}catch(e){figma.notify(String(e.message||e),{error:true});}return;}
  if(job && job.type==='runnerDone'){const res=runnerWaits.get(job.token);if(res){runnerWaits.delete(job.token);res(job);}return;}
  if(job && job.type==='runCodeLayer'){try{await runCodeLayer(job.id,{restart:true});}catch(e){figma.notify(String(e.message||e),{error:true});}return;}
  if(job && job.type==='uiReady'){notifySelection();return;}
  if(job && job.type==='extractState'){try{const r=await extractState(job);figma.notify('Снимок «'+r.name+'» добавлен в секцию «◉ Снимки»');}catch(e){figma.notify('Снимок: '+String(e.message||e),{error:true});}return;}
  if(job && job.type==='addRequest'){try{await addRequest(job);}catch(e){figma.notify(String(e.message||e),{error:true});}return;}
  if(job && job.type==='refreshPreview'){try{await refreshPreview(job);}catch(e){figma.notify('Превью слоя кода: '+String(e.message||e),{error:true});}return;}
  if(job && job.type==='resize'){figma.ui.resize(Math.max(200,Math.min(Math.round(job.w)||380,2400)),Math.max(40,Math.min(Math.round(job.h)||370,1600)));return;}
  if(job && job.type==='saveUi'){try{await figma.clientStorage.setAsync('ui',job.value);}catch(e){}return;}
  if(job && job.type==='hide'){figma.ui.hide();if(!job.quiet)figma.notify('Figma Local MCP скрыт и продолжает работать. Чтобы показать окно, запустите плагин снова.');return;}
  if(job && job.type==='show'){figma.ui.show();return;}
  if(job && job.type==='notify'){figma.notify(String(job.text).slice(0,200),{error:!!job.error,timeout:job.error?10000:4000});return;}
  if(busy) {figma.ui.postMessage({id:job.id,error:'Plugin is busy with another command; retry when it finishes.',completed:[],failedIndex:0,partialChangesPossible:false});return;}
  busy=true;
  const results=[];
  try {
    if(job.action==='figma_read') {
      const pg=job.args.page ? await findPage(job.args.page) : null;
      const roots=job.args.nodeId ? [await node(job.args.nodeId,{})] : pg ? pg.children : (figma.currentPage.selection.length ? figma.currentPage.selection : figma.currentPage.children);
      figma.ui.postMessage({id:job.id,result:readTree(roots,job.args.depth,job.args.limit)});
    } else if(job.action==='figma_screenshot') {
      figma.ui.postMessage({id:job.id,result:await screenshot(job.args)});
    } else if(job.action==='figma_css') {
      figma.ui.postMessage({id:job.id,result:await cssTree(job.args)});
    } else if(job.action==='figma_export') {
      figma.ui.postMessage({id:job.id,result:await exportNode(job.args)});
    } else if(job.action==='figma_pages') {
      figma.ui.postMessage({id:job.id,result:await pages(job.args)});
    } else if(job.action==='figma_library') {
      figma.ui.postMessage({id:job.id,result:await library(job.args)});
    } else if(job.action==='figma_code_layer') {
      figma.ui.postMessage({id:job.id,result:await codeLayer(job.args)});
    } else if(job.action==='figma_code_layer_get') {
      figma.ui.postMessage({id:job.id,result:job.args.list ? await codeLayerList() : await codeLayerGet(job.args)});
    } else if(job.action==='figma_code_layer_run') {
      figma.ui.postMessage({id:job.id,result:await runCodeLayer(job.args.id, job.args)});
    } else if(job.action==='figma_code_layer_sync') {
      figma.ui.postMessage({id:job.id,result:await syncCodeLayer(job.args.id)});
    } else if(job.action==='figma_design_context') {
      figma.ui.postMessage({id:job.id,result:await designContext(job.args)});
    } else if(job.action==='figma_variable_defs') {
      figma.ui.postMessage({id:job.id,result:await variableDefs(job.args)});
    } else if(job.action==='figma_assets') {
      figma.ui.postMessage({id:job.id,result:await assetsOf(job.args)});
    } else if(job.action==='figma_motion') {
      figma.ui.postMessage({id:job.id,result:await motionOf(job.args)});
    } else if(job.action==='figma_prototype') {
      figma.ui.postMessage({id:job.id,result:await figmaPrototype(job.args)});
    } else if(job.action==='figma_a11y') {
      figma.ui.postMessage({id:job.id,result:await a11y(job.args)});
    } else if(job.action==='figma_frames_code') {
      figma.ui.postMessage({id:job.id,result:await framesCode(job.args)});
    } else if(job.action==='figma_info') {
      figma.ui.postMessage({id:job.id,result:info()});
    } else if(job.action==='figma_import_html') {
      figma.ui.postMessage({id:job.id,result:await buildHtml(job.args)});
    } else if(job.action==='figma_apply') {
      const refs={};
      if(!Array.isArray(job.args.operations)||job.args.operations.length>MAX_OPS)throw Error('Invalid batch');
      const defaultPage=job.args.page ? await findPage(job.args.page) : null;
      for(const op of job.args.operations) {
        let n, extra;
        const p=Object.assign({}, op.props||{});
        if('svg' in p && !(op.action==='create' && op.type==='SVG'))throw Error('props.svg works only with create type SVG');
        if(op.action==='create') {
          const methods={FRAME:'createFrame',RECTANGLE:'createRectangle',ELLIPSE:'createEllipse',TEXT:'createText',COMPONENT:'createComponent',SECTION:'createSection',LINE:'createLine'};
          if(op.type!=='SVG' && op.type!=='INSTANCE' && !methods[op.type])throw Error('Unsupported node type');
          const parent=op.parentId ? await node(op.parentId,refs) : (defaultPage || figma.currentPage);
          if(!('appendChild' in parent))throw Error('Invalid parent');
          if(op.type==='SVG') {
            if(typeof p.svg!=='string'||!p.svg.trim())throw Error('create SVG needs props.svg with the markup');
            n=figma.createNodeFromSvg(p.svg); delete p.svg;
          } else if(op.type==='INSTANCE') {
            // A local component by id, or a published library component by key.
            let comp=p.componentId ? await figma.getNodeByIdAsync(p.componentId) : null;
            if(!comp && p.componentKey) {
              // A published library component imports by key; an unpublished one in this file is found by its key.
              try { comp=await figma.importComponentByKeyAsync(p.componentKey); }
              catch(e) {
                await figma.loadAllPagesAsync();
                comp=figma.root.findAllWithCriteria({types:['COMPONENT','COMPONENT_SET']}).find(c=>c.key===p.componentKey) || null;
                if(!comp) throw e;
              }
            }
            if(!comp)throw Error('create INSTANCE needs props.componentId (local) or props.componentKey (library)');
            if(comp.type==='COMPONENT_SET')comp=comp.defaultVariant;
            if(comp.type!=='COMPONENT')throw Error('componentId must point to a COMPONENT or COMPONENT_SET, got '+comp.type);
            delete p.componentId; delete p.componentKey;
            n=comp.createInstance();
          } else n=figma[methods[op.type]]();
          try { place(parent,n,op.index); await props(n,p); } catch(e) {n.remove();throw e;}
          if(op.type==='SVG') extra=descendants(n);
          if(op.ref)refs['$'+op.ref]=n;
        } else if(op.action==='clone') {
          const src=await node(op.id,refs);
          if(src.type==='PAGE')throw Error('Cannot clone the page');
          if(!('clone' in src))throw Error(src.type+' cannot be cloned');
          const parent=op.parentId ? await node(op.parentId,refs) : src.parent;
          if(!parent||!('appendChild' in parent))throw Error('Invalid parent');
          n=src.clone();
          try { place(parent,n,op.index); await props(n,p); } catch(e) {n.remove();throw e;}
          extra=descendants(n);
          if(op.ref)refs['$'+op.ref]=n;
        } else if(op.action==='detach') {
          // Figma forbids appending into an instance. Detaching returns a visually identical
          // frame that can be edited, which is the only supported way in to its contents.
          const inst=await node(op.id,refs);
          if(inst.type!=='INSTANCE')throw Error('detach expects an INSTANCE, got '+inst.type);
          n=inst.detachInstance();
          await props(n,p);
          extra=descendants(n);
          if(op.ref)refs['$'+op.ref]=n;
        } else if(op.action==='move') {
          n=await node(op.id,refs);
          if(n.type==='PAGE')throw Error('Cannot move the page');
          const parent=op.parentId ? await node(op.parentId,refs) : n.parent;
          if(!parent||!('appendChild' in parent))throw Error('Invalid parent');
          place(parent,n,op.index);
          await props(n,p);
          if(op.ref)refs['$'+op.ref]=n;
        } else {
          n=await node(op.id,refs);
          if(n.type==='PAGE')throw Error('Cannot modify page');
          if(op.action==='update') await props(n,p);
          else if(op.action==='delete')n.remove();
          else if(op.action==='select'){await showNode(n);}
          else throw Error('Unknown action');
        }
        const r={id:n.id,action:op.action}; if(op.ref)r.ref=op.ref; if(extra)r.descendants=extra;
        results.push(r);
      }
      figma.commitUndo();
      figma.ui.postMessage({id:job.id,result:results});
    } else throw Error('Unknown command');
  } catch(e) {figma.commitUndo();figma.ui.postMessage({id:job.id,error:String(e.message||e),completed:results,failedIndex:results.length,partialChangesPossible:true});}
  finally {busy=false;}
};

function sendBridgeInfo(){let key="";try{key=figma.fileKey||"";}catch(_){}figma.ui.postMessage({type:"info",file:figma.root.name,page:figma.currentPage.name,fileKey:key});}
figma.on("currentpagechange",sendBridgeInfo);
setInterval(sendBridgeInfo,2000);
sendBridgeInfo();
