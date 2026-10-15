/* 中枢神经切面分离 · 交互式教学系统
   vendor.js 提供 THREE / OrbitControls / GLTFLoader */
const view = document.getElementById('view');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xF7F7F5);

const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 3000);
const renderer = new THREE.WebGLRenderer({antialias: true, logarithmicDepthBuffer: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

/* 灯光与 Blender 建模时完全一致：6 盏平行光（位置/强度照搬 .blend 里的灯）+
   世界环境光，并按 Blender 的曝光 -0.35 整体压暗，色彩才和建模时一致。
   Blender 是 Z 向上，导出时转成了 Y 向上：(x,y,z) -> (x, z, -y)。 */
const EXPO = Math.pow(2, -0.35);                 // Blender view_settings.exposure = -0.35
scene.add(new THREE.AmbientLight(0x6E7177, 0.9 * Math.PI * EXPO));   // world 背景色 #6E7177 / 0.9
for(const [p, e] of [
  [[-16, -22, 26], 0.8],    // 主光前上
  [[  28,   6,  8], 0.5],   // 右侧光
  [[ -28,   6,  8], 0.5],   // 左侧光
  [[   2,  28, 14], 0.45],  // 背光
  [[  18, -14, 18], 0.55],  // 补光前右
  [[   0,   0, 40], 0.3],   // 顶光
]){
  const l = new THREE.DirectionalLight(0xffffff, e * EXPO);
  l.position.set(p[0], p[2], -p[1]);
  scene.add(l);
}

let DATA = null, CUR = null;
const glbCache = {};
const root = new THREE.Group(); scene.add(root);
let holder = null, lvG = [];
let recs = [];                 // {obj, meta, base}
let yStack = [], yNat = [];
const state = {seg: {}, kind: {}, tissue: {}, tissue3d: false,
               hidden: new Set(), fade: new Set(),
               // soft：整类「半透明」（颅骨 / 肌肉）——看得见轮廓与位置关系，
               // 又不像「透明」那样几乎全没，方便看清鼓索之类穿行结构
               soft: new Set(),
               iso: null, isoLabel: '',
               // focus：通路追踪时选中的那一条通路（主干+分支+神经节）。
               // 与 iso 的区别：**什么都不隐藏**，只是把其余结构调成半透明，
               // 这样既看得清这条通路，又能靠旁边的骨/肌/脑判断它的位置关系。
               focus: null,
               opa: 0.24, gap: 0,
               drag: false, dragP: {}, dragO: new Map(),
               shellSolid: false,
               sel: null, hover: null, level: null, tract: null, names: new Map()};
const DOT_R = 0.24;            // 移动光点半径（用户要求「放大一点」）
/* 资源版本号：data.json 与 *.glb 不带版本时会被浏览器按「启发式规则」缓存很久，
   模型重导后网页仍显示旧网格（例如视神经看着还是两条）。改模型后把这个号 +1，
   强制重新下载。index.html 里的 app.js?v= 也要同步 +1。 */
const ASSET_V = '10r1';
let sig = null, sigPts = [], sigT = 0, playing = false;
let sigCurve = null, sigLine = null, sigArc = null;
let sigMarks = [], sigHold = 0, sigPulse = null, sigHoldKind = null;
let sigIsFiber = false, sigFiberWps = [], sigFiberSt = [], sigNextStop = 0;
let sigUp = true, sigStops = [], sigBase = '';
let sigReflex = false;      // 当前播放的是否为反射弧（决定是否按纤维性质给光点换色）
/* ---------- 腺体分泌 ----------
   只有**控制分泌的副交感节后纤维**到达腺体时才分泌；只含感觉纤维经过腺体的
   （如三叉神经泪腺神经、面神经穿腮腺）不分泌 —— 判据就是站点数据里的 sec 字段。 */
let drops = [];                       // 正在下落的液滴
let glandGlow = null;                 // 正在发光的腺体
let secOn = null;                     // 持续分泌状态（一波一波往外冒）
const SEC_COLOR = {'泪液': 0x66C8EE, '唾液': 0xF2E2A0, '黏液': 0xD8EDE4};
function clearDrops(){
  for(const d of drops){
    root.remove(d.obj); d.obj.geometry.dispose(); d.obj.material.dispose();
  }
  drops = []; secOn = null;
  if(glandGlow && glandGlow.rec){
    glandGlow.rec.obj.material.emissive.setHex(0x000000);
    glandGlow.rec.obj.material.needsUpdate = true;
  }
  glandGlow = null;
}
function startSecretion(st){
  let rec = null;
  if(st.obj) rec = recs.find(x => x.meta && x.meta.n === st.obj) || null;
  let c, r0 = 0.3;
  if(rec){
    const bb = new THREE.Box3().setFromObject(rec.obj);
    c = bb.getCenter(new THREE.Vector3());
    const sz = bb.getSize(new THREE.Vector3());
    r0 = Math.max(sz.x, sz.y, sz.z) * 0.5;   // 腺体半径：液滴从表面往外冒，别埋在腺体内部
  } else c = sig ? sig.position.clone() : new THREE.Vector3();
  const col = SEC_COLOR[st.sec] || 0xBFE9FF;
  spawnDrops(c, col, 18, 0.34, r0);
  secOn = {c: c.clone(), col: col, r0: r0,
           till: performance.now() + 7000, next: performance.now() + 1000};
  if(rec){
    glandGlow = {rec: rec, till: performance.now() + 5600};
    rec.obj.material.emissive.setHex(0x6A5A20);
    rec.obj.material.needsUpdate = true;
  }
}
function spawnDrops(c, col, n, spread, r0){
  // 从腺体**表面**渗出：起点沿随机方向推到腺体半径外，再缓缓下滑。
  // 起点若在腺体质心，液滴会整个被腺体包住，根本看不见「眼泪」。
  const R = r0 || 0.3;
  for(let i = 0; i < n; i++){
    const dir = new THREE.Vector3(Math.random() - 0.5, (Math.random() - 0.5) * 0.5,
                                  Math.random() - 0.5).normalize();
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.10, 14, 12),
      new THREE.MeshBasicMaterial({color: col, transparent: true, opacity: 0.95}));
    m.position.copy(c).addScaledVector(dir, R * (0.95 + Math.random() * 0.4));
    m.renderOrder = 32; root.add(m);
    drops.push({obj: m, t: 0, life: 4.2 + Math.random() * 1.8,
                v: new THREE.Vector3(dir.x * 0.16, -0.12 - Math.random() * 0.10,
                                     dir.z * 0.16)});
  }
}
/* 通路一开始就把「起核」（这条神经/通路的起始核团）高亮闪一下，
   否则用户看不出它是从哪儿发出来的。 */
let sigNuc = null;
/* 分支分发：主光点走到带分支的航点时，分成几束随各分支发出去，挨个标注分支名。
   换元神经节：到站时该神经节高亮闪烁（绿），旁白说明「在哪换元、换元前后纤维去向」。 */
let sigBranch = null, sigBranchAt = new Map(), sigBranchDone = new Set();
let sigNucIdx = -1;
const WHITE_COL = new THREE.Color(0xFFFFFF);

/* ---------- 载入 ---------- */
const loadEl = document.getElementById('load');
function showLoad(txt){ loadEl.style.display = 'flex'; loadEl.innerHTML = txt; }
function hideLoad(){ loadEl.style.display = 'none'; }

fetch('data.json?v=' + ASSET_V).then(r => r.json()).then(d => {
  DATA = d;
  buildNav();
  const h = (location.hash || '').replace('#', '').toUpperCase();
  switchModel(h === 'B' ? 'B' : 'A');
}).catch(e => {
  showLoad('数据载入失败：' + e.message +
    '<br><span style="font-size:12px;opacity:.75">本页需要通过 HTTP 打开（浏览器禁止 file:// 读取本地数据文件）。' +
    '<br>请运行同目录下的 <b>启动.bat</b>，或在 output/web2 目录执行：<br>' +
    '<code>python -m http.server 8000</code> 后访问 http://localhost:8000</span>');
});

function buildNav(){
  // 模型目录收进下拉框，顶部只留「建模 / 单束模型 / 装配-切面分离 / 视图」四项
  const selM = document.getElementById('selModel');
  selM.innerHTML = '';
  DATA.models.forEach(m => {
    if(m.single) return;
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.title + ' · ' + m.counts.objects + ' 个结构';
    selM.appendChild(o);
  });
  selM.onchange = () => { if(selM.value) switchModel(selM.value); };

  const sel = document.getElementById('selTract');
  sel.innerHTML = '<option value="">单束模型：每对纤维束一个…</option>';
  DATA.models.forEach(m => {
    if(!m.single) return;
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.title + '（' + (m.dirText || '') + '） · ' +
                    m.counts.objects + ' 个结构';
    sel.appendChild(o);
  });
  sel.onchange = () => { if(sel.value) switchModel(sel.value); };

  // 「视图」下拉：拖拽分离 / 复原 / 重置视角
  const menu = document.getElementById('menuView');
  const bm = document.getElementById('bViewMenu');
  bm.onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
  document.addEventListener('click', () => menu.classList.remove('open'));
}

function switchModel(mid){
  const _ms = document.getElementById('selModel');
  if(_ms) _ms.value = (DATA.models.find(x => x.id === mid) || {}).single ? '' : mid;
  const _sel = document.getElementById('selTract');
  _sel.value = (DATA.models.find(x => x.id === mid) || {}).single ? mid : '';
  const M = DATA.models.find(m => m.id === mid);
  CUR = M;
  state.sel = null; state.hidden.clear(); state.fade.clear(); state.soft.clear();
  state.focus = null;
  state.iso = null; state.isoLabel = '';
  state.level = null; state.tract = null;
  state.seg = {}; state.kind = {}; state.tissue = {}; state.tissue3d = false;
  M.groups.forEach(g => state.seg[g.key] = true);
  M.kinds.forEach(k => state.kind[k.key] = true);
  (M.tissues || []).forEach(t => state.tissue[t.key] = true);
  // 切面类模型（B / 单束派生）默认隐藏「网状结构」：脑干网状结构是弥散灰质，
  // 15 张切面里每张都有 20~30 项，全部堆在切面上会让核团与纤维束糊成一片
  // （用户反馈的「杂乱无章」）。需要时在左栏「按类别显示」里勾回来即可。
  if(mid === 'B' || M.single || M.sec) state.kind['网状结构'] = false;
  clearSignal();
  buildLeft(); buildLevelPanel(); buildTractPanel(); renderInfo(null);
  updateIsoBar();
  document.getElementById('hdrSub').textContent = M.sub;

  // 缓存的是原始 ArrayBuffer 而不是解析好的 scene：setup() 里会把 mesh 用 attach()
  // 搬到各层面组，复用同一棵 scene 树会让第二次切换拿到空树（recs=0、模型白屏）。
  const buf = glbCache[mid];
  if(buf){ parseGLB(buf); return; }
  showLoad('正在载入 ' + M.glb + ' …');
  new THREE.FileLoader().setResponseType('arraybuffer').load(M.glb + '?v=' + ASSET_V,
    b => { glbCache[mid] = b; parseGLB(b); },
    p => { if(p.total) showLoad('载入 ' + Math.round(p.loaded / p.total * 100) + '%'); },
    e => showLoad('模型载入失败：' + (e && e.message ? e.message : e)));

  function parseGLB(b){
    new GLTFLoader().parse(b, '',
      g => setup(g.scene),
      e => showLoad('模型解析失败：' + (e && e.message ? e.message : e)));
  }
}

function clearRoot(){
  if(holder){ root.remove(holder); }
  recs = []; lvG = []; holder = null;
  for(let i = root.children.length - 1; i >= 0; i--) root.remove(root.children[i]);
}

/* 顶点色是否是「真实纹理」而不是一个统一底色 */
function hasTextureVcol(geo){
  const c = geo.attributes.color;
  if(!c) return false;
  const arr = c.array;
  const step = Math.max(1, Math.floor(c.count / 400));
  let mn = [9, 9, 9], mx = [-9, -9, -9];
  for(let i = 0; i < c.count; i += step){
    for(let k = 0; k < 3; k++){
      const v = arr[i * (c.itemSize || 3) + k];
      if(v < mn[k]) mn[k] = v;
      if(v > mx[k]) mx[k] = v;
    }
  }
  return (mx[0] - mn[0]) + (mx[1] - mn[1]) + (mx[2] - mn[2]) > 0.06;
}

function setup(src){
  clearRoot();
  holder = new THREE.Group(); root.add(holder); holder.add(src);

  const meta = new Map(CUR.objects.map(o => [o.n, o]));
  // glTF 导出时会把节点名里的 "." 去掉（"X.001" -> "X001"），所以再建一张宽松表
  const metaLoose = new Map(CUR.objects.map(o => [o.n.replace(/\./g, ''), o]));
  const nLv = CUR.levels.length;
  for(let i = 0; i < nLv; i++){ const g = new THREE.Group(); root.add(g); lvG.push(g); }

  const found = [];
  src.traverse(o => { if(o.isMesh) found.push(o); });

  let matched = 0;
  for(const o of found){
    let m = meta.get(o.name);
    if(!m) m = meta.get(o.name.replace(/\.\d+$/, ''));
    if(!m) m = metaLoose.get(o.name.replace(/\./g, ''));
    if(!m){ o.visible = false; continue; }       // 未在清单里的重复/散落对象
    matched++;
    // 纤维束：GLB 里那份是「自然位置」下的固定管路，一改拆解间距就对不上层面。
    // 这里丢掉它，改由 buildFiberMeshes() 按各层面当前位置实时重建连续细管。
    if(m.wps){ o.visible = false; continue; }
    if(!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const vcol = !!m.vc || hasTextureVcol(o.geometry);
    o.material = makeMat(m, vcol);
    o.userData.base = o.material.color.clone();
    o.userData.meta = m;
    o.renderOrder = (m.k === '外壳') ? 10 : 0;
    lvG[Math.max(0, Math.min(nLv - 1, m.lv - 1))].attach(o);
    recs.push({obj: o, meta: m, base: o.material.color.clone(),
               basePos: o.position.clone()});
  }
  buildFiberMeshes();

  yNat = CUR.levels.map(l => l.y);
  yStack = stackY(CUR.levels.map(l => l.t), yNat);
  state.gap = (CUR.asmMode === 'stack') ? 1.0 : 0.0;
  applyGap(); applyVis();
  frameAll();
  hideLoad();
  setGap(state.gap);          // 同步滑块读数与「装配 / 切面分离」按钮状态
}

function stackY(ts, nat){
  const out = [0];
  for(let i = 1; i < ts.length; i++) out[i] = out[i - 1] + (ts[i - 1] + ts[i]) / 2;
  const a = (out[0] + out[out.length - 1]) / 2;
  const b = (nat[0] + nat[nat.length - 1]) / 2;
  return out.map(v => v - a + b);
}

function makeMat(m, vcol){
  if(m.k === '外壳')
    return new THREE.MeshStandardMaterial({color: new THREE.Color(m.c), transparent: true,
      opacity: state.shellSolid ? 1.0 : state.opa, roughness: 0.72, metalness: 0,
      side: THREE.DoubleSide, depthWrite: state.shellSolid});
  // 脑室系统：腔道，半透明青色，透过脑外壳一眼能看到
  if(m.k === '脑室')
    return new THREE.MeshStandardMaterial({color: new THREE.Color(m.c), transparent: true,
      opacity: 0.62, roughness: 0.28, metalness: 0.0, side: THREE.DoubleSide,
      depthWrite: false, emissive: new THREE.Color(m.c), emissiveIntensity: 0.18});
  // 脑干分部（中脑 / 脑桥 / 延髓 / 间脑）与延髓背景壳：必须半透明，
  // 否则一层实心的「脑干」把里面的 56 个核团全挡住 —— 用户说的「脑干糊成一团」。
  if(m.k === '脑分部')
    return new THREE.MeshStandardMaterial({color: new THREE.Color(m.c), transparent: true,
      opacity: 0.14, roughness: 0.7, metalness: 0, side: THREE.DoubleSide,
      depthWrite: false});
  if(vcol)
    return new THREE.MeshStandardMaterial({color: 0xffffff, vertexColors: true,
      roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide});
  return new THREE.MeshStandardMaterial({color: new THREE.Color(m.c),
    roughness: 0.55, metalness: 0.03});
}

/* ---------- 拆解 ---------- */
function applyGap(){
  const n = yNat.length;
  const mid = (yNat[0] + yNat[n - 1]) / 2;
  const s = state.gap;
  for(let i = 0; i < n; i++){
    let y;
    if(s <= 1){
      const a = (CUR.asmMode === 'stack') ? yStack[i] : yNat[i];
      y = a + (yNat[i] - a) * s;
    }else{
      y = yNat[i] + (yNat[i] - mid) * (s - 1);
    }
    // 叠加手动拖拽量（三维自由拖动，不再只沿堆叠轴）
    const p = state.dragP[i] || {x: 0, y: 0, z: 0};
    lvG[i].position.set(p.x, y - yNat[i] + p.y, p.z);
  }
  applyObjOffsets();
  rebuildFibers();
  rebuildSignal();
}

/* 单个结构的独立位移 —— 用户要求「拖拽分离时每个结构都能完全独立分开」。
   层面（整层）位移由上面的 gap / dragP 控制；这里再叠加每个结构自己的偏移，
   于是同一层面里的核团、纤维、脑室都能一个一个拖开。 */
function applyObjOffsets(){
  for(const r of recs){
    const d = state.dragO.get(r.meta.n);
    if(!d){ if(r.obj.userData.moved){ r.obj.position.copy(r.basePos);
              r.obj.userData.moved = false; } continue; }
    r.obj.position.set(r.basePos.x + d.x, r.basePos.y + d.y, r.basePos.z + d.z);
    r.obj.userData.moved = true;
  }
}

/* ---------- 纤维束：按「各层面当前位置」实时重建连续细管 ----------
   模型里一条通路就是一条连续的曲线；拆解间距/手动拖动一变，
   就用航点 + 层面当前位移重算一次，纤维永远跟着自己的切面走。      */
function lvPos(lv){
  const g = lvG[Math.max(0, Math.min(lvG.length - 1, lv - 1))];
  return g ? g.position : {x: 0, y: 0, z: 0};
}
/* 航点按「传导方向」排列。
   建模时 wps 一律按 z 升序（脊髓端 → 皮质端），所以：
     up  （上行：脊髓/小脑 → 皮质）保持原序；
     down（下行：皮质 → 脊髓）    反转。
   不反转的话下行通路的光点会从脊髓往皮质走 —— 就是用户看到的「下行纤维倒放」。
   st（逐站结构名）与 wps 同序，必须一起重排。 */
/* 12 对脑神经的传导方向 —— 感觉神经**入脑**、运动神经**出脑**。
   混合性神经同一主干里两种纤维方向相反：默认播运动（出脑），
   用户点了「感觉纤维·入脑」就整条反过来，并换成感觉核那一套站名。 */
function cnFlowOf(m){
  if(!m) return 'eff';
  if(m.flow === 'afferent') return 'aff';
  if(m.flow === 'both')
    return (state.sel && state.sel.flow === 'aff') ? 'aff' : 'eff';
  return 'eff';
}
function fiberOrder(m){
  const w = m.wps || [], s = m.st || [];
  if(m.cn){
    if(m.flow === 'both' && cnFlowOf(m) === 'aff'){
      const stA = (m.stAff && m.stAff.length === w.length)
        ? m.stAff : s.slice().reverse();
      return {w: w.slice().reverse(), st: stA};
    }
    return {w: w, st: (m.flow === 'both' && m.stEff) ? m.stEff : s};
  }
  const idx = w.map((_, i) => i);
  if(m.dir === 'down') idx.reverse();
  return {w: idx.map(i => w[i]), st: idx.map(i => s[i] || null)};
}
function baseOf(name){
  return String(name || '').replace(/^纤维束[·・]?/, '')
    .replace(/[（(][^）)]*[）)]\s*$/, '').trim();
}
function fiberPts(m){
  return fiberOrder(m).w.map(w => {
    const p = lvPos(w[0]);
    // Blender (x,y,z) -> three.js (x, z, -y)
    return new THREE.Vector3(w[1] + p.x, w[3] + p.y, -w[2] + p.z);
  });
}
function fiberSeg(pts){ return Math.max(28, Math.min(150, pts.length * 5)); }
function fiberGeo(pts, rad){
  const c = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  return new THREE.TubeGeometry(c, fiberSeg(pts), rad || 0.02, 10, false);
}
/* 参数 t → 弧长比例 u 的换算表（每个航点 i 对应的弧长比例 = out[i]）。
   为什么要它：CatmullRomCurve3.getPoint(t) 是**按「段」均匀**取参数 —— 航点疏密
   不均时（脑神经主干上相邻两站有时差十几倍距离），光点就会「一段慢慢爬、一段
   猛地窜」，看着一卡一卡。改成 getPointAt(u)（按弧长等分）才能匀速。
   到站判定仍然按「第 i 站」，所以把每站的参数换成它对应的弧长比例存下来。 */
function arcParams(curve, n){
  const N = Math.max(400, n * 120), cum = [0];
  let prev = curve.getPoint(0), L = 0;
  for(let k = 1; k <= N; k++){
    const p = curve.getPoint(k / N);
    L += p.distanceTo(prev); prev = p; cum.push(L);
  }
  const total = L || 1, out = [];
  for(let i = 0; i <= n; i++){
    const f = (i / n) * N, j = Math.min(N - 1, Math.floor(f)), g = f - j;
    out.push((cum[j] + (cum[j + 1] - cum[j]) * g) / total);
  }
  return out;
}
function buildFiberMeshes(){
  if(!CUR || !CUR.objects) return;
  for(const m of CUR.objects){
    if(!m.wps) continue;
    const pts = fiberPts(m);
    if(pts.length < 2) continue;
    const mat = new THREE.MeshStandardMaterial({color: new THREE.Color(m.c),
      roughness: 0.52, metalness: 0.03});
    const mesh = new THREE.Mesh(fiberGeo(pts, m.rad), mat);
    mesh.userData.meta = m;
    root.add(mesh);
    recs.push({obj: mesh, meta: m, base: mat.color.clone(),
               basePos: new THREE.Vector3()});
  }
}
function rebuildFibers(){
  for(const r of recs){
    if(!r.meta.wps) continue;
    const pts = fiberPts(r.meta);
    if(pts.length < 2) continue;
    r.obj.geometry.dispose();
    r.obj.geometry = fiberGeo(pts, r.meta.rad);
  }
}

/* ---------- 显隐 ---------- */
// 「神经类」结构：单独显示时它们一并隐藏（颅骨/肌肉/脑等非神经结构保留但半透明）
const NEURAL_KINDS = ['脑神经', '分支', '神经节', '核团', '反射弧'];
// 这两类在左栏额外给一个「半透明」键（骨 / 肌是包裹神经的，半透明才看得清走行）
const SOFT_KINDS = ['颅骨', '肌肉'];

/* ---------- 结构类型（严格区分，见 cn_defs 注释）----------
   感觉神经节 —— 第一级感觉神经元胞体，**不换元**
   自主神经节 —— 副交感节后神经元胞体，**换元站**
   脑干感觉核 —— 第一级感觉纤维的中枢换元处
   脑干运动核 / 脑干副交感核 —— 传出纤维的起始核 */
const TYPE_INFO = {
  '感觉':      {name: '感觉神经节', color: '#5BA8D0', note: '第一级感觉神经元胞体所在，此处不换元'},
  '副交感':    {name: '自主神经节', color: '#F2A93B', note: '副交感节后神经元胞体所在，节前纤维在此换元'},
  '运动核':     {name: '脑干运动核', color: '#D64545', note: '一般/特殊内脏运动的起始核'},
  '感觉核':     {name: '脑干感觉核', color: '#2E86DE', note: '第一级感觉纤维的中枢换元处（第二级神经元）'},
  '副交感核':   {name: '脑干副交感核', color: '#F2A93B', note: '副交感节前纤维的起始核'},
};
/* 返回某个结构的「类型标签」（感觉神经节 / 自主神经节 / 脑干感觉核 / 脑干运动核…） */
function structType(m){
  if(!m) return null;
  if(m.k === '神经节') return TYPE_INFO[m.gtype === '副交感' ? '副交感' : '感觉'];
  if(m.k === '核团' && m.ntype) return TYPE_INFO[m.ntype] || null;
  return null;
}

function applyVis(){
  for(const r of recs){
    const m = r.meta;
    let vis = state.seg[m.seg] !== false && state.kind[m.k] !== false &&
              !state.hidden.has(m.n);
    if(state.level !== null && m.lv !== state.level) vis = vis && false;
    if(state.iso){
      if(state.iso.has(m.n)) vis = true;                 // 被单独显示的那条（对）神经
      else if(NEURAL_KINDS.indexOf(m.k) >= 0) vis = false;  // 其余脑神经 / 分支 / 神经节 隐藏
      else vis = true;                                   // 颅骨、肌肉、脑等保留，但半透明
    }
    r.obj.visible = vis;
  }
  applyFade();
  refreshHighlight();
}

/* ---------- 半透明（左侧「半透明」键 / 单个结构「透明」键 / 单独显示）----------
   两类透明要分开：
     · 整类「半透明」（颅骨 / 肌肉）：opacity = SOFT_OPA，**看得见轮廓**——
       既能看清里面穿行的神经（鼓索、鼓室神经…），又不丢掉位置关系；
     · 单个结构「透明」/「单独显示」：opacity = 0.12，几乎看不见，只当背景。
   点「复原」恢复实体。 */
const SOFT_OPA = 0.42;
function applyFade(){
  for(const r of recs){
    const mt = r.obj.material;
    if(!mt) continue;
    // 外壳的不透明度由左侧滑块 / 「外脑壳」按钮控制；脑干分部/背景壳本来就是半透明的，
    // 脑室是腔道、也固定半透明 —— 不能让它们在这里被「恢复实体」，
    // 否则又糊成一团盖住里面的核团 / 看不见脑室。
    if(r.meta.k === '外壳' || r.meta.k === '脑分部' || r.meta.k === '脑室') continue;
    const on = state.fade.has(r.meta.n) ||
               (!!state.iso && !state.iso.has(r.meta.n) && NEURAL_KINDS.indexOf(r.meta.k) < 0) ||
               (state.level !== null &&
                (r.meta.k === '颅骨' || r.meta.k === '肌肉' || r.meta.k === '器官'));
    // 通路追踪：本通路以外的结构（含其它脑神经）不隐藏，只转半透明 ——
    // 既能看清选中的那条通路，又能靠旁边的骨 / 肌 / 脑判断它的位置关系。
    const dim = !!state.focus && !state.focus.has(r.meta.n) && !state.fade.has(r.meta.n);
    if(state.soft.has(r.meta.k) || dim){
      mt.transparent = true; mt.opacity = SOFT_OPA; mt.depthWrite = false;
    }else if(on){
      mt.transparent = true; mt.opacity = 0.12; mt.depthWrite = false;
    }else if(mt.transparent){
      mt.transparent = false; mt.opacity = 1; mt.depthWrite = true;
    }
    mt.needsUpdate = true;
  }
}

/* 统一切换当前选中结构的「透明 / 实体」 */
function toggleFade(m){
  if(!m) return;
  if(state.fade.has(m.n)) state.fade.delete(m.n);
  else { state.fade.add(m.n); state.hidden.delete(m.n); }
  applyVis();
  renderInfo(m);
}

/* ---------- 单独显示（焦点模式）----------
   用户要求：单击某一脑神经 → 其他脑神经全部消失，颅骨 / 肌肉 / 脑等其余结构半透明，
   鼠标移到哪条分支就在旁边显示分支名；点「复原」一键回到原样。
   ——用一份「保留名单」实现：名单里的结构照常显示，其余按类别走隐藏 / 半透明。 */
function isoMembers(m){
  // 一条脑神经的「整棵树」：主干 + 全部（一级/二级）分支 + 换元神经节 + 起始核团
  const s = new Set([m.n]);
  for(const b of (m.branches || [])) if(b.obj) s.add(b.obj);
  for(const st of (m.st || []))
    if(st.obj && (st.k === 'ganglion' || st.k === 'nucleus')) s.add(st.obj);
  return s;
}
function ownerNerveOf(m){
  // 分支 / 神经节 → 找出它属于哪条脑神经（分支挂在 branches，神经节挂在 st）
  if(!CUR || !CUR.objects) return null;
  return CUR.objects.find(o => o.k === '脑神经' && (
           (o.branches || []).some(b => b.obj === m.n) ||
           (o.st || []).some(s => s.obj === m.n))) || null;
}
function setIso(set, label){
  state.iso = (set && set.size) ? set : null;
  if(state.iso) state.focus = null;      // 显式「单独显示」优先，清掉通路追踪的半透明
  state.isoLabel = label || '';
  applyVis();
  updateIsoBar();
}
function updateIsoBar(){
  const el = document.getElementById('pickbar');
  if(!el) return;
  if(!state.iso){ el.innerHTML = ''; return; }
  el.innerHTML = '<div class="isobar"><b>单独显示</b><span>' + esc(state.isoLabel) +
    '</span><button class="btn" id="bIsoOff">复原</button></div>';
  el.querySelector('#bIsoOff').onclick = () => { setIso(null); renderInfo(null); };
}
/* 点击某个结构时的「单独显示」：脑神经整棵留着；分支/神经节连它所属神经一起留；
   核团等其他结构只留它自己。其余脑神经隐藏、颅骨肌肉脑半透明。 */
function focusObject(m){
  if(!m) return;
  if(m.k === '脑神经'){
    setIso(isoMembers(m), m.f);
  }else if(m.k === '反射弧'){
    const r = (CUR.reflexes || []).find(x => m.n.indexOf(x.n + '·') === 0);
    if(r){ const s = new Set((r.segs || []).map(x => x.name)); s.add(m.n);
           setIso(s, r.d); }
    else setIso(new Set([m.n]), m.f);
  }else if(m.k === '分支' || m.k === '神经节'){
    const own = ownerNerveOf(m);
    if(own){ const s = isoMembers(own); s.add(m.n); setIso(s, own.f + ' · ' + m.f); }
    else setIso(new Set([m.n]), m.f);
  }else{
    setIso(new Set([m.n]), m.f);
  }
  // 顺带把镜头推近到「这一整组」结构（一条神经 + 它的分支 + 神经节），
  // 否则整颗头那么大，看不出这条神经到底怎么走、发出哪些分支。
  const b = new THREE.Box3();
  let hit = 0;
  for(const r of recs){
    if(!state.iso || !state.iso.has(r.meta.n)) continue;
    b.expandByObject(r.obj); hit++;
  }
  if(hit){
    const sz = b.getSize(new THREE.Vector3());
    flyTo(b.getCenter(new THREE.Vector3()),
          Math.max(sz.x, sz.y, sz.z) * 0.95 + 1.5);
  }
}
function focusMany(ms, label){
  const s = new Set();
  for(const m of ms){
    if(m.k === '脑神经') isoMembers(m).forEach(x => s.add(x));
    else s.add(m.n);
  }
  setIso(s, label || (ms.length + ' 个结构'));
}
function baseKeyOf(s){
  return String(s || '').replace(/§.*$/, '').replace(/^核团·/, '')
    .replace(/[（(][左右][）)]$/, '').replace(/[左右]$/, '').replace(/\d+$/, '').trim();
}

function refreshHighlight(){
  const GRAY = new THREE.Color(0xDCDCD6);
  for(const r of recs){
    const m = r.meta;
    let col = r.base.clone(), emi = 0x000000;
    if(state.sel){
      const on = (state.sel.kind === 'tract')
        ? state.sel.test(m) : (m.n === state.sel.key);
      if(on){ col.set(0xFF6B35); emi = 0x662200; }
      else if(state.sel.kind === 'tract'){ col.lerp(GRAY, 0.55); }
    }
    if(state.hover === m.n && !state.sel){ emi = 0x333333; }
    r.obj.material.color.copy(col);
    r.obj.material.emissive.setHex(emi);
  }
}

/* ---------- 左侧控制栏 ---------- */
/* 类别按「灰质 → 白质 → 其他」归组排列。
   用户反馈「白质纤维束和灰质核团混在一起，不好辨别、看着很乱」——
   原来类别表按数据里的出现顺序排，灰白质交错；这里固定顺序 + 分组小标题，
   灰质核团挨在一起、白质纤维束挨在一起，一眼能分清。 */
const KIND_ORDER = ['核团', '网状结构', '皮质', '灰质',
                    '传导束', '纤维束', '交叉', '白质',
                    '脑神经', '分支', '反射弧', '神经节',
                    '腺体', '肌肉', '器官', '脑室',
                    '切面', '外壳', '脑分部', '颅骨', '结构'];
const KIND_GROUP = {
  '核团': '灰质（神经元胞体）', '网状结构': '灰质（神经元胞体）',
  '皮质': '灰质（神经元胞体）', '灰质': '灰质（神经元胞体）',
  '传导束': '白质（纤维束）', '纤维束': '白质（纤维束）',
  '交叉': '白质（纤维束）', '白质': '白质（纤维束）',
  '脑神经': '脑神经与神经节', '分支': '脑神经与神经节',
  '反射弧': '脑神经与神经节', '神经节': '脑神经与神经节',
  '腺体': '效应器', '肌肉': '效应器', '器官': '效应器',
  '脑室': '范围与背景', '切面': '范围与背景', '外壳': '范围与背景',
  '脑分部': '范围与背景', '颅骨': '范围与背景', '结构': '范围与背景',
};

/* 左栏按当前模型显示对应的功能块。
   data-m 里列出「本块适用于哪些模型」：A / B / C / D / S（S = 单束派生模型）。
   不同模型的可用功能差别很大（外脑壳只对 A 有意义、结构类型图例只对 C/D 有意义），
   全列出来才是「杂乱」的根源。 */
function applyLeftForModel(mid, single){
  const key = single ? 'S' : mid;
  document.querySelectorAll('#left [data-m]').forEach(el => {
    const list = String(el.dataset.m || '').split(',');
    el.style.display = list.indexOf(key) >= 0 ? '' : 'none';
  });
  // 组标题：本组内所有内容块都被隐藏时，标题也一起隐藏
  document.querySelectorAll('#left .grp').forEach(g => {
    let n = g.nextElementSibling, has = false;
    while(n && !n.classList.contains('grp')){
      if(n.style.display !== 'none') has = true;
      n = n.nextElementSibling;
    }
    g.style.display = has ? '' : 'none';
  });
}

function buildLeft(){
  // 脊髓横切面模型（sec）也归到「切面类模型」那一套左栏功能里
  applyLeftForModel(CUR.id, !!CUR.single || !!CUR.sec);

  const S = document.getElementById('segList'); S.innerHTML = '';
  CUR.groups.forEach(g => {
    const on = state.seg[g.key] !== false;
    S.insertAdjacentHTML('beforeend',
      `<div class="row"><label><input type="checkbox" class="chk" data-seg="${g.key}"` +
      (on ? ' checked' : '') + `>
       <span class="sw" style="background:#8FA8BF"></span><span class="nm">${g.name}</span></label>
       <span class="small">${g.count}</span></div>`);
  });
  S.querySelectorAll('[data-seg]').forEach(el => el.onchange = e => {
    state.seg[e.target.dataset.seg] = e.target.checked; applyVis();
  });

  const K = document.getElementById('kindList'); K.innerHTML = '';
  // 颅骨 / 肌肉给一个「半透明」键：整类变成半透明（不是全透明）——
  // 既看得清里面穿行的神经（鼓索、鼓室神经、腮腺内穿行的面神经分支…），
  // 又保留轮廓以判断通路与骨、肌的位置关系。
  const kk = CUR.kinds.slice().sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a.key), ib = KIND_ORDER.indexOf(b.key);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  let lastGrp = null;
  kk.forEach(k => {
    const gname = KIND_GROUP[k.key];
    if(gname && gname !== lastGrp){
      K.insertAdjacentHTML('beforeend',
        `<div class="kgrp">${gname}</div>`);
      lastGrp = gname;
    }
    const sf = SOFT_KINDS.indexOf(k.key) >= 0;
    const on = state.kind[k.key] !== false;
    K.insertAdjacentHTML('beforeend',
      `<div class="row"><label><input type="checkbox" class="chk" data-kind="${k.key}"` +
      (on ? ' checked' : '') + `>
       <span class="nm">${k.name}</span></label>
       <span class="small">${k.count}</span>` +
      (sf ? `<button class="btn softbtn" data-soft="${k.key}"
              title="整类变半透明（不是全透明）：看得见轮廓，又能看清里面穿行的神经"
              >半透明</button>` : '') + `</div>`);
  });
  K.querySelectorAll('[data-kind]').forEach(el => el.onchange = e => {
    state.kind[e.target.dataset.kind] = e.target.checked; applyVis();
  });
  K.querySelectorAll('[data-soft]').forEach(el => {
    el.classList.toggle('hot', state.soft.has(el.dataset.soft));
    el.onclick = () => {
      const key = el.dataset.soft;
      if(state.soft.has(key)) state.soft.delete(key);
      else state.soft.add(key);
      el.classList.toggle('hot', state.soft.has(key));
      applyVis();
    };
  });

  // 结构类型图例：感觉神经节 / 自主神经节 / 脑干感觉核 / 脑干运动核 / 脑干副交感核
  // —— 用户要求「必须清晰区分并标注」，这里把四类结构连同成员一次列清。
  const TY = document.getElementById('typeList');
  if(TY){
    TY.innerHTML = '';
    const tys = CUR.types || [];
    if(!tys.length){
      TY.innerHTML = '<div class="small">本建模未做结构类型区分</div>';
    }
    tys.forEach(t2 => {
      TY.insertAdjacentHTML('beforeend',
        '<div class="trow"><span class="tdot" style="background:' + t2.color + '"></span>' +
        '<div><div class="tname">' + esc(t2.key) + '</div>' +
        '<div class="tnote">' + md(esc(t2.note)) + '</div>' +
        '<div class="titems">' + esc((t2.items || []).join('、')) + '</div></div></div>');
    });
  }

  // 组织（灰质 / 白质）——用户要求「一眼分清哪些属于灰质、哪些属于白质」
  const T = document.getElementById('tissueList'); T.innerHTML = '';
  const tis = CUR.tissues || [];
  if(!tis.length){
    T.innerHTML = '<div class="small">本建模未做组织标注</div>';
  }
  tis.forEach(t => {
    const on = state.tissue[t.key] !== false;
    T.insertAdjacentHTML('beforeend',
      `<div class="row"><label><input type="checkbox" class="chk" data-tissue="${t.key}"` +
      (on ? ' checked' : '') + `>
       <span class="sw" style="background:${t.color}"></span><span class="nm">${t.name}</span></label>
       <span class="small">${t.count}</span></div>`);
  });
  T.querySelectorAll('[data-tissue]').forEach(el => el.onchange = e => {
    state.tissue[e.target.dataset.tissue] = e.target.checked; applyVis();
  });
  const tb = document.getElementById('bTissue3D');
  tb.classList.toggle('hot', !!state.tissue3d);
  tb.onclick = () => {
    state.tissue3d = !state.tissue3d;
    tb.classList.toggle('hot', state.tissue3d);
    paintTissue();
  };
  paintTissue();
}

/* 「按组织着色」：把所有结构统一成灰质色 / 白质色，切面上一眼可辨 */
function paintTissue(){
  const GM = new THREE.Color('#9E8A76'), WM = new THREE.Color('#F0EADC');
  for(const r of recs){
    const m = r.meta;
    if(m.k === '切面' || m.k === '外壳') continue;
    if(state.tissue3d && m.t){
      r.obj.material.color.copy(m.t === '灰质' ? GM : WM);
    }else{
      r.obj.material.color.copy(r.base);
    }
  }
  refreshHighlight();
}

/* ---------- 右侧：层面浏览 / 通路追踪 ---------- */
function buildLevelPanel(){
  const P = document.getElementById('panelLevel'); P.innerHTML = '';
  CUR.levels.forEach((l, i) => {
    const ms = CUR.objects.filter(o => o.lv === l.no);
    const n = ms.length;
    // 同一「基名」的多个对象（左右侧成对、脊束核 1~9 段…）合成一个标签，
    // 否则 56 个核团铺开还是一屏糊 —— 点一下 = 把这一组一起聚焦。
    const grp = new Map();
    for(const o of ms){
      const k = baseKeyOf(o.d);
      if(!grp.has(k)) grp.set(k, []);
      grp.get(k).push(o);
    }
    const tags = grp.size
      ? '<div class="lvit">' + [...grp.entries()].map(([k, arr]) =>
          '<span class="lvtag" data-key="' + esc(k) + '">' + esc(k) +
          (arr.length > 1 ? '<span class="cnt">×' + arr.length + '</span>' : '') +
          '</span>').join('') + '</div>'
      : '';
    P.insertAdjacentHTML('beforeend',
      `<div class="card" data-lv="${l.no}">
         <div class="t">${l.name}<span class="tag">${l.seg}</span></div>
         <div class="d">${n} 个结构 · ${md(l.note)}</div>
         ${tags}
       </div>`);
  });
  // 成员标签：点一下 = 把这一组单独显示出来（其余脑神经隐藏、颅骨肌肉脑半透明）并飞过去
  P.querySelectorAll('.lvtag').forEach(el => el.onclick = ev => {
    ev.stopPropagation();
    const key = el.dataset.key;
    const ms = CUR.objects.filter(o => baseKeyOf(o.d) === key);
    if(!ms.length) return;
    state.level = null; state.hidden.clear();
    state.sel = {kind: 'tract', name: key, test: mm => ms.some(o => o.n === mm.n)};
    P.querySelectorAll('.card').forEach(c => c.classList.remove('on'));
    switchTab('info');
    focusMany(ms, key + '（' + ms.length + ' 个结构）');
    renderInfo(ms[0]);
    flyToMany(ms);
  });
  P.querySelectorAll('[data-lv]').forEach(el => el.onclick = () => {
    const no = +el.dataset.lv;
    state.level = (state.level === no) ? null : no;
    state.sel = null;
    state.focus = null;
    setIso(null);
    P.querySelectorAll('.card').forEach(c => c.classList.toggle('on', +c.dataset.lv === state.level));
    applyVis();
    const l = CUR.levels.find(x => x.no === no);
    if(state.level !== null){
      showInfo({title: l.name, tag: l.seg, desc: l.note,
                meta: '本层面共 ' + CUR.objects.filter(o => o.lv === no).length +
                      ' 个结构（点下方标签可把某一组单独显示出来看清）'});
      flyToLevel(no);
    }else renderInfo(null);
  });
}

// down=true：下行束，光点从皮质端往脊髓端走；否则为上行束，从脊髓端往皮质端走
const PATHS = [
  {name: '皮质脊髓束（运动·下行）', kw: ['皮质脊髓', '锥体交叉'], color: '#F0A500', down: true},
  {name: '内侧丘系（本体感觉·上行）', kw: ['内侧丘系', '薄束', '楔束', '丘系交叉'], color: '#2E86C1'},
  {name: '脊髓丘脑束（痛温觉·上行）', kw: ['脊髓丘脑'], color: '#28B463'},
  {name: '小脑脚（小脑环路）', kw: ['小脑上脚', '小脑中脚', '小脑下脚', '脑桥横行'], color: '#8E44AD'},
  {name: '脑干下行调制束', kw: ['红核脊髓', '前庭脊髓', '顶盖脊髓'], color: '#CB4335', down: true},
  {name: '皮质脑桥束', kw: ['额桥束', '顶枕颞桥'], color: '#D68910', down: true},
  {name: '听觉通路', kw: ['外侧丘系', '蜗神经', '下丘', '内侧膝状体'], color: '#17A589'},
  {name: '视觉通路', kw: ['上丘', '外侧膝状体', '视辐射', '丘脑后辐射'], color: '#7D3C98'},
];

/* 把「纤维束·皮质脊髓束(左/右)」按束名归并：一条束 = 一张卡，卡上分左右两个按钮。
   点左侧只让左侧那条走光点，点右侧同理 —— 不再左右来回跳。 */
function fiberGroups(){
  const map = new Map();
  for(const o of (CUR && CUR.objects ? CUR.objects : [])){
    // 纤维束（切面模型）与 12 对脑神经（脑神经模型）都用同一套航点+逐站数据
    if((o.k !== '纤维束' && o.k !== '脑神经') || !o.wps) continue;
    const mm = o.d.match(/^(.*?)[（(]([^）)]*)[）)]\s*$/);
    const base = (mm ? mm[1] : o.d).replace(/^纤维束[·・]?/, '');
    const txt = mm ? mm[2] : '';
    const side = txt.indexOf('左') >= 0 ? 'L' : (txt.indexOf('右') >= 0 ? 'R' : '');
    if(!map.has(base))
      map.set(base, {key: base, label: base, color: o.c, dir: o.dir || 'up',
                     dirText: o.dirText || '', flow: o.flow || '', sides: {}});
    map.get(base).sides[side] = o;
  }
  return [...map.values()].filter(g => Object.keys(g.sides).length);
}

function fiberLegendHTML(){
  const cols = (CUR && CUR.fiberColors) || FIBER_FALLBACK;
  const labs = (CUR && CUR.fiberLabels) || {};
  return '<div class="flx">' + Object.keys(cols).map(k =>
    '<span class="fl"><i style="background:' + cols[k] + '"></i>' +
    esc(String(labs[k] || k).replace(/（.*?）/, '')) + '</span>').join('') + '</div>';
}

/* 选一条反射弧：用「逐站 + 分色」的方式演示传入—换元—传出 */
function selectReflex(r){
  if(!r) return;
  const pseudo = {n: r.n, d: r.d, f: r.d, c: r.color, dir: 'down', cn: 1,
                  wps: r.wps, st: r.st, branches: [], reflex: true,
                  segs: r.segs || [], rad: 0.032, seg: '反射弧',
                  lv: CUR.reflexLv || 8,
                  kb: {desc: r.desc || '', sense: '反射弧', sys: '功能通路',
                       desc2: r.note || '', note: r.note || ''}};
  state.sel = {kind: 'tract', name: r.n, fiber: pseudo, test: x => x.n === r.n};
  state.level = null;
  state.focus = null;
  switchTab('tract');
  applyVis();
  showInfo({
    title: r.d,
    tag: '反射弧 · 功能纤维分色',
    desc: r.desc || '',
    body: fiberLegendHTML() + reflexStopsHTML(pseudo),
    meta: (r.note ? '要点：' + r.note + '　' : '') +
          '共 ' + r.wps.length + ' 站；播放时颜色随「传入 → 换元 → 传出」变化',
    actions: [
      {t: '播放反射弧', fn: () => makeFiberSignal(pseudo)},
      {t: '单独显示',
       fn: () => { setIso(new Set((r.segs || []).map(s => s.name).concat([r.n])), r.d);
                   flyToMany((r.segs || []).map(s => ({n: s.name}))); }},
      {t: '复原', fn: () => resetAll()},
    ]});
  makeFiberSignal(pseudo);
}
function reflexStopsHTML(m){
  return '<div class="sub-h">逐站（配色 = 纤维性质）</div><div class="stps">' +
    (m.st || []).map((s, i) => {
      const col = (CUR.fiberColors || FIBER_FALLBACK)[s.fiber] || '#ccc';
      return '<div class="stp"><b style="background:' + col + ';color:#fff">' + (i + 1) +
        '</b><span class="sn">' + esc(s.n) + '</span>' +
        (s.tag ? '<span class="sb">' + esc(s.tag) + '</span>' : '') +
        (s.sec ? '<span class="sb" style="background:#16A085;color:#fff">' +
                 esc(s.sec) + '分泌</span>' : '') +
        '</div>';
    }).join('') + '</div>';
}

function buildTractPanel(){
  const P = document.getElementById('panelTract'); P.innerHTML = '';
  // —— 反射弧（优先列出，按用户要求重点做这三个）——
  const refl = CUR.reflexes || [];
  if(refl.length){
    P.insertAdjacentHTML('beforeend',
      '<div class="subtitle">反射弧 · 功能纤维分色<br>' +
      '<span class="small">颜色随「传入 → 换元 → 传出」变化</span></div>' +
      fiberLegendHTML());
    refl.forEach(r => {
      P.insertAdjacentHTML('beforeend',
        `<div class="card" data-ref="${esc(r.n)}">
           <div class="t"><span class="sw" style="background:${r.color}"></span>${esc(r.d)}
             <span class="tag">${r.wps.length} 站</span></div>
           <div class="d">${esc(r.desc).slice(0, 96)}…</div>
         </div>`);
    });
    P.querySelectorAll('[data-ref]').forEach(el => el.onclick = () => {
      const r = refl.find(x => x.n === el.dataset.ref);
      selectReflex(r);
      P.querySelectorAll('.card').forEach(c => c.classList.toggle('on', c.dataset.ref === r.n));
    });
    P.insertAdjacentHTML('beforeend', '<div class="subtitle">脑神经通路</div>');
  }
  const groups = fiberGroups();
  if(groups.length){
    groups.forEach(g => {
      const keys = ['L', 'R'].filter(s => g.sides[s]);
      if(!keys.length) keys.push(...Object.keys(g.sides));
      const flowTxt = g.flow === 'afferent' ? '传入'
                    : (g.flow === 'efferent' ? '传出' : '双向');
      const dirTxt = g.flow === 'afferent'
          ? '光点自周围感受器走向脑干核团（**传入 · 入脑**）'
          : (g.flow === 'efferent'
             ? '光点自脑干核团走向周围（**传出 · 出脑**）'
             : '同一主干含两种纤维：感觉纤维**入脑**、运动纤维**出脑**（选中后可选方向）');
      P.insertAdjacentHTML('beforeend',
        `<div class="card" data-g="${g.key}">
           <div class="t"><span class="sw" style="background:${g.color}"></span>${g.label}
             <span class="tag">${g.flow ? flowTxt : (g.dir === 'down' ? '下行' : '上行')}</span></div>
           <div class="d">${g.flow ? dirTxt : (g.dirText
             ? (g.dir === 'down' ? '光点自脑干核团走向周围（下行）'
                                 : '光点自周围走向脑干核团（上行）')
             : (g.dir === 'down'
                ? '光点自皮质端向下走（自上而下）'
                : '光点自脊髓/小脑端向上走（自下而上）'))}，到站停顿、交叉闪烁、换元高亮、支点分发</div>
           <div class="d" style="margin-top:6px">` +
          keys.map(s => `<button class="sbtn" data-side="${s}" data-g="${g.key}"
             style="margin-right:6px;padding:3px 12px;border-radius:12px;cursor:pointer;
             border:1px solid #b9b6ae;background:#fff;font-size:12px">${
             s === 'L' ? '左侧' : (s === 'R' ? '右侧' : '整条')}</button>`).join('') +
          `</div></div>`);
    });
    P.querySelectorAll('.sbtn').forEach(b => b.onclick = ev => {
      ev.stopPropagation();
      const g = groups.find(x => x.key === b.dataset.g);
      selectFiber(g, b.dataset.side);
      P.querySelectorAll('.sbtn').forEach(x => {
        x.classList.remove('on'); x.style.background = '#fff';
        x.style.color = ''; x.style.borderColor = '#b9b6ae'; });
      b.classList.add('on'); b.style.background = '#2f6f8f';
      b.style.color = '#fff'; b.style.borderColor = '#2f6f8f';
      P.querySelectorAll('.card').forEach(c => c.classList.toggle('on', c.dataset.g === b.dataset.g));
    });
    // 点卡片本身也要能选通路 —— 原先只有「左侧 / 右侧」小按钮有效，
    // 点卡片空白处毫无反应，用户会以为「点了没显示出来」。
    P.querySelectorAll('.card[data-g]').forEach(c => c.onclick = () => {
      const b = c.querySelector('.sbtn');
      if(b) b.click();
    });
    return;
  }
  // 反射弧模型没有 12 对脑神经主干，只有反射弧卡片（已在上面列出）
  if((CUR.reflexes || []).length) return;
  // 模型 A（整体装配）没有逐束航点，沿用「按关键字找结构」的老办法
  let n = 0;
  PATHS.forEach(p => {
    const hit = CUR.objects.filter(o => p.kw.some(k => o.d.indexOf(k) >= 0));
    if(!hit.length) return;
    n++;
    P.insertAdjacentHTML('beforeend',
      `<div class="card" data-p="${p.name}">
         <div class="t"><span class="sw" style="background:${p.color}"></span>${p.name}
           <span class="tag">${hit.length} 段</span></div>
         <div class="d">${hit.map(o => o.d).slice(0, 4).join('、')}…</div>
       </div>`);
  });
  if(!n) P.innerHTML = '<div class="small">本建模没有可追踪的通路</div>';
  P.querySelectorAll('[data-p]').forEach(el => el.onclick = () => {
    const p = PATHS.find(x => x.name === el.dataset.p);
    selectTract(p);
    P.querySelectorAll('.card').forEach(c => c.classList.toggle('on', c.dataset.p === p.name));
  });
}

/* 选一条具体的纤维束（左或右） */
function selectFiber(g, side, flow){
  const m = g.sides[side] || g.sides[Object.keys(g.sides)[0]];
  if(!m) return;
  state.sel = {kind: 'tract', name: m.d, fiber: m, down: m.dir === 'down',
               flow: flow || 'eff', test: x => x.n === m.n};
  state.level = null;
  // 选中通路 → 让它「一眼看得见」，但**不把其它结构藏掉**：
  // 用户要求保留颅骨 / 肌肉 / 脑干 / 其它脑神经，这样才能判断这条通路的位置关系。
  // 做法 = 清掉「单独显示」隔离状态 + 本条通路（主干+分支+神经节）不透明并高亮成橙色，
  // 其余结构一律转半透明（有轮廓、能定位）+ 镜头框到它整棵树。
  // （想只看这一条时，右侧信息卡里仍有「单独显示」按钮可手动开启。）
  setIso(null);
  state.focus = isoMembers(m);
  switchTab('tract');
  applyVis();
  const lv = CUR.levels.find(l => l.no === m.lv);
  const kb = m.kb || {};
  const acts = [{t: '隐藏本通路', fn: () => { state.hidden.add(m.n); applyVis(); }},
                {t: '单独显示', fn: () => {
                  CUR.objects.forEach(o => { if(o.n !== m.n) state.hidden.add(o.n); });
                  state.hidden.delete(m.n); applyVis(); }},
                {t: '复原', fn: () => resetAll()}];
  if(m.flow === 'both'){
    // 混合性神经：感觉纤维入脑 / 运动纤维出脑，方向必须能选 —— 否则一个光点
    // 只能代表一种纤维，容易让人以为「感觉纤维也是从脑往外走」。
    acts.unshift(
      {t: '感觉纤维 · 入脑', fn: () => selectFiber(g, side, 'aff')},
      {t: '运动纤维 · 出脑', fn: () => selectFiber(g, side, 'eff')});
  }
  const curFlow = m.flow === 'afferent' ? 'aff'
                : (m.flow === 'efferent' ? 'eff' : state.sel.flow);
  const flowTag = m.flow === 'both'
    ? ('混合性神经 · 按' + (curFlow === 'aff' ? '感觉纤维（入脑）' : '运动纤维（出脑）') + '演示')
    : (curFlow === 'aff' ? '传入 · 光点入脑' : '传出 · 光点出脑');
  showInfo({title: m.d, tag: flowTag + (kb.sense ? ' · ' + kb.sense : ''),
    desc: kb.desc || tractDesc({kw: [g.label]}),
    body: fiberInfoHTML(m) +
          ((kb.desc2 && m.flow === 'afferent') ? '<div class="sub-h">要点</div>' +
             '<div class="small">' + md(kb.desc2) + '</div>' : ''),
    meta: '部位：' + (lv ? lv.seg : '') + ' · 经过 ' + m.wps.length + ' 个层面结构'
        + ' · ' + (m.dirText
            ? (m.flow === 'afferent' ? '光点自周围感受器走向脑干核团（入脑）'
               : (m.flow === 'efferent' ? '光点自脑干核团走向周围靶区（出脑）'
                  : '双向：感觉纤维入脑 / 运动纤维出脑'))
            : (m.dir === 'down' ? '光点自上而下' : '光点自下而上'))
        + ' · 交叉 ' + crossingIdx(fiberOrder(m).w, fiberOrder(m).st).length + ' 处'
        + (m.branches && m.branches.length ? ' · 分支 ' + m.branches.length + ' 条' : ''),
    actions: acts});
  flyToNerve(m);
  makeFiberSignal(m);
}

/* 把一条神经的整棵树（主干 + 全部分支 + 换元神经节）框进画面，
   但**不改动其它结构的可见性** —— 与「单独显示」区别就在这里。 */
function flyToNerve(m){
  if(!m || !recs.length) return;
  const keep = isoMembers(m);
  const b = new THREE.Box3();
  let hit = 0;
  for(const r of recs){
    if(!keep.has(r.meta.n)) continue;
    b.expandByObject(r.obj); hit++;
  }
  if(!hit) return;
  const sz = b.getSize(new THREE.Vector3());
  flyTo(b.getCenter(new THREE.Vector3()),
        Math.max(sz.x, sz.y, sz.z) * 0.95 + 1.5);
}

/* 纤维束的「结构旁白」明细：在哪层穿过什么结构、在哪交叉、传导什么感觉/运动。
   内容取自人卫《系统解剖学》第 10 版「神经系统的传导通路」一节（见 tract_kb）。 */
function fiberInfoHTML(m){
  const kb = m.kb || {};
  const ord = fiberOrder(m);
  const ci = new Set(crossingIdx(ord.w, ord.st));
  // 方向文字随当前所选纤维性质走：感觉性神经 / 混合神经选了「感觉纤维·入脑」时
  // 必须写「传入（入脑）」，否则会出现「光点入脑、文字却写传出」的自相矛盾。
  const fl = m.cn ? cnFlowOf(m) : (m.dir === 'down' ? 'eff' : 'aff');
  const dirTxt = m.dirText
    ? (fl === 'aff' ? '自周围感受器走向脑干核团（感觉 / 传入 · 入脑）'
                    : '自脑干核团走向周围（运动 / 传出 · 出脑）')
    : ((m.dir === 'down') ? '自上而下（运动/下行）' : '自下而上（感觉/上行）');
  const brAt = new Map();
  for(const b of (m.branches || [])){
    const at = b.at == null ? 0 : b.at;
    brAt.set(at, (brAt.get(at) || 0) + 1);
  }
  const rows = ord.w.map((w, i) => {
    const st = ord.st[i] || {};
    const lv = CUR.levels.find(l => l.no === w[0]);
    const isG = st.k === 'ganglion';
    const gAuto = isG && (st.gtype === '副交感');
    return '<div class="stp' + (ci.has(i) ? ' x' : '') + (gAuto ? ' g' : '') + '"><b>' +
      (i + 1) + '</b>' +
      '<span class="sl">L' + String(w[0]).padStart(2, '0') + ' ' +
      (lv ? lv.seg : '') + '</span><span class="sn">' + esc(st.n || '—') + '</span>' +
      (ci.has(i) ? '<span class="sx">交叉</span>' : '') +
      (isG ? (gAuto ? '<span class="sg">换元·自主神经节</span>'
                    : '<span class="ss">感觉神经节·不换元</span>')
           : (st.k === 'nucleus' && st.ntype ? '<span class="sn2">' + esc(st.ntype) + '</span>' : '')) +
      (brAt.has(i) ? '<span class="sb">分支×' + brAt.get(i) + '</span>' : '') +
      '</div>';
  }).join('');
  let h = '';
  if(kb.sense || kb.sys)
    h += '<div class="meta"><b>传导性质</b>：' + esc(kb.sense || '') +
         (kb.sys ? ' · ' + esc(kb.sys) : '') + '</div>';
  if(kb.chain) h += '<div class="meta"><b>起止</b>：' + esc(kb.chain) + '</div>';
  h += '<div class="sub-h">走行：' + dirTxt + ' · 共 ' + ord.w.length + ' 站</div>' +
       '<div class="stps">' + rows + '</div>';
  if(kb.cross && kb.cross.at)
    h += '<div class="meta"><b>交叉</b>：' + esc(kb.cross.at) + '<br>' +
         esc(kb.cross.how || '') + '</div>';
  ord.st.forEach((s, i) => {
    if(s.k !== 'ganglion') return;
    const g = s.gtype || '感觉';
    h += '<div class="meta"><b>' +
         (g === '副交感' ? '换元（自主神经节 · 副交感）' : '感觉神经节（不换元）') +
         '（第 ' + (i + 1) + ' 站）</b>：' + esc(s.n || '') +
         (s.note ? ' · ' + esc(s.note) : '') +
         (s.desc ? '<br>' + esc(s.desc) : '') + '</div>';
  });
  const brs = m.branches || [];
  if(brs.length){
    const heads = brs.filter(b => b.lvl === 1);
    if(heads.length){
      // 三叉神经这类有「几支重要分支 + 各自的细小分支」的，按层级列出来
      h += '<div class="sub-h">分支（' + heads.length +
           ' 支重要分支 · 播放到对应站点时逐条完整演示，走完一支再走下一支）</div>' +
           '<div class="stps">';
      heads.forEach((H, i) => {
        h += '<div class="stp"><b>' + (i + 1) + '</b><span class="sn">' + esc(H.n) +
             '</span><span class="sb">穿' + esc(H.foramen || '—') + '</span></div>';
        h += brs.filter(b => b.lvl === 2 && b.grp && H.n.indexOf(b.grp) === 0)
                .map(s2 => '<div class="stp" style="padding-left:15px"><b>·</b>' +
                     '<span class="sn">' + esc(s2.n) + '</span></div>').join('');
      });
      h += '</div>';
    }else{
      h += '<div class="sub-h">分支（播放到对应站点时逐条完整演示）</div>' +
           '<div class="stps">' + brs.map(b =>
             '<div class="stp"><b>·</b><span class="sn">' + esc(b.n) + '</span>' +
             '<span class="sb">第 ' + ((b.at == null ? 0 : b.at) + 1) +
             ' 站发出</span></div>').join('') + '</div>';
    }
  }
  return h;
}

// 同一条通路里左右侧是两条并行束路：先按「侧」再按「层面」排，
// 光点才会沿着一条束路自下而上走，而不是左右来回乱跳。
function sortTract(list){
  const side = o => (o.d.indexOf('左') >= 0 ? 0 : (o.d.indexOf('右') >= 0 ? 1 : 2));
  return list.slice().sort((a, b) => (side(a) - side(b)) || (a.lv - b.lv) ||
                                     a.d.localeCompare(b.d));
}

// 通路只取真正的传导结构，切面底板（背景）不算通路的一段
function tractObjs(p){
  return CUR.objects.filter(o => o.k !== '切面' && p.kw.some(k => o.d.indexOf(k) >= 0));
}

function selectTract(p){
  const hit = sortTract(tractObjs(p));
  state.sel = {kind: 'tract', name: p.name, down: !!p.down,
               test: m => p.kw.some(k => m.d.indexOf(k) >= 0)};
  state.level = null;
  state.focus = null;
  switchTab('tract');
  applyVis();
  showInfo({title: p.name, tag: '通路', desc: tractDesc(p),
            meta: '经过 ' + hit.length + ' 段结构：' + hit.map(o => o.d).join('、'),
            actions: [{t: '隐藏本通路', fn: () => {
              hit.forEach(o => state.hidden.add(o.n)); applyVis(); }},
                      {t: '复原', fn: () => resetAll()}]});
  makeSignal(hit);
}

function tractDesc(p){
  const t = DATA.terms;
  const first = p.kw[0];
  for(const k in t) if(k.indexOf(first) >= 0) return t[k].desc;
  return '点击左侧或视图中的结构可查看该结构的教材释义。';
}

/* ---------- 旁白 ---------- */
function normKey(s){
  s = s.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
  return s.replace(/[左右]$/, '').trim();
}

function showInfo(x){
  const el = document.getElementById('info');
  let h = `<h4>${x.title}${x.tag ? '<span class="tagx">' + x.tag + '</span>' : ''}</h4>`;
  h += `<p>${md(x.desc) || ''}</p>`;
  if(x.body) h += x.body;                 // 纤维束的「逐站走行 / 交叉」明细
  if(x.meta) h += `<div class="meta">${md(x.meta)}</div>`;
  if(x.actions && x.actions.length){
    h += '<div class="acts">' + x.actions.map((a, i) =>
      `<button class="btn" data-act="${i}">${a.t}</button>`).join('') + '</div>';
    el.innerHTML = h;
    el.querySelectorAll('[data-act]').forEach(b => b.onclick =
      () => x.actions[+b.dataset.act].fn());
  }else el.innerHTML = h;
}

function renderInfo(m){
  if(!m){
    showInfo({title: '未选中结构', tag: '',
      desc: '在视图中点击任一核团、传导束或切面即可查看名称与教材释义；' +
            '也可从右侧「层面浏览」或「通路追踪」进入。',
      meta: '当前建模：' + (CUR ? CUR.title + '（' + CUR.counts.objects + ' 个结构）' : '')});
    return;
  }
  // 纤维束 / 脑神经：给出完整旁白——在哪个层面穿过什么结构、在哪交叉、传导什么感觉/运动
  if((m.k === '纤维束' || m.k === '脑神经') && m.wps){
    const kb = m.kb || {};
    const lv = CUR.levels.find(l => l.no === m.lv);
    const isCN = (m.k === '脑神经');
    showInfo({
      title: m.f,
      tag: isCN ? ('脑神经 · ' + (kb.sense || ''))
                : ((m.dir === 'down' ? '下行通路' : '上行通路') +
                   (kb.sense ? ' · ' + kb.sense : '')),
      desc: kb.desc || '（暂无释义）',
      body: fiberInfoHTML(m),
      meta: '部位：' + m.seg +
            (lv ? ' · 所属层面：L' + String(lv.no).padStart(2, '0') + ' ' + lv.name : '') +
            ' · 逐站结构 ' + m.wps.length + ' 个 · 交叉 ' +
            crossingIdx(fiberOrder(m).w, fiberOrder(m).st).length + ' 处 · 分支 ' +
            ((m.branches || []).length) + ' 条 · ' +
            (m.dir === 'down' ? '光点自脑干核团走向周围' : '光点自周围走向脑干核团'),
      actions: [
        {t: isCN ? '沿此神经播放通路' : '沿此束播放束流', fn: () => makeFiberSignal(m)},
        {t: '单独显示', fn: () => focusObject(m)},
        {t: state.fade.has(m.n) ? '恢复实体' : '透明显示',
         fn: () => toggleFade(m)},
        {t: '隐藏', fn: () => { state.hidden.add(m.n); applyVis(); }},
        {t: '复原', fn: () => resetAll()}]});
    return;
  }
  // 反射弧的分色管：点任意一段 → 播放整条反射弧
  if(m.k === '反射弧'){
    const r = (CUR.reflexes || []).find(x => m.n.indexOf(x.n + '·') === 0);
    if(r){
      showInfo({title: m.f, tag: '反射弧 · 本段（' + m.f + '）',
        desc: r.desc || '',
        body: fiberLegendHTML() + reflexStopsHTML({st: r.st}),
        meta: '所属反射弧：' + r.d,
        actions: [{t: '播放整条反射弧', fn: () => selectReflex(r)},
                  {t: '复原', fn: () => resetAll()}]});
      return;
    }
  }
  const t = DATA.terms[normKey(m.d)] || {};
  const lv = CUR.levels.find(l => l.no === m.lv);
  const isBg = (m.k === '切面');
  const sti = structType(m);
  showInfo({
    title: m.f, tag: sti ? sti.name : (isBg ? '切面' : (t.catName || m.k)),
    desc: isBg
      ? (lv ? lv.note : '本层面的切断面。')
      : ((sti ? '【' + sti.name + '】' + sti.note + '　' : '') + (t.desc || '（暂无释义）')),
    meta: `部位：${m.seg} · 类别：${m.k}${sti ? ' · 结构类型：' + sti.name : ''}${lv ? ' · 层面：L' + String(lv.no).padStart(2, '0') + ' ' + lv.name : ''}`,
    actions: [
      {t: state.fade.has(m.n) ? '恢复实体' : '透明显示', fn: () => toggleFade(m)},
      {t: '隐藏此结构', fn: () => { state.hidden.add(m.n); applyVis();
        showInfo({title: '已隐藏：' + m.f, desc: '点击顶部「复原」或下方按钮可恢复显示。',
                  actions: [{t: '复原', fn: () => resetAll()}]}); }},
      // 单独显示：其余脑神经 / 分支 / 神经节 / 核团隐藏，颅骨、肌肉、脑等半透明
      {t: '单独显示', fn: () => { focusObject(m); flyToObj(m.n); }},
      {t: '复原', fn: () => resetAll()},
    ],
  });
}

/* ---------- 束流信号 ---------- */
function clearSignal(){
  if(sig){ sig.parent && sig.parent.remove(sig); sig.geometry.dispose();
           sig.material.dispose(); sig = null; }
  if(sigLine){ sigLine.parent && sigLine.parent.remove(sigLine);
               sigLine.geometry.dispose(); sigLine.material.dispose(); sigLine = null; }
  for(const m of sigMarks){ m.obj.parent && m.obj.parent.remove(m.obj);
    m.obj.geometry.dispose(); m.obj.material.dispose(); }
  endBranchPhase();
  if(sigNuc){
    sigNuc.rec.obj.material.emissive.setHex(0x000000);
    sigNuc.rec.obj.material.color.copy(sigNuc.base);
    sigNuc = null;
  }
  sigMarks = []; sigHold = 0; sigUp = true; sigHoldKind = null;
  sigIsFiber = false; sigFiberWps = []; sigFiberSt = []; sigNextStop = 0;
  sigArc = null;
  sigStops = []; sigBase = '';
  sigReflex = false;
  clearDrops();
  sigCurve = null;
  sigPts = []; sigT = 0; playing = false;
  hideNarr();
  document.getElementById('bPlay').textContent = '播放';
  document.getElementById('tl').value = 0;
  document.getElementById('tlInfo').textContent = '在「通路追踪」中选择一条通路后播放';
}

/* 交叉点：航点 x 变号（越过中线）或某航点正好压在中线上。
   相邻两站里若有名字带「交叉」的（锥体交叉 / 丘系交叉 / 小脑上脚交叉…），
   就把闪烁点放在**那一站**（解剖上的交叉处）而不是翻过中线后的那一站。 */
function crossingIdx(wps, sts){
  const w = wps || [], s = sts || [], out = new Set();
  for(let i = 1; i < w.length; i++){
    const a = w[i - 1][1], b = w[i][1];
    const flip = (a * b < 0) || (Math.abs(b) < 0.05 && Math.abs(a) > 0.05);
    if(!flip) continue;
    const nmPrev = (s[i - 1] && s[i - 1].n) || '';
    out.add(/交叉/.test(nmPrev) ? (i - 1) : i);
  }
  return [...out].sort((x, y) => x - y);
}

/* ---------- 功能纤维分色 ----------
   感觉（蓝）· 中枢（紫）· 运动（红）· 副交感节前（橙）· 副交感节后（青绿）。
   反射弧演示时光点与尾迹随所在纤维段换色，直观呈现「传入 → 换元 → 传出」。 */
/* 极简行内标记：把 **x** 显示成加粗（释义里用来强调「不换元」「换元站」等要点） */
function md(s){
  return String(s == null ? '' : s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}
const FIBER_FALLBACK = {'感觉': '#2E86DE', '中枢': '#8E44AD', '运动': '#E4572E',
                        '副交感节前': '#F2A93B', '副交感节后': '#16A085'};
function fiberColor(f){
  const c = (CUR && CUR.fiberColors && CUR.fiberColors[f]) || FIBER_FALLBACK[f];
  return new THREE.Color(c || '#FFE066');
}
function tintSignalFiber(f){
  if(!sig) return;
  const col = fiberColor(f);
  sig.material.color.copy(col);
  const halo = sig.children && sig.children[0];
  if(halo && halo.material) halo.material.color.copy(col);
  state.sigFiber = f;
}

/* ---------- 旁白浮层 ---------- */
function esc(s){
  return String(s == null ? '' : s)    .replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
}
function termDesc(name){
  const t = DATA.terms[normKey(String(name || '').replace(/（[左右]）$/, ''))];
  return (t && t.desc) || '';
}
function firstSentence(s, max){
  s = String(s || '').replace(/\s+/g, '');
  if(!s) return '';
  const i = s.indexOf('。');
  let out = (i > 0 && i < (max || 62)) ? s.slice(0, i + 1) : s.slice(0, max || 62);
  if(out.length < s.length && out.slice(-1) !== '。') out += '…';
  return out;
}
function hideNarr(){ document.getElementById('narr').style.display = 'none'; }
function showNarr(html){
  const el = document.getElementById('narr');
  el.innerHTML = html;
  el.style.display = 'block';
}
/* 开始走行时先说这条通路「传导什么」，并点明它起于哪个核团 */
function narrateIntro(m){
  const kb = m.kb || {};
  if(m.reflex){
    // 反射弧：直接说「传入 → 换元 → 传出」，并提示颜色会随纤维性质变化
    showNarr('<span class="nb">反射弧</span><span class="nt">' + esc(m.d) + '</span>' +
      '<span class="nd"> 光点按「传入 → 换元 → 传出」走；颜色随纤维性质变：' +
      '感觉（蓝）→ 换元（橙/青绿）→ 运动（红）。共 ' + sigStops.length + ' 站</span>');
    return;
  }
  const way = m.dirText
    ? (m.dir === 'down' ? '运动/传出 · 光点自脑干核团走向周围'
                        : '感觉/传入 · 光点自周围感受器走向脑干核团')
    : (m.dir === 'down' ? '运动/下行 · 光点自皮质端向下走（自上而下）'
                        : '感觉/上行 · 光点自脊髓·小脑端向上走（自下而上）');
  const st0 = (sigNucIdx >= 0 ? sigStops[sigNucIdx]
                              : ((sigStops && sigStops[0]) || {})) || {};
  const nuc = (st0.k === 'nucleus' && st0.name) ? st0.name : '';
  showNarr('<span class="nb">通路</span><span class="nt">' + esc(m.d) + '</span>' +
    '<span class="nd"> ' + way + (kb.chain ? ' · ' + esc(kb.chain) : '') +
    (nuc ? ' · ' + (sigNucIdx === 0 ? '起自' : '止于') + '「' + esc(nuc) +
           '」（正在高亮闪烁）' : '') + '</span>');
}
/* 光点到达一个航点：停顿 + 旁白 */
function narrateStop(st, m){
  const kb = (m && m.kb) || {};
  const lvtxt = 'L' + String(st.lv).padStart(2, '0') +
                (st.lvSeg ? ' ' + st.lvSeg : '');
  if(st.k === 'nucleus' && (st.i === 0 || st.i === sigStops.length - 1)){
    // —— 本神经的起核 / 中枢核团：单独报幕，配合本体高亮闪烁，并标注核团类型 ——
    const isStart = (st.i === 0);
    const ti = st.ntype ? TYPE_INFO[st.ntype] : null;
    showNarr('<span class="nb nuc">' + (isStart ? '起核' : '止于核团') + '</span>' +
      '<span class="nt">' + esc(st.name) + '</span>' +
      '<span class="nd"> · 第 ' + (st.i + 1) + '/' + sigStops.length + ' 站 · ' + lvtxt +
      (ti ? ' · <b>' + ti.name + '</b>' : '') +
      ' · ' + esc(firstSentence(st.desc || termDesc(st.name), 76)) +
      ' · 该核团已高亮闪烁</span>');
  }else if(st.cross){
    const prev = sigStops[st.i - 1], next = sigStops[st.i + 1];
    const at = (kb.cross && kb.cross.at) || (st.name + '（越过中线）');
    const how = (kb.cross && kb.cross.how) || '';
    const route = (prev && prev.name ? '从「' + prev.name + '」' : '') +
      '越过中线' + (next && next.name ? ' →「' + next.name + '」' : '') +
      '（本站：' + (st.name || '—') + '）';
    showNarr('<span class="nb cross">交叉</span>' +
      '<span class="nt">' + esc(at) + '</span>' +
      '<span class="nd"> ' + lvtxt + ' · 第 ' + (st.i + 1) + '/' + sigStops.length +
      ' 站 · ' + esc(route) + (how ? ' · ' + esc(how) : '') + '</span>');
  }else if(st.k === 'ganglion'){
    // —— 神经节：**必须先分清类型** ——
    //   感觉神经节（三叉神经节 / 膝神经节…）= 第一级感觉神经元胞体，**不换元**；
    //   自主神经节（睫状 / 翼腭 / 下颌下 / 耳神经节）= 副交感换元站。
    const g = st.gtype || '感觉';
    if(g === '副交感'){
      const chain = st.note || ((st.prevName || '') + ' → ' + (st.nextName || ''));
      showNarr('<span class="nb gang">换元</span>' +
        '<span class="nt">' + esc(st.name) + '</span>' +
        '<span class="nd"> · 自主神经节（副交感）· 第 ' + (st.i + 1) + '/' + sigStops.length + ' 站' +
        (chain ? ' · 节前纤维在此换元为节后纤维：' + esc(chain) : '') +
        (st.desc ? ' · ' + esc(firstSentence(st.desc, 74)) : '') + '</span>');
    }else{
      showNarr('<span class="nb sens">感觉神经节</span>' +
        '<span class="nt">' + esc(st.name) + '</span>' +
        '<span class="nd"> · 第 ' + (st.i + 1) + '/' + sigStops.length + ' 站' +
        ' · 第一级感觉神经元胞体所在，<b>此处不换元</b>' +
        (st.desc ? ' · ' + esc(firstSentence(st.desc, 74)) : '') + '</span>');
    }
  }else if(st.sec){
    // —— 效应器是腺体，且到达的是**控制分泌的副交感节后纤维** → 分泌动画 ——
    const base = String(st.name || '').replace(/[（(][^）)]*[）)]\s*$/, '');
    const gd = (CUR.glands || {})[base] || null;
    showNarr('<span class="nb sec">分泌</span>' +
      '<span class="nt">' + esc(st.name) + '</span>' +
      '<span class="nd"> · 第 ' + (st.i + 1) + '/' + sigStops.length + ' 站' +
      ' · 副交感节后纤维兴奋 → 分泌<b>' + esc(st.sec) + '</b>' +
      (gd ? ' · 分泌支配：' + md(gd.sec_by) + '　<b>不控制分泌的</b>：' + md(gd.sens)
          : '') + '</span>');
  }else{
    const bl = sigBranchAt.get(st.i);
    if(bl && bl.length && !sigBranchDone.has(st.i)){
      // —— 分支站：先报幕「本站发出哪几组分支」，随后逐条完整演示 ——
      const gr = buildBranchGroups(bl);
      const nm = gr.map(g => g.head ? baseKeyOf(g.head.n) : g.label);
      showNarr('<span class="nb branch">分支站</span>' +
        '<span class="nt">' + esc(st.name || '分叉处') + '</span>' +
        '<span class="nd"> · 第 ' + (st.i + 1) + '/' + sigStops.length + ' 站' +
        ' · 本站发出 ' + gr.length + ' 组分支：' + esc(nm.join('、')) +
        ' · 下面逐条完整演示（走完一条再走一条）</span>');
      return;
    }
    const role = firstSentence(termDesc(st.name));
    const fibCol = st.fiber
      ? ((CUR.fiberColors || FIBER_FALLBACK)[st.fiber] || '#2f6f8f') : null;
    const head = fibCol
      ? '<span class="nb" style="background:' + fibCol + '">' +
        esc(st.fiber) + '纤维</span>'
      : '<span class="nb">' + lvtxt + '</span>';
    showNarr(head +
      '<span class="nt">' + esc(st.name || '（本层结构）') + '</span>' +
      '<span class="nd"> · 第 ' + (st.i + 1) + '/' + sigStops.length + ' 站' +
      (role ? ' · ' + esc(role) : '') + '</span>');
  }
}

/* 沿一条纤维束走光点。
   方向：一律「沿传导方向」——上行束自下而上，下行束自上而下。
   每到一站（一个层面里的一个核团/结构）停顿一下并弹出旁白；
   到交叉航点停顿更久、标记球高亮闪烁，并说明「从哪交叉到哪」。 */
function makeFiberSignal(m, keepT){
  const oldT = keepT ? sigT : null;
  const wasPlaying = keepT ? playing : true;
  clearSignal();
  const ord = fiberOrder(m);
  const pts = fiberPts(m);
  if(pts.length < 2) return;
  sigPts = pts;
  sigCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  sigArc = arcParams(sigCurve, pts.length - 1);  // 每站对应的弧长比例（光点匀速用）
  sigUp = (m.dir !== 'down');          // 仅用于文字标注，走行方向一律沿传导方向
  sigIsFiber = true;
  sigReflex = !!m.reflex;
  sigFiberWps = ord.w;
  sigFiberSt = ord.st;
  sigBase = baseOf(m.d);
  const denom = Math.max(1, pts.length - 1);
  // 反射弧的「交叉」由逐站旁白直接说明（视交叉、脑干内联系…），不再叠红球
  const ci = new Set(m.reflex ? [] : crossingIdx(ord.w, ord.st));
  sigStops = ord.w.map((w, i) => {
    const st = ord.st[i] || {};
    const lvNo = m.reflex ? (CUR.reflexLv || 8) : w[0];
    const lv = CUR.levels.find(l => l.no === lvNo);
    // 反射弧的站点用 kind 标注（autonomic / sensory-ganglion / nucleus…），
    // 这里翻译成通用站别 + 神经节类型，后面的旁白与闪烁判据一套通用。
    let k = st.k || st.kind || '';
    let gtype = st.gtype || '';
    if(k === 'autonomic'){ k = 'ganglion'; gtype = '副交感'; }
    else if(k === 'sensory-ganglion'){ k = 'ganglion'; gtype = '感觉'; }
    return {i: i, t: sigArc[i], lv: lvNo,
            lvSeg: lv ? lv.seg : '', lvName: lv ? lv.name : '',
            name: st.n || '', cross: ci.has(i),
            k: k, obj: st.obj || '',
            gtype: gtype, ntype: st.ntype || '',
            fiber: st.fiber || '', tag: st.tag || '', sec: st.sec || '',
            note: st.note || '', desc: st.desc || '',
            prevName: (ord.st[i - 1] || {}).n || '',
            nextName: (ord.st[i + 1] || {}).n || ''};
  });
  sigNextStop = 0;
  const n = Math.max(120, pts.length * 12);
  sigLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(sigCurve.getPoints(n)),
    new THREE.LineBasicMaterial({color: 0xFFC300, transparent: true, opacity: 0.9}));
  sigLine.renderOrder = 29; root.add(sigLine);

  sig = new THREE.Mesh(new THREE.SphereGeometry(DOT_R, 22, 18),
                       new THREE.MeshBasicMaterial({color: 0xFFE066}));
  sig.renderOrder = 30; root.add(sig);
  const halo = new THREE.Mesh(sig.geometry,
    new THREE.MeshBasicMaterial({color: 0xFFC300, transparent: true, opacity: .32}));
  halo.scale.setScalar(1.85); sig.add(halo);
  // 反射弧：不要那条从头到尾的黄色直线 —— 颜色由模型里的分色管（感觉蓝 / 中枢紫 /
  // 运动红 / 副交感节前橙 / 副交感节后青绿）来呈现，光点再沿途跟着变色，
  // 于是「传入 → 换元 → 传出」一眼看得出。
  if(m.reflex){
    sigLine.visible = false;
    tintSignalFiber((ord.st[0] || {}).fiber || '感觉');
  }

  // 标记球：交叉（红）+ 神经节（副交感 = 绿·换元；感觉 = 蓝·不换元）
  const mkList = [...ci].map(i => ({i: i, kind: 'cross', obj: ''}));
  ord.st.forEach((st, i) => {
    if(st.k === 'ganglion')
      mkList.push({i: i, kind: 'ganglion', obj: st.obj || '',
                   gtype: st.gtype || '感觉'});
  });
  sigMarks = mkList.map(mm => {
    const t = sigArc[mm.i];
    const isG = mm.kind === 'ganglion';
    const gcol = (mm.gtype === '副交感') ? 0x2BD96B : 0x3E9BE0;
    const mk = new THREE.Mesh(
      new THREE.SphereGeometry(DOT_R * (isG ? 0.95 : 0.85), 18, 14),
      new THREE.MeshBasicMaterial({color: isG ? gcol : 0xFF3B30,
                                   transparent: true, opacity: 0.0}));
    let p = sigCurve.getPointAt(t);
    let rec = null;
    if(mm.obj) rec = recs.find(x => x.meta && x.meta.n === mm.obj) || null;
    if(rec){ p = new THREE.Box3().setFromObject(rec.obj).getCenter(new THREE.Vector3()); }
    mk.position.copy(p);
    mk.renderOrder = 31; root.add(mk);
    return {t: t, mi: mm.i, obj: mk, lv: ord.w[mm.i][0], hit: false, hot: false,
            kind: mm.kind, rec: rec, p: p.clone()};
  });

  // 起始核团：这条神经 / 通路「起于（或止于）哪个核团」一开始就要能看清 ——
  // 在开头几秒把该核团本体高亮闪烁（与换元神经节同一套自发光脉冲）。
  // 感觉性神经（视 / 嗅 / 前庭蜗）走行方向是周围 → 脑干核团，核团落在最后一站，
  // 那一站到达时同样闪一下。
  sigNuc = null; sigNucIdx = -1;
  for(let i = 0; i < sigStops.length; i++){
    const st = sigStops[i];
    if(st.k === 'nucleus' && st.obj) sigNucIdx = i;
    if(sigNucIdx === 0) break;
  }
  if(m.reflex) sigNucIdx = -1;   // 反射弧的中枢核团落在中途，逐站旁白已说明
  if(sigNucIdx >= 0){
    const r0 = recs.find(x => x.meta && x.meta.n === sigStops[sigNucIdx].obj);
    if(r0) sigNuc = {rec: r0, base: r0.obj.material.color.clone(), till: 0};
    if(sigNuc && sigNucIdx === 0 && oldT === null)
      sigNuc.till = performance.now() + 3400;
  }

  // 分支分发：某航点上挂了分支 → 主光点到站后按「组」逐条完整演示
  // （组 = 一级分支 + 它的细小分支；没有分组的神经则每条分支各自一组）
  sigBranchAt = new Map(); sigBranchDone = new Set();
  // 混合神经播「感觉纤维·入脑」时整条航点是反的，分支挂载点不再对应 → 跳过分发
  const revFlow = (m.flow === 'both' && cnFlowOf(m) === 'aff');
  for(const b of (revFlow ? [] : (m.branches || []))){
    const bpts = (b.wps || []).map(w => {
      const p = lvPos(w[0]);
      return new THREE.Vector3(w[1] + p.x, w[3] + p.y, -w[2] + p.z);
    });
    if(bpts.length < 2) continue;
    const at = Math.max(0, Math.min(ord.w.length - 1,
                        b.at == null ? 0 : b.at));
    if(!sigBranchAt.has(at)) sigBranchAt.set(at, []);
    sigBranchAt.get(at).push({n: b.n, obj: b.obj, _pts: bpts,
                              lvl: b.lvl || 0, grp: b.grp || '',
                              foramen: b.foramen || '', note: b.note || ''});
  }

  document.getElementById('tlLabel').textContent = '束流演示 · ' + m.d;
  sigT = (oldT === null) ? 0 : oldT;      // 一律从起点（传导开始端）出发
  playing = (oldT === null) ? true : wasPlaying;
  document.getElementById('bPlay').textContent = playing ? '暂停' : '播放';
  if(oldT === null) narrateIntro(m);
  moveSignal();
}

/* ---------- 分支演示 ----------
   用户要求：到分支站先「停顿报幕」，然后逐条完整演示每条大分支及其细小分支
   —— 例如三叉神经要先完整演示眼神经（含它的细支），再完整演示上颌神经、下颌神经，
   而不是一股脑同时散开（原来那样「太急」，看不出书上的重点）。
   实现：把本站分支按「组」拆开（组 = 一级分支 + 挂在它下面的细小分支），
   然后一段一段地走：光点沿该分支全程走一遍、分支本体高亮、旁白报名称与穿出孔；
   还没演示到的先压成灰，演示过的恢复本色。
   其他脑神经（面神经 8 支、迷走神经 11 支…）没有一级/二级之分，
   每条分支各自成一组，同样逐条完整演示。 */
function branchItem(b){
  const curve = new THREE.CatmullRomCurve3(b._pts, false, 'catmullrom', 0.5);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(64)),
    new THREE.LineBasicMaterial({color: 0x7BE0A8, transparent: true, opacity: 0.0}));
  line.renderOrder = 29; root.add(line);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(DOT_R * 0.6, 16, 12),
    new THREE.MeshBasicMaterial({color: 0x8CFFC1}));
  dot.renderOrder = 32; dot.visible = false; root.add(dot);
  const rec = recs.find(r => r.meta && r.meta.n === b.obj) || null;
  return {b: b, curve: curve, line: line, dot: dot, rec: rec,
          len: Math.max(0.8, curve.getLength())};
}
function buildBranchGroups(bl){
  const leaders = bl.filter(b => b.lvl === 1);
  const groups = [];
  if(leaders.length){
    for(const L of leaders){
      const key = baseKeyOf(L.n);
      groups.push({head: L, foramen: L.foramen, note: L.note, label: L.n,
                   subs: bl.filter(b => b.lvl === 2 && baseKeyOf(b.grp) === key)});
    }
    const used = new Set();
    groups.forEach(g => { used.add(g.head.n); g.subs.forEach(s => used.add(s.n)); });
    const rest = bl.filter(b => !used.has(b.n));
    if(rest.length) groups.push({head: null, subs: rest, label: rest.length + ' 条分支'});
  }else{
    for(const b of bl)
      groups.push({head: null, subs: [b], foramen: b.foramen,
                   note: b.note, label: b.n});
  }
  return groups;
}
const BRANCH_GRAY = new THREE.Color(0x9AA0A6);
function tintBranchItem(it, mode){
  // mode: wait 未演示（压灰） / on 正在演示（高亮） / done 已演示（本色）
  if(!it.rec) return;
  const mt = it.rec.obj.material;
  if(mode === 'wait'){
    mt.color.copy(it.rec.base).lerp(BRANCH_GRAY, 0.7);
    mt.emissive.setHex(0x000000);
    mt.transparent = true; mt.opacity = 0.45; mt.depthWrite = false;
  }else{
    mt.color.copy(it.rec.base);
    mt.emissive.setHex(mode === 'on' ? 0x2E8B57 : 0x000000);
    mt.transparent = false; mt.opacity = 1; mt.depthWrite = true;
  }
  mt.needsUpdate = true;
}
function startBranchPhase(idx){
  const bl = sigBranchAt.get(idx);
  if(!bl || !bl.length) return;
  const groups = buildBranchGroups(bl);
  const steps = [];
  groups.forEach((g, gi) => {
    if(g.head) steps.push({item: branchItem(g.head), kind: 'head', label: g.head.n,
                           foramen: g.foramen, note: g.note,
                           gi: gi, gn: groups.length, sn: g.subs.length});
    g.subs.forEach((s, si) => steps.push({item: branchItem(s), kind: 'sub',
                           label: s.n, foramen: s.foramen, note: s.note,
                           gi: gi, gn: groups.length, si: si + 1, sn: g.subs.length,
                           parent: g.head ? g.head.n : ''}));
  });
  steps.forEach(st => tintBranchItem(st.item, 'wait'));
  sigBranch = {steps: steps, groups: groups, i: -1, next: 0, t: 0, gap: 1.7,
               phase: 'pause', tail: 0, dur: 1.0, idx: idx,
               at: (sigStops[idx] ? sigStops[idx].name : '')};
  const names = groups.map(g => g.head ? baseKeyOf(g.head.n) : g.label);
  showNarr('<span class="nb branch">分支</span>' +
    '<span class="nt">自「' + esc(sigBranch.at) + '」发出 ' + groups.length + ' 组分支</span>' +
    '<span class="nd">' + esc(names.join(' → ')) + ' · 共 ' + steps.length +
    ' 段，逐条完整演示（走完一条再走下一条）</span>');
}
function endBranchPhase(){
  if(!sigBranch) return;
  for(const st of sigBranch.steps){
    const it = st.item;
    it.dot.visible = false;
    if(it.line.parent) it.line.parent.remove(it.line);
    it.line.geometry.dispose(); it.line.material.dispose();
    if(it.dot.parent) it.dot.parent.remove(it.dot);
    it.dot.geometry.dispose(); it.dot.material.dispose();
    tintBranchItem(it, 'done');
  }
  sigBranch = null;
}
function beginBranchStep(B, k){
  const s = B.steps[k];
  B.i = k; B.t = 0; B.phase = 'travel';
  s.item.line.material.opacity = 0.55;
  s.item.dot.visible = true;
  tintBranchItem(s.item, 'on');
  B.dur = Math.max(s.kind === 'head' ? 1.7 : 1.15,
                   Math.min(s.kind === 'head' ? 3.0 : 1.9, s.item.len / 2.6));
  if(s.kind === 'head'){
    const bits = ['自「' + esc(B.at) + '」发出'];
    if(s.foramen) bits.push('穿' + esc(s.foramen));
    bits.push('本支共有 ' + s.sn + ' 条细小分支，逐个演示');
    if(s.note) bits.push(esc(firstSentence(s.note, 58)));
    showNarr('<span class="nb branch">大分支 ' + (s.gi + 1) + '/' + s.gn + '</span>' +
      '<span class="nt">' + esc(s.label) + '</span>' +
      '<span class="nd"> ' + bits.join(' · ') + '</span>');
  }else{
    const dsc = firstSentence(termDesc(s.label), 54);
    const bits = [];
    if(s.parent) bits.push('属「' + esc(s.parent) + '」');
    if(s.foramen) bits.push('穿' + esc(s.foramen));
    bits.push('第 ' + (B.i + 1) + '/' + B.steps.length + ' 段');
    if(dsc) bits.push(esc(dsc));
    showNarr('<span class="nb branch">细小分支 ' + s.si + '/' + s.sn + '</span>' +
      '<span class="nt">' + esc(s.label) + '</span>' +
      '<span class="nd">' + bits.join(' · ') + '</span>');
  }
}
function stepBranchPhase(dt){
  const B = sigBranch;
  if(B.phase === 'tail'){
    B.tail += dt;
    if(B.tail > 1.6) endBranchPhase();
    return;
  }
  if(B.phase === 'pause'){
    B.gap -= dt;
    if(B.gap > 0) return;
    beginBranchStep(B, B.next);
    return;
  }
  const s = B.steps[B.i];
  B.t = Math.min(1, B.t + dt / B.dur);
  // getPointAt：按弧长等分 —— 分支航点疏密不均时也不会「一段爬一段窜」
  s.item.dot.position.copy(s.item.curve.getPointAt(B.t));
  if(B.t < 1) return;
  // 这一条走完：光点收起、分支恢复本色，稍歇一下再走下一条
  s.item.dot.visible = false;
  s.item.line.material.opacity = 0.2;
  tintBranchItem(s.item, 'done');
  if(B.i + 1 < B.steps.length){
    B.phase = 'pause'; B.next = B.i + 1;
    B.gap = (s.kind === 'head' ? 0.5 : 0.35);
    return;
  }
  const gnames = B.groups.map(g => g.head ? baseKeyOf(g.head.n) : g.label);
  showNarr('<span class="nb branch">分支演示完毕</span>' +
    '<span class="nt">' + esc(gnames.join(' / ')) + '</span>' +
    '<span class="nd">共 ' + B.groups.length + ' 组 · ' + B.steps.length +
    ' 段分支已逐条演示完毕，主光点继续沿主干前进</span>');
  B.phase = 'tail'; B.tail = 0;
}

function makeSignal(hit){
  clearSignal();
  sigUp = true;                       // 模型 A 的串链已按方向排好，正着走
  if(hit.length < 1) return;
  const pts = hit.map(o => {
    const r = recs.find(x => x.meta.n === o.n);
    if(!r) return null;
    const b = new THREE.Box3().setFromObject(r.obj);
    const c = b.getCenter(new THREE.Vector3());
    return {p: c, name: o.d, lv: o.lv};
  }).filter(Boolean);
  if(!pts.length) return;
  // 空间最近邻串链：从最尾端（y 最小）出发，每次走向最近的未访问结构。
  // 这样左右两侧会连成「上行—跨顶—下行」一条连续路径，不会左右乱跳。
  sigPts = pts;
  if(pts.length > 2){
    const used = new Array(pts.length).fill(false);
    const sd = s => (s.indexOf('左') >= 0 ? 0 : (s.indexOf('右') >= 0 ? 1 : 2));
    const down = !!(state.sel && state.sel.down);
    let ci = 0;
    for(let i = 1; i < pts.length; i++){
      if(down ? pts[i].p.y > pts[ci].p.y : pts[i].p.y < pts[ci].p.y) ci = i;
    }
    const order = [pts[ci]]; used[ci] = true;
    for(let k = 1; k < pts.length; k++){
      const last = order[order.length - 1];
      const sl = sd(last.name);
      let bj = -1, bd = Infinity;
      for(let j = 0; j < pts.length; j++){
        if(used[j]) continue;
        // 换到对侧的代价乘 1.6：走完一侧再跨过去，避免逐层左右横跳
        let d = pts[j].p.distanceTo(last.p);
        if(sd(pts[j].name) !== sl) d *= 1.6;
        if(d < bd){ bd = d; bj = j; }
      }
      used[bj] = true; order.push(pts[bj]);
    }
    sigPts = order;
  }
  // 串成一条平滑曲线：光点沿束路连续移动，而不是在结构间瞬移
  sigCurve = sigPts.length > 1
    ? new THREE.CatmullRomCurve3(sigPts.map(q => q.p), false, 'catmullrom', 0.35)
    : null;
  if(sigCurve){
    const g = new THREE.BufferGeometry().setFromPoints(
      sigCurve.getPoints(Math.min(400, sigPts.length * 10)));
    sigLine = new THREE.Line(g, new THREE.LineBasicMaterial(
      {color: 0xFFC300, transparent: true, opacity: 0.8}));
    sigLine.renderOrder = 29; root.add(sigLine);
  }
  sig = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 16),
                       new THREE.MeshBasicMaterial({color: 0xFFE066}));
  sig.renderOrder = 30; root.add(sig);
  const g = new THREE.Mesh(sig.geometry,
    new THREE.MeshBasicMaterial({color: 0xFFC300, transparent: true, opacity: .35}));
  g.scale.setScalar(2.2); sig.add(g);
  document.getElementById('tlLabel').textContent = '束流演示 · ' +
    (state.sel && state.sel.name ? state.sel.name : '');
  playing = true;
  document.getElementById('bPlay').textContent = '暂停';
  moveSignal();
}

function moveSignal(){
  if(!sig || !sigPts.length) return;
  const s = Math.max(0, Math.min(1, sigT));
  if(sigIsFiber){
    // 纤维束：t 用**弧长比例**（见 arcParams）——航点疏密不均也匀速，不再一卡一卡。
    // 到站判定仍按「第 i 站」，站点的 t 已换成它对应的弧长比例。
    sigCurve.getPointAt(s, sig.position);
    let idx = 0;
    if(sigArc){
      for(let i = 0; i < sigStops.length; i++){
        if(sigArc[i] <= s + 1e-9) idx = i; else break;
      }
    }else{
      idx = Math.min(sigStops.length - 1,
                     Math.round(s * Math.max(1, sigStops.length - 1)));
    }
    const st0 = sigStops[idx];
    document.getElementById('tl').value = Math.round(sigT * 1000);
    document.getElementById('tlInfo').textContent =
      'L' + String(st0.lv).padStart(2, '0') + ' ' + st0.lvName +
      ' · ' + (sigUp ? '上行 ' : '下行 ') + '第 ' + (idx + 1) + '/' +
      sigStops.length + ' 站' + (st0.name ? ' · ' + st0.name : '');
    return;
  }
  const t = s;
  if(sigCurve) sigCurve.getPointAt(t, sig.position);
  else sig.position.copy(sigPts[Math.min(sigPts.length - 1,
                                         Math.floor(t * sigPts.length))].p);
  // 当前最接近的结构 -> 用来标注「在哪一层、哪一段」
  let bi = 0, bd = Infinity;
  for(let i = 0; i < sigPts.length; i++){
    const d = sigPts[i].p.distanceToSquared(sig.position);
    if(d < bd){ bd = d; bi = i; }
  }
  document.getElementById('tl').value = Math.round(sigT * 1000);
  const lv = CUR.levels.find(l => l.no === sigPts[bi].lv);
  document.getElementById('tlInfo').textContent =
    (lv ? 'L' + String(lv.no).padStart(2, '0') + ' ' + lv.name + ' · ' : '') +
    sigPts[bi].name;
}

/* 只把走行曲线/标记球挪到新位置，不重建材质、不清掉「已过站点」的状态 */
function refollowSignal(){
  if(!state.sel || !state.sel.fiber || !sigPts.length) return;
  const m = state.sel.fiber;
  const pts = fiberPts(m);
  if(pts.length < 2) return;
  sigPts = pts;
  sigCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  sigArc = arcParams(sigCurve, pts.length - 1);
  if(sigLine){
    sigLine.geometry.dispose();
    sigLine.geometry = new THREE.BufferGeometry().setFromPoints(
      sigCurve.getPoints(Math.max(120, pts.length * 12)));
  }
  for(const mk of sigMarks){
    if(mk.mi != null) mk.t = sigArc[mk.mi];
    mk.obj.position.copy(sigCurve.getPointAt(mk.t));
  }
  for(const st of sigStops) st.t = sigArc[st.i];
  moveSignal();
}

// 拆解间距/手动拖动改变后，通路几何要跟着层面重新算，否则线会脱离结构
function rebuildSignal(){
  if(!state.sel || state.sel.kind !== 'tract') return;
  if(state.sel.fiber){ refollowSignal(); return; }
  const t = sigT;
  makeSignal(sortTract(CUR.objects.filter(o => state.sel.test(o) && o.k !== '切面')));
  sigT = t; moveSignal();
}

/* ---------- 相机 ---------- */
function frameAll(){
  const b = new THREE.Box3();
  // 迷走神经的腹部分支会一路伸到腹腔，取景时排除（meta.deep）
  for(const r of recs){ if(r.meta && r.meta.deep) continue; b.expandByObject(r.obj); }
  if(b.isEmpty()) return;
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z);
  controls.target.copy(c);
  camera.position.set(c.x + d * 0.9, c.y - d * 0.75, c.z + d * 0.42);
  camera.near = Math.max(0.01, d / 500); camera.far = d * 40;
  camera.updateProjectionMatrix();
  controls.update();
}

let fly = null;
function flyTo(target, dist){
  const b = new THREE.Box3();
  for(const r of recs) b.expandByObject(r.obj);
  const d = dist || Math.max(b.getSize(new THREE.Vector3()).x, 6);
  fly = {from: camera.position.clone(), tf: controls.target.clone(), tt: target.clone(),
         to: target.clone().add(new THREE.Vector3(d * 0.85, -d * 0.7, d * 0.4)), t: 0};
}

function flyToLevel(no){
  const r = recs.filter(x => x.meta.lv === no);
  if(!r.length) return;
  const b = new THREE.Box3();
  r.forEach(x => b.expandByObject(x.obj));
  flyTo(b.getCenter(new THREE.Vector3()), Math.max(b.getSize(new THREE.Vector3()).x, 4));
}

function flyToObj(n){
  const r = recs.find(x => x.meta.n === n);
  if(!r) return;
  const b = new THREE.Box3().setFromObject(r.obj);
  flyTo(b.getCenter(new THREE.Vector3()), Math.max(b.getSize(new THREE.Vector3()).x * 4, 3));
}

/* 把一组结构（左右成对 / 多段拼的核团）一起框进画面 */
function flyToMany(ms){
  const b = new THREE.Box3();
  let hit = 0;
  for(const m of ms){
    const r = recs.find(x => x.meta.n === m.n);
    if(!r) continue;
    b.expandByObject(r.obj); hit++;
  }
  if(!hit) return;
  const size = b.getSize(new THREE.Vector3());
  flyTo(b.getCenter(new THREE.Vector3()),
        Math.max(size.x, size.y, size.z) * 1.5 + 2);
}

function resetAll(){
  state.hidden.clear(); state.fade.clear(); state.soft.clear();   // 隐藏 / 透明一并恢复实体
  state.iso = null; state.isoLabel = '';      // 「单独显示」也一并复原
  state.focus = null;                        // 通路追踪的半透明也复原
  state.level = null; state.sel = null;
  state.dragP = {}; state.dragO.clear();        // 清掉手动拖开的层面 / 单个结构
  setShellSolid(false);
  applyGap();
  CUR.groups.forEach(g => state.seg[g.key] = true);
  CUR.kinds.forEach(k => state.kind[k.key] = true);
  document.querySelectorAll('#segList .chk,#kindList .chk').forEach(c => c.checked = true);
  document.querySelectorAll('.card').forEach(c => c.classList.remove('on'));
  updateIsoBar();
  clearSignal(); applyVis(); renderInfo(null);
}

/* ---------- 拾取 ---------- */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downXY = null;

function pickAt(cx, cy){
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((cx - r.left) / r.width) * 2 - 1;
  ndc.y = -((cy - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const pool = recs.filter(x => x.obj.visible && x.meta.k !== '外壳' &&
                                (state.kind[x.meta.k] !== false)).map(x => x.obj);
  const hits = ray.intersectObjects(pool, false);
  if(!hits.length) return null;
  // 切面底板、半透明脑外壳、脑干分部都是「背景」：指针下若有核团/神经/分支，
  // 一律优先返回它们 —— 否则隔着半透明脑干永远只能点到脑干本身。
  const BACKDROP = ['切面', '外壳', '脑分部'];
  const solid = hits.find(h => BACKDROP.indexOf(h.object.userData.meta.k) < 0);
  return (solid || hits[0]).object;
}

/* ---------- 拖拽分离（三维自由拖动） ---------- */
let drag = null;

function toScreen(v){
  const p = v.clone().project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return {x: r.left + (p.x * 0.5 + 0.5) * r.width,
          y: r.top + (-p.y * 0.5 + 0.5) * r.height};
}

function rayAt(cx, cy){
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((cx - r.left) / r.width) * 2 - 1;
  ndc.y = -((cy - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  return ray;
}

function groupOfLevel(lv){
  return lvG[Math.max(0, Math.min(lvG.length - 1, lv - 1))];
}

renderer.domElement.addEventListener('pointermove', e => {
  if(drag){
    // 在「过抓取点、与相机平行的平面」上求交 -> 可以把结构拖到视野里的任意位置
    const hit = new THREE.Vector3();
    if(rayAt(e.clientX, e.clientY).ray.intersectPlane(drag.plane, hit)){
      const d = hit.clone().sub(drag.hit0);
      if(drag.single){
        // 单个结构：只动它自己（同层面里其它结构原地不动）
        const o = drag.single;
        o.position.set(drag.start.x + d.x, drag.start.y + d.y, drag.start.z + d.z);
        const rec = recs.find(x => x.obj === o);
        if(rec){
          rec.obj.userData.moved = true;
          state.dragO.set(rec.meta.n, {x: drag.p0.x + d.x, y: drag.p0.y + d.y,
                                       z: drag.p0.z + d.z});
        }
      }else{
        drag.g.position.set(drag.start.x + d.x, drag.start.y + d.y, drag.start.z + d.z);
        const idx = lvG.indexOf(drag.g);
        state.dragP[idx] = {x: drag.p0.x + d.x, y: drag.p0.y + d.y, z: drag.p0.z + d.z};
      }
      rebuildFibers();
      refollowSignal();
    }
    return;
  }
  const o = pickAt(e.clientX, e.clientY);
  const id = o ? o.userData.meta.n : null;
  if(id !== state.hover){ state.hover = id; refreshHighlight();
    renderer.domElement.style.cursor = state.drag ? 'grab' : (id ? 'pointer' : 'default'); }
  updateLabel(o, e);
});
renderer.domElement.addEventListener('pointerdown', e => {
  downXY = [e.clientX, e.clientY];
  if(!state.drag) return;
  const o = pickAt(e.clientX, e.clientY);
  if(!o) return;
  const m = o.userData.meta;
  const c = new THREE.Vector3();
  const nrm = camera.getWorldDirection(new THREE.Vector3()).negate();
  const hit0 = new THREE.Vector3();
  // 默认：拖**这一个结构**（彻底解决「好几个结构粘在一起、分不开」）；
  // 按住 Shift：拖它所在的整个层面。
  if(e.shiftKey){
    const g = groupOfLevel(m.lv);
    g.getWorldPosition(c);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, c);
    if(!rayAt(e.clientX, e.clientY).ray.intersectPlane(plane, hit0)) return;
    const idx = lvG.indexOf(g);
    drag = {g: g, start: g.position.clone(), plane: plane, hit0: hit0,
            p0: Object.assign({x: 0, y: 0, z: 0}, state.dragP[idx] || {})};
  }else{
    o.getWorldPosition(c);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, c);
    if(!rayAt(e.clientX, e.clientY).ray.intersectPlane(plane, hit0)) return;
    const rec = recs.find(x => x.obj === o);
    const base = rec ? rec.basePos : o.position;
    drag = {single: o, start: o.position.clone(), plane: plane, hit0: hit0,
            p0: Object.assign({x: 0, y: 0, z: 0}, state.dragO.get(m.n) || {}),
            base: base};
  }
  controls.enabled = false;
  renderer.domElement.style.cursor = 'grabbing';
  state.sel = {kind: 'obj', key: m.n};
  switchTab('info'); renderInfo(m); refreshHighlight();
});
renderer.domElement.addEventListener('pointerup', e => {
  if(drag){
    drag = null; controls.enabled = true;
    renderer.domElement.style.cursor = state.drag ? 'grab' : 'default';
    downXY = null; return;
  }
  if(!downXY) return;
  const d = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
  downXY = null;
  if(d > 4) return;
  const o = pickAt(e.clientX, e.clientY);
  if(!o) return;
  const m = o.userData.meta;
  state.sel = {kind: 'obj', key: m.n};
  // 单击某条脑神经 = 「单独显示」这条神经：其余脑神经（含分支、神经节、核团）隐藏，
  // 颅骨 / 肌肉 / 脑 / 脑干等其余结构转为半透明；点右上「复原」一键还原。
  if(m.k === '脑神经') focusObject(m);
  switchTab('info');
  renderInfo(m);
  refreshHighlight();
});

const labelEl = document.getElementById('label');
function updateLabel(o, e){
  if(!o){ labelEl.style.display = 'none'; return; }
  const m = o.userData.meta;
  const r = renderer.domElement.getBoundingClientRect();
  // 悬停分支时在名字旁边补一句「属于哪条神经 / 穿哪个孔」，单独显示模式下最有用
  let txt = m.f;
  if(m.k === '分支'){
    const own = ownerNerveOf(m);
    const extra = [own ? own.f : '', m.foramen ? '穿' + m.foramen : '']
      .filter(Boolean).join(' · ');
    if(extra) txt += '（' + extra + '）';
  }else if(m.k === '反射弧'){
    const r0 = (CUR.reflexes || []).find(x => m.n.indexOf(x.n + '·') === 0);
    if(r0) txt = r0.d + '（' + m.f + '）';
  }
  labelEl.textContent = txt;
  labelEl.style.left = (e.clientX - r.left + 12) + 'px';
  labelEl.style.top = (e.clientY - r.top - 8) + 'px';
  labelEl.style.display = 'block';
}

/* ---------- 控件绑定 ---------- */
/* ================================================================ 学习任务
   用户要求：把「观看演示」升级为「主动推理」——
     ① 路径排序 / 重建：给出打乱的站点，学生主动排出正确顺序，系统实时反馈并评分；
     ② 病损定位与症状反推：在特定解剖位置设置虚拟病损，激活后展示可能出现的
        运动 / 感觉 / 自主神经功能障碍，把结构与临床表现直接关联。            */
const LESIONS = [
  {n: '内囊后肢', d: '皮质脊髓束 / 丘脑中央辐射 / 视辐射',
   sym: [['m', '对侧偏瘫'], ['s', '对侧偏身感觉障碍'], ['s', '对侧同向性偏盲']],
   find: '内囊'},
  {n: '脑桥基底部（腹侧）', d: '皮质脊髓束 + 展神经根 + 面神经根',
   sym: [['m', '对侧肢体瘫痪（皮质脊髓束）'],
         ['m', '同侧周围性面瘫、同侧眼球内斜 → 交叉性瘫痪']],
   find: '脑桥'},
  {n: '延髓背外侧（Wallenberg）', d: '小脑后下动脉供血区',
   sym: [['s', '同侧面部与对侧躯体痛温觉障碍'],
         ['m', '吞咽困难、声音嘶哑、眩晕、共济失调'],
         ['a', '同侧 Horner 综合征']],
   find: '延髓'},
  {n: '中脑 顶盖前区 / 动眼神经副核', d: '瞳孔对光反射中枢 + 副交感核',
   sym: [['a', '直接与间接对光反射均消失'],
         ['m', '（若累及动眼神经核）眼外肌麻痹、上睑下垂']],
   find: '动眼神经副核'},
  {n: '三叉神经节（颅中窝）', d: '感觉神经节受损（第一级感觉神经元胞体）',
   sym: [['s', '同侧头面部皮肤、角膜、口腔鼻腔黏膜感觉障碍'],
         ['s', '角膜反射减弱（传入中断）']],
   find: '三叉神经节'},
  {n: '面神经管（膝神经节附近）', d: '面神经管内病变（Bell 麻痹）',
   sym: [['m', '同侧周围性面瘫：额纹消失、闭眼不能、口角歪斜'],
         ['s', '舌前 2/3 味觉丧失（鼓索）'],
         ['a', '泪腺、唾液腺分泌减少；听觉过敏（镫骨肌）']],
   find: '膝神经节'},
  {n: '翼腭神经节', d: '副交感换元站（分泌通路）',
   sym: [['a', '同侧泪腺分泌明显减少']], find: '翼腭神经节'},
  {n: '睫状神经节', d: '副交感换元站（传出性）',
   sym: [['a', '该侧瞳孔对光反射消失、瞳孔散大'],
         ['a', '调节反射障碍']], find: '睫状神经节'},
  {n: '眶上裂', d: '动眼 / 滑车 / 展 / 眼神经穿行',
   sym: [['m', '全眼外肌麻痹：上睑下垂、眼球固定'],
         ['s', '眼神经分布区感觉障碍、角膜反射消失']], find: ''},
  {n: '颈静脉孔', d: '舌咽 / 迷走 / 副神经穿行',
   sym: [['m', '吞咽困难、声音嘶哑、饮水呛咳'],
         ['m', '同侧胸锁乳突肌与斜方肌无力'],
         ['s', '咽部与舌后 1/3 感觉障碍']], find: ''},
];
const SYM_NAME = {m: '运动', s: '感觉', a: '自主'};
let taskPick = {key: null, stops: [], pool: [], ans: [], done: false};

function shuffle(a){
  const r = a.slice();
  for(let i = r.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
function taskPaths(){
  const out = [];
  (CUR.reflexes || []).forEach(r => out.push({
    key: r.n, label: '反射弧 · ' + r.d, stops: r.st.map(s => s.n), fibers: true}));
  CUR.objects.filter(o => o.k === '脑神经' && o.wps && (o.st || []).length >= 3)
    .forEach(o => {
      // 混合神经固定按「运动纤维 · 出脑」出题，避免受上一次所选方向影响
      const oo = (o.flow === 'both') ? Object.assign({}, o, {flow: 'efferent'}) : o;
      const ord = fiberOrder(oo);
      out.push({key: o.n, label: '脑神经 · ' + o.d,
                stops: ord.st.map(s => (s && s.n) || '—')});
    });
  return out;
}
function buildTaskPanel(){
  const P = document.getElementById('panelTask');
  if(!P) return;
  const paths = taskPaths();
  P.innerHTML =
    '<h4>① 路径排序 / 重建</h4>' +
    '<div class="hint">选一条通路，把打乱的站点按<b>正确的传导顺序</b>依次点入答题区；' +
    '点「检查并评分」即时判定对错并给出得分（点答题区里的卡片可取下重排）。</div>' +
    '<select class="btn" id="tkSel"></select>' +
    '<div class="hint" style="margin:0 0 4px">站点池（点击选取）</div>' +
    '<div class="pool" id="tkPool"></div>' +
    '<div class="hint" style="margin:7px 0 4px">你的答案（传导顺序）</div>' +
    '<div class="ans" id="tkAns"></div>' +
    '<div class="bar"><button class="btn" id="tkCheck">检查并评分</button>' +
    '<button class="btn" id="tkReset">重排</button>' +
    '<button class="btn" id="tkShow">显示正确答案</button></div>' +
    '<div class="score" id="tkScore"></div>' +
    '<h4>② 病损定位与症状反推</h4>' +
    '<div class="hint">点一个虚拟病损点：先自己推「会出现什么障碍」，' +
    '再看系统的运动 / 感觉 / 自主神经功能障碍清单，并可定位到模型里的相关结构。</div>' +
    '<div id="tkLesions"></div><div id="tkSym"></div>';
  const sel = P.querySelector('#tkSel');
  paths.forEach(p => {
    const o = document.createElement('option');
    o.value = p.key; o.textContent = p.label;
    sel.appendChild(o);
  });
  taskPick.key = paths.length ? paths[0].key : null;
  sel.onchange = () => { taskPick.key = sel.value; startTaskSort(paths); };
  P.querySelector('#tkCheck').onclick = () => checkTaskSort(paths);
  P.querySelector('#tkReset').onclick = () => startTaskSort(paths);
  P.querySelector('#tkShow').onclick = () => showTaskAnswer(paths);
  buildLesions();
  if(paths.length) startTaskSort(paths);
}
function curTaskPath(paths){
  return paths.find(p => p.key === taskPick.key) || paths[0];
}
function startTaskSort(paths){
  const p = curTaskPath(paths);
  if(!p) return;
  taskPick.stops = p.stops;
  taskPick.pool = shuffle(p.stops.map((_, i) => i));
  taskPick.ans = []; taskPick.done = false;
  renderTaskSort();
  const s = document.getElementById('tkScore');
  if(s) s.textContent = '';
}
function renderTaskSort(){
  const pool = document.getElementById('tkPool');
  const ans = document.getElementById('tkAns');
  if(!pool || !ans) return;
  pool.innerHTML = taskPick.pool.map(i =>
    '<span class="chip" data-i="' + i + '">' + esc(taskPick.stops[i]) + '</span>').join('');
  ans.innerHTML = taskPick.ans.map((i, k) =>
    '<span class="chip idx' + (taskPick.done
      ? (i === k ? ' ok' : ' bad') : '') + '" data-k="' + k + '" data-i="' + i +
    '">' + esc(taskPick.stops[i]) + '</span>').join('');
  pool.querySelectorAll('.chip').forEach(el => el.onclick = () => {
    if(taskPick.done) return;
    taskPick.pool.splice(taskPick.pool.indexOf(+el.dataset.i), 1);
    taskPick.ans.push(+el.dataset.i);
    renderTaskSort();
  });
  ans.querySelectorAll('.chip').forEach(el => el.onclick = () => {
    if(taskPick.done) return;
    taskPick.ans.splice(+el.dataset.k, 1);
    taskPick.pool.push(+el.dataset.i);
    renderTaskSort();
  });
}
function checkTaskSort(paths){
  const p = curTaskPath(paths);
  if(!p) return;
  if(taskPick.ans.length < taskPick.stops.length){
    document.getElementById('tkScore').textContent =
      '还有 ' + (taskPick.stops.length - taskPick.ans.length) + ' 个站点没放进去。';
    return;
  }
  taskPick.done = true;
  renderTaskSort();
  const ok = taskPick.ans.filter((v, i) => v === i).length;
  const n = taskPick.stops.length;
  const pct = Math.round(ok / n * 100);
  const bad = [];
  taskPick.ans.forEach((v, i) => { if(v !== i) bad.push(i + 1); });
  document.getElementById('tkScore').innerHTML =
    '得分：<b>' + pct + ' 分</b>（' + ok + '/' + n + ' 站位置正确）' +
    (pct === 100
      ? '　✔ 顺序完全正确：' + esc(p.label)
      : '　✘ 第 ' + bad.join('、') + ' 站位置不对，点「显示正确答案」对照。');
}
function showTaskAnswer(paths){
  const p = curTaskPath(paths);
  if(!p) return;
  taskPick.ans = taskPick.stops.map((_, i) => i);
  taskPick.pool = []; taskPick.done = true;
  renderTaskSort();
  document.getElementById('tkScore').innerHTML =
    '正确答案（传导顺序）：<br>' +
    p.stops.map((s, i) => '<span class="chip ok idx" data-i="' + (i + 1) + '">' +
      esc(s) + '</span>').join(' ');
}
function buildLesions(){
  const L = document.getElementById('tkLesions');
  if(!L) return;
  L.innerHTML = LESIONS.map((l, i) =>
    '<div class="lesion" data-l="' + i + '"><div class="ln">' + esc(l.n) + '</div>' +
    '<div class="ld">' + esc(l.d) + '</div></div>').join('');
  L.querySelectorAll('.lesion').forEach(el => el.onclick = () => {
    L.querySelectorAll('.lesion').forEach(x => x.classList.remove('on'));
    el.classList.add('on');
    const l = LESIONS[+el.dataset.l];
    document.getElementById('tkSym').innerHTML =
      '<div class="sym"><b>' + esc(l.n) + '</b> — 可能出现的功能障碍：<br>' +
      l.sym.map(([k, t]) => '<div style="margin-top:3px">' +
        '<span class="k ' + k + '">' + SYM_NAME[k] + '</span>' + esc(t) + '</div>').join('') +
      '<div style="margin-top:6px;color:var(--txt3)">提示：病变位置决定「交叉性」还是' +
      '「同侧」表现 —— 脑干内传导束已交叉，颅神经核/神经在患侧。</div></div>';
    goLesion(l);
  });
}
function goLesion(l){
  if(!l.find) return;
  const hit = CUR.objects.find(o => o.d.indexOf(l.find) >= 0 &&
    recs.some(r => r.meta.n === o.n));
  if(!hit) return;
  state.level = null; state.hidden.clear();
  state.sel = {key: hit.n};
  applyVis();
  flyToObj(hit.n);
}

function switchTab(t){
  document.getElementById('tabInfo').classList.toggle('on', t === 'info');
  document.getElementById('tabLevel').classList.toggle('on', t === 'level');
  document.getElementById('tabTract').classList.toggle('on', t === 'tract');
  document.getElementById('tabTask').classList.toggle('on', t === 'task');
  document.getElementById('panelLevel').style.display = t === 'level' ? '' : 'none';
  document.getElementById('panelTract').style.display = t === 'tract' ? '' : 'none';
  document.getElementById('panelTask').style.display = t === 'task' ? '' : 'none';
  if(t === 'task') buildTaskPanel();
}
document.getElementById('tabInfo').onclick = () => switchTab('info');
document.getElementById('tabLevel').onclick = () => switchTab('level');
document.getElementById('tabTract').onclick = () => switchTab('tract');
document.getElementById('tabTask').onclick = () => switchTab('task');

document.getElementById('sGap').oninput = e => setGap(e.target.value / 100);
document.getElementById('mWhole').onclick = () => setGap(0);
document.getElementById('mSplit').onclick = () => setGap(1.0);
function setGap(v){
  const s = document.getElementById('sGap');
  s.value = Math.round(v * 100);
  document.getElementById('gapVal').textContent = v.toFixed(2) +
    (v < 0.05 ? '（装配状态）' : (v >= 1 ? '（层面自然位置）' : ''));
  document.getElementById('mWhole').classList.toggle('on', v < 0.5);
  document.getElementById('mSplit').classList.toggle('on', v >= 0.5);
  state.gap = v; applyGap();          // applyGap 内部会更新纤维与通路
}

document.getElementById('sOpa').oninput = e => {
  state.opa = e.target.value / 100;
  document.getElementById('opaVal').textContent = state.opa.toFixed(2);
  if(state.shellSolid) setShellSolid(false);
  for(const r of recs) if(r.meta.k === '外壳') r.obj.material.opacity = state.opa;
};

/* 外脑壳「一键透明 / 实体化」——用户要求：按一下就在半透明与不透明之间切，
   不用再去拉滑块。实体化时 depthWrite 打开，轮廓挡得住内部结构；透明时相反。 */
function setShellSolid(on){
  state.shellSolid = !!on;
  for(const r of recs){
    if(r.meta.k !== '外壳') continue;
    const mt = r.obj.material;
    mt.transparent = !state.shellSolid;
    mt.opacity = state.shellSolid ? 1.0 : state.opa;
    mt.depthWrite = state.shellSolid;
    mt.needsUpdate = true;
  }
  const b = document.getElementById('bShellSolid');
  if(b){
    b.classList.toggle('hot', state.shellSolid);
    b.textContent = state.shellSolid ? '外脑壳：实体（点击转透明）'
                                     : '外脑壳：透明（点击转实体）';
  }
}
document.getElementById('bShellSolid').onclick = () => setShellSolid(!state.shellSolid);
document.getElementById('bDrag').onclick = e => {
  state.drag = !state.drag;
  e.target.classList.toggle('hot', state.drag);
  renderer.domElement.style.cursor = state.drag ? 'grab' : 'default';
};
document.getElementById('bResetAll').onclick = () => resetAll();
document.getElementById('bCam').onclick = () => frameAll();
document.getElementById('bAllOn').onclick = () => resetAll();
// 左栏「视角 / 复原」小卡片上的同名按钮（切面类模型常用，不必再展开顶部菜单）
(function(){
  const c = document.getElementById('bCam2');
  if(c) c.onclick = () => frameAll();
  const r = document.getElementById('bResetAll2');
  if(r) r.onclick = () => resetAll();
  const d = document.getElementById('bDrag2');
  if(d) d.onclick = e => {
    state.drag = !state.drag;
    e.target.classList.toggle('hot', state.drag);
    renderer.domElement.style.cursor = state.drag ? 'grab' : 'default';
  };
})();

/* 一键「只看灰质核团 / 只看白质纤维束 / 隐藏网状结构」
   —— 用户要求「白质纤维束和灰质核团不要混在一起，要好辨别」，
   这三个按钮让切面在「只看灰质」与「只看白质」之间一键切换。 */
const GREY_KINDS = ['核团', '网状结构', '皮质', '灰质', '神经节', '脑分部'];
const WHITE_KINDS = ['传导束', '纤维束', '交叉', '白质', '脑神经', '分支', '反射弧'];
function setKinds(allow){
  CUR.kinds.forEach(k => state.kind[k.key] = allow.indexOf(k.key) >= 0);
  document.querySelectorAll('[data-kind]').forEach(c => {
    c.checked = allow.indexOf(c.dataset.kind) >= 0; });
  applyVis();
}
(function(){
  const b1 = document.getElementById('bOnlyGrey');
  if(b1) b1.onclick = () => setKinds(['核团', '网状结构', '皮质', '灰质', '神经节']);
  const b2 = document.getElementById('bOnlyWhite');
  if(b2) b2.onclick = () => setKinds(['传导束', '纤维束', '交叉', '白质']);
  const b3 = document.getElementById('bNoRt');
  if(b3) b3.onclick = () => {
    state.kind['网状结构'] = false;
    document.querySelectorAll('[data-kind]').forEach(c => {
      if(c.dataset.kind === '网状结构') c.checked = false; });
    applyVis();
  };
})();
document.getElementById('bHideShell').onclick = () => {
  state.kind['外壳'] = false;
  document.querySelectorAll('[data-kind]').forEach(c => {
    if(c.dataset.kind === '外壳') c.checked = false; });
  applyVis();
};
document.getElementById('bOnlyTract').onclick = () => {
  CUR.kinds.forEach(k => state.kind[k.key] = (k.key === '传导束' || k.key === '纤维束'));
  document.querySelectorAll('[data-kind]').forEach(c => {
    c.checked = (c.dataset.kind === '传导束' || c.dataset.kind === '纤维束'); });
  applyVis();
};
document.getElementById('bPlay').onclick = () => {
  if(!sig) return;
  if(!playing && sigT >= 1 - 1e-6){
    // 已经走到头：再点播放就从头重来
    sigT = 0; sigNextStop = 0; sigHold = 0; sigHoldKind = null;
    endBranchPhase(); sigBranchDone.clear();
    sigMarks.forEach(m => { m.hit = false; m.hot = false;
      m.obj.material.opacity = 0; m.obj.scale.setScalar(1);
      if(m.rec) m.rec.obj.material.emissive.setHex(0x000000); });
    if(state.sel && state.sel.fiber) narrateIntro(state.sel.fiber);
  }
  playing = !playing;
  document.getElementById('bPlay').textContent = playing ? '暂停' : '播放';
};
document.getElementById('tl').oninput = e => {
  sigT = e.target.value / 1000; playing = false;
  document.getElementById('bPlay').textContent = '播放';
  sigHold = 0; sigHoldKind = null;
  endBranchPhase(); sigBranchDone.clear();
  sigMarks.forEach(m => { m.hit = false; m.hot = false;
    m.obj.material.opacity = 0; m.obj.scale.setScalar(1);
    if(m.rec) m.rec.obj.material.emissive.setHex(0x000000); });
  // 拖进度 = 直接跳到该进度，之后的「到站旁白」从下一站继续
  if(sigT <= 1e-6){
    sigNextStop = 0;
  }else{
    sigNextStop = 0;
    for(let i = 0; i < sigStops.length; i++){
      if(sigStops[i].t <= sigT + 1e-9) sigNextStop = i + 1; else break;
    }
  }
  moveSignal();
};

/* ---------- 主循环 ---------- */
function resize(){
  const w = view.clientWidth, h = view.clientHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', resize); resize();

const clock = new THREE.Clock();
function animate(){
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if(fly){
    fly.t = Math.min(1, fly.t + dt * 1.8);
    const k = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - Math.pow(-2 * fly.t + 2, 2) / 2;
    camera.position.lerpVectors(fly.from, fly.to, k);
    controls.target.lerpVectors(fly.tf, fly.tt, k);
    if(fly.t >= 1) fly = null;
  }
  const now = performance.now();
  // —— 起始核团闪烁：通路一开始就把「起于哪个核团」闪出来 ——
  if(sigNuc){
    const mt = sigNuc.rec.obj.material;
    if(now < sigNuc.till && sigNuc.rec.obj.visible){
      const k = Math.abs(Math.sin(now * 0.011));
      mt.emissive.setHex(k > 0.45 ? 0xFFA23C : 0x5A2E00);
      mt.color.copy(sigNuc.base).lerp(WHITE_COL, 0.22 * k);
      mt.needsUpdate = true;
    }else{
      mt.emissive.setHex(0x000000);
      mt.color.copy(sigNuc.base);
      mt.needsUpdate = true;
      sigNuc = null;
    }
  }
  // —— 腺体分泌：持续几秒一波波冒液滴，再各自下落 ——
  if(secOn){
    if(now < secOn.till && now >= secOn.next){
      spawnDrops(secOn.c, secOn.col, 6, 0.30, secOn.r0);
      secOn.next = now + 1300;
    }else if(now >= secOn.till + 6000){
      secOn = null;
    }
  }
  if(drops.length){
    for(let i = drops.length - 1; i >= 0; i--){
      const d = drops[i];
      d.t += dt;
      d.v.y -= dt * 0.09;                       // 重力（很慢：液滴贴着小腺体往下一滴滴滑）
      d.obj.position.addScaledVector(d.v, dt);
      d.obj.material.opacity = Math.max(0, 1 - d.t / d.life);
      if(d.t >= d.life){
        root.remove(d.obj); d.obj.geometry.dispose(); d.obj.material.dispose();
        drops.splice(i, 1);
      }
    }
  }
  if(glandGlow){
    const gm = glandGlow.rec.obj.material;
    if(now < glandGlow.till){
      gm.emissive.setHex(Math.abs(Math.sin(now * 0.010)) > 0.5 ? 0x8A7020 : 0x2A2410);
      gm.needsUpdate = true;
    }else{
      gm.emissive.setHex(0x000000); gm.needsUpdate = true; glandGlow = null;
    }
  }
  if(playing && sigPts.length){
    if(sigHold > now){
      // —— 停顿中：交叉处标记球高亮闪烁；普通站点只让光点轻微呼吸 ——
      if(sigHoldKind === 'cross'){
        const k = Math.abs(Math.sin(now * 0.014));
        for(const m of sigMarks){
          if(m.hot){ m.obj.material.opacity = 0.35 + 0.65 * k;
                     m.obj.scale.setScalar(1 + 0.55 * k); }
        }
        if(sig) sig.material.color.setHex(Math.sin(now * 0.018) > 0 ? 0xFFFFFF : 0xFF5A2B);
      }else if(sigHoldKind === 'ganglion' || sigHoldKind === 'sensgang'){
        // —— 神经节：副交感 → 绿（换元）；感觉 → 蓝（第一级胞体，不换元）——
        const sens = (sigHoldKind === 'sensgang');
        const k = Math.abs(Math.sin(now * 0.011));
        for(const m of sigMarks){
          if(m.hot){ m.obj.material.opacity = 0.4 + 0.6 * k;
                     m.obj.scale.setScalar(1 + 0.7 * k);
                     if(m.rec) m.rec.obj.material.emissive.setHex(
                       sens ? (k > 0.5 ? 0x1B5E8A : 0x0A2B40)
                            : (k > 0.5 ? 0x1F7A46 : 0x0B3A20)); }
        }
        if(sig) sig.material.color.setHex(
          Math.sin(now * 0.016) > 0 ? 0xFFFFFF : (sens ? 0x3E9BE0 : 0x2BD96B));
      }
    }else{
      if(sigHold){
        sigHold = 0; sigHoldKind = null;
        for(const m of sigMarks){
          if(m.hot){ m.hot = false; m.obj.material.opacity = 0; m.obj.scale.setScalar(1);
                     if(m.rec) m.rec.obj.material.emissive.setHex(0x000000); }
        }
        if(sig) sig.material.color.setHex(0xFFE066);
        // 刚走完的这一站挂了分支 → 光点分成几束随分支发出去
        const doneIdx = sigNextStop - 1;
        if(doneIdx >= 0 && sigBranchAt.has(doneIdx) && !sigBranchDone.has(doneIdx)){
          sigBranchDone.add(doneIdx);
          startBranchPhase(doneIdx);
        }
      }
      if(sigBranch){
        stepBranchPhase(dt);              // 分支分发中：主光点停在本站
      }else{
        sigT += dt * 0.085;               // 一律沿传导方向前进（不再有倒放）
        // —— 到站：停顿 + 旁白 ——
        if(sigIsFiber && sigNextStop < sigStops.length &&
           sigT >= sigStops[sigNextStop].t - 1e-6){
          const st = sigStops[sigNextStop];
          sigT = st.t;
          if(st.cross || st.k === 'ganglion'){
            for(const mk of sigMarks)
              if(Math.abs(mk.t - st.t) < 1e-6){ mk.hit = true; mk.hot = true; }
          }
          // 到站停顿：分支站停久一点（先把「本站发出哪几组分支」报幕完再逐条演示）；
          // 起始核团那一站也要停够，配着核团的高亮闪烁看。
          const hasBr = !!(sigBranchAt.get(st.i) && sigBranchAt.get(st.i).length);
          // 神经节：副交感（换元）停久一点并走绿闪；感觉神经节（不换元）走蓝闪
          const isGang = (st.k === 'ganglion');
          const gSens = isGang && (st.gtype !== '副交感');
          sigHold = now + (hasBr ? 2900 : (st.cross ? 2300 :
                            (isGang ? (gSens ? 2200 : 2600) :
                             (st.i === 0 && st.k === 'nucleus' ? 2600 : 1000))));
          sigHoldKind = hasBr ? 'branch' : (st.cross ? 'cross' :
                        (isGang ? (gSens ? 'sensgang' : 'ganglion') : 'stop'));
          // —— 反射弧：颜色随「传入 → 换元 → 传出」变化（功能纤维分色）——
          if(sigReflex && st.fiber) tintSignalFiber(st.fiber);
          // —— 腺体分泌：只有**控制分泌的副交感节后纤维**到达才分泌 ——
          if(st.sec) startSecretion(st);
          // 到站的就是本通路/本神经的中枢核团 → 再闪一次
          if(st.i === sigNucIdx && sigNuc) sigNuc.till = now + 3300;
          narrateStop(st, (state.sel && state.sel.fiber) || null);
          sigNextStop++;
        }
        if(sigT >= 1){ sigT = 1; playing = false;
          document.getElementById('bPlay').textContent = '播放'; }
      }
      moveSignal();
    }
  }
  if(sig) sig.scale.setScalar(1 + 0.12 * Math.sin(performance.now() * 0.006));
  controls.update();
  document.getElementById('hud').textContent = state.drag
    ? '拖拽模式：按住某一层面即可在视野内自由拖动（前后左右上下都行）· 再点「拖拽分离」退出'
    : ('拖动旋转 / 滚轮缩放 / 点击结构查看释义 · ' +
       (CUR ? CUR.title + ' · ' + CUR.counts.objects + ' 个结构' : ''));
  renderer.render(scene, camera);
}
animate();
