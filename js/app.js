import { TrussAnalyzer } from './structural.js';

const GRID_SIZE = 20;
const NODE_RADIUS = 7;
const SNAP_RADIUS = 14;

const BOUND = {
  span: 60,
  height: 30,
  x0: 30,
  x1: 90,
  y0: -30,
  y1: 0,
};

const DESK = {
  gap: 40,
  gapStart: 40,
  gapEnd: 80,
  supportDepth: 10,
  length: 40,
  bridgeY: 0,
  visualDepth: 6,
};

const state = {
  mode: 'node',
  nodes: [],
  members: [],
  supports: [],
  loads: [],
  selectedNode: null,
  pendingMemberStart: null,
  results: null,
  nextId: 1,
  gridUnit: 1,
  unitLabel: 'cm',
  material: { E: 1, A: 1 },
  pan: { x: 0, y: 0 },
  scale: 1,
  view: {
    isPanning: false,
    spaceHeld: false,
    lastX: 0,
    lastY: 0,
    didPan: false,
  },
};

function syncDeskLayout() {
  DESK.supportDepth = (BOUND.span - DESK.gap) / 2;
  DESK.gapStart = DESK.length;
  DESK.gapEnd = DESK.gapStart + DESK.gap;
  BOUND.x0 = DESK.gapStart - DESK.supportDepth;
  BOUND.x1 = DESK.gapEnd + DESK.supportDepth;
}

syncDeskLayout();

function getSceneXRange() {
  return { x0: 0, x1: DESK.length * 2 + DESK.gap };
}

function getDeskSupportZones() {
  return [
    { id: 'left', x0: BOUND.x0, x1: DESK.gapStart, y: DESK.bridgeY, label: '책상 A' },
    { id: 'right', x0: DESK.gapEnd, x1: BOUND.x1, y: DESK.bridgeY, label: '책상 B' },
  ];
}

function getDeskRegions() {
  return getDeskSupportZones();
}

function getDeskVisuals() {
  return [
    { x0: 0, x1: DESK.length, label: '책상 A' },
    { x0: DESK.gapEnd, x1: DESK.gapEnd + DESK.length, label: '책상 B' },
  ];
}

function getDeskAnchors() {
  return {
    left: { x: DESK.gapStart, y: DESK.bridgeY },
    right: { x: DESK.gapEnd, y: DESK.bridgeY },
  };
}

function isInGap(x) {
  return x >= DESK.gapStart && x <= DESK.gapEnd;
}

function isXOnDesk(x) {
  return getDeskSupportZones().some((d) => x >= d.x0 && x <= d.x1);
}

function getStructureHeight() {
  if (state.nodes.length === 0) return 0;
  const ys = state.nodes.map((n) => n.y);
  return Math.max(...ys) - Math.min(...ys);
}

function isStructureWithinHeight() {
  return getStructureHeight() <= BOUND.height;
}

function isInsideSpan(x, y) {
  return x >= BOUND.x0 && x <= BOUND.x1 && y >= BOUND.y0 && y <= BOUND.y1;
}

function isOnDeskTop(x, y, toleranceY = 3) {
  return isXOnDesk(x) && Math.abs(y - DESK.bridgeY) <= toleranceY;
}

function shouldSnapToDeskSurface(x, y) {
  if (!isXOnDesk(x)) return false;
  return y >= DESK.bridgeY - 0.5 && y <= DESK.bridgeY + 0.5;
}

function autoDetectSupports() {
  const leftZone = getDeskRegions().find((d) => d.id === 'left');
  const rightZone = getDeskRegions().find((d) => d.id === 'right');
  const onDeskLine = (n) => Math.abs(n.y - DESK.bridgeY) < 0.5;

  const leftNodes = state.nodes.filter(
    (n) => onDeskLine(n) && n.x >= leftZone.x0 && n.x <= leftZone.x1
  );
  const rightNodes = state.nodes.filter(
    (n) => onDeskLine(n) && n.x >= rightZone.x0 && n.x <= rightZone.x1
  );

  if (leftNodes.length === 0) {
    return { success: false, error: '왼쪽 책상(초록) 위에 노드를 찍어 주세요.' };
  }
  if (rightNodes.length === 0) {
    return { success: false, error: '오른쪽 책상(초록) 위에 노드를 찍어 주세요.' };
  }

  const leftNode = leftNodes.reduce((a, b) => (a.x > b.x ? a : b));
  const rightNode = rightNodes.reduce((a, b) => (a.x < b.x ? a : b));

  return {
    success: true,
    supports: [
      { nodeId: leftNode.id, type: 'pin' },
      { nodeId: rightNode.id, type: 'roller-y' },
    ],
  };
}

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusBar = document.getElementById('status-bar');
const resultsPanel = document.getElementById('results-panel');
const loadModal = document.getElementById('load-modal');
const saveModal = document.getElementById('save-modal');
const savedListEl = document.getElementById('saved-list');
const errorBox = document.getElementById('error-box');

const STORAGE_KEY = 'noodle-bridge-saves';
const MAX_SAVED_BRIDGES = 30;

function uid() {
  return state.nextId++;
}

function clampNodeY(x, y) {
  if (isInGap(x)) {
    return Math.max(BOUND.y0, Math.min(30, y));
  }
  return Math.max(BOUND.y0, Math.min(BOUND.y1, y));
}

function snapUnits(px, py) {
  let units = gridToUnits(px, py);
  units.x = Math.round(units.x);
  units.y = Math.round(units.y);
  units.x = Math.max(BOUND.x0, Math.min(BOUND.x1, units.x));

  if (shouldSnapToDeskSurface(units.x, units.y)) {
    units.y = DESK.bridgeY;
    const region = getDeskSupportZones().find((d) => units.x >= d.x0 && units.x <= d.x1);
    if (region) {
      units.x = Math.max(region.x0, Math.min(region.x1, units.x));
    }
  } else {
    units.y = clampNodeY(units.x, units.y);
  }
  return units;
}

function snapToGrid(px, py) {
  const units = snapUnits(px, py);
  return unitsToScreen(units.x, units.y);
}

function cellPx() {
  return GRID_SIZE * state.scale;
}

function gridToUnits(px, py) {
  const cell = cellPx();
  return {
    x: (px - state.pan.x) / cell,
    y: (py - state.pan.y) / cell,
  };
}

function unitsToScreen(ux, uy) {
  const cell = cellPx();
  return {
    x: ux * cell + state.pan.x,
    y: uy * cell + state.pan.y,
  };
}

function isPanMode() {
  return state.view.spaceHeld || state.view.isPanning;
}

function findNodeAt(px, py) {
  for (const n of state.nodes) {
    const s = unitsToScreen(n.x, n.y);
    if (Math.hypot(s.x - px, s.y - py) < SNAP_RADIUS) return n;
  }
  return null;
}

function resizeCanvas() {
  const wrap = canvas.parentElement;
  canvas.width = wrap.clientWidth;
  canvas.height = Math.max(wrap.clientHeight - 80, 500);
  fitDesksInView();
  draw();
}

function getSceneBounds() {
  const xr = getSceneXRange();
  return {
    x0: xr.x0,
    x1: xr.x1,
    y0: BOUND.y0 - 4,
    y1: DESK.visualDepth + 22,
  };
}

function centerView() {
  const b = getSceneBounds();
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const cell = cellPx();
  state.pan.x = canvas.width / 2 - cx * cell;
  state.pan.y = canvas.height / 2 - cy * cell;
}

function fitDesksInView() {
  syncDeskLayout();
  const b = getSceneBounds();
  const margin = 40;
  const sceneW = b.x1 - b.x0;
  const sceneH = b.y1 - b.y0;
  const scaleX = (canvas.width - margin * 2) / (sceneW * GRID_SIZE);
  const scaleY = (canvas.height - margin * 2) / (sceneH * GRID_SIZE);
  state.scale = Math.min(Math.max(Math.min(scaleX, scaleY), 0.35), 2.5);
  centerView();
}

function zoomAt(screenX, screenY, factor) {
  const before = gridToUnits(screenX, screenY);
  state.scale = Math.min(2.5, Math.max(0.35, state.scale * factor));
  const cell = cellPx();
  state.pan.x = screenX - before.x * cell;
  state.pan.y = screenY - before.y * cell;
  draw();
}

function handlePanMove(clientX, clientY) {
  const dx = clientX - state.view.lastX;
  const dy = clientY - state.view.lastY;
  if (Math.hypot(dx, dy) > 2) state.view.didPan = true;
  state.pan.x += dx;
  state.pan.y += dy;
  state.view.lastX = clientX;
  state.view.lastY = clientY;
  draw();
}

function endPan() {
  state.view.isPanning = false;
  updateCanvasCursor();
}

function updateCanvasCursor() {
  if (state.view.isPanning) canvas.style.cursor = 'grabbing';
  else if (state.view.spaceHeld) canvas.style.cursor = 'grab';
  else canvas.style.cursor = 'crosshair';
}

function drawGrid() {
  const tl = gridToUnits(0, 0);
  const br = gridToUnits(canvas.width, canvas.height);
  const xMin = Math.floor(Math.min(tl.x, br.x)) - 2;
  const xMax = Math.ceil(Math.max(tl.x, br.x)) + 2;
  const yMin = Math.floor(Math.min(tl.y, br.y)) - 2;
  const yMax = Math.ceil(Math.max(tl.y, br.y)) + 2;

  for (let x = xMin; x <= xMax; x++) {
    const sx = unitsToScreen(x, 0).x;
    const major = x % 10 === 0;
    const mid = x % 5 === 0;
    ctx.strokeStyle = major ? '#8a7d6b' : mid ? '#b0a494' : '#d8d0c4';
    ctx.lineWidth = major ? 1.4 : mid ? 1 : 0.75;
    ctx.beginPath();
    ctx.moveTo(sx + 0.5, 0);
    ctx.lineTo(sx + 0.5, canvas.height);
    ctx.stroke();
  }

  for (let y = yMin; y <= yMax; y++) {
    const sy = unitsToScreen(0, y).y;
    const major = y % 10 === 0;
    const mid = y % 5 === 0;
    ctx.strokeStyle = major ? '#8a7d6b' : mid ? '#b0a494' : '#d8d0c4';
    ctx.lineWidth = major ? 1.4 : mid ? 1 : 0.75;
    ctx.beginPath();
    ctx.moveTo(0, sy + 0.5);
    ctx.lineTo(canvas.width, sy + 0.5);
    ctx.stroke();
  }
}

function drawBuildBound() {
  const tl = unitsToScreen(BOUND.x0, BOUND.y0);
  const br = unitsToScreen(BOUND.x1, BOUND.y1);
  const w = br.x - tl.x;
  const h = br.y - tl.y;

  ctx.fillStyle = 'rgba(196, 92, 38, 0.06)';
  ctx.fillRect(tl.x, tl.y, w, h);

  ctx.strokeStyle = '#c45c26';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(tl.x, tl.y, w, h);
  ctx.setLineDash([]);

  ctx.fillStyle = '#c45c26';
  ctx.font = 'bold 11px Pretendard, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`가로 ${BOUND.span}cm · 높이 ${BOUND.height}cm`, tl.x + 6, tl.y + 14);
  ctx.font = '10px Pretendard, sans-serif';
  ctx.fillStyle = 'rgba(196, 92, 38, 0.85)';
  ctx.fillText('높이 30cm · 책상 사이(40cm) 아래 지지 가능', tl.x + 6, tl.y + 28);

  const topLine = unitsToScreen(BOUND.x0, BOUND.y0);
  const topRight = unitsToScreen(getSceneXRange().x1, BOUND.y0);
  ctx.strokeStyle = 'rgba(196, 92, 38, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(topLine.x, topLine.y);
  ctx.lineTo(topRight.x, topLine.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(196, 92, 38, 0.85)';
  ctx.fillText(`높이 ${BOUND.height}cm`, topRight.x - 4, topLine.y - 4);
  ctx.textAlign = 'left';
}

function drawDesks() {
  const y0 = DESK.bridgeY;
  const y1 = y0 + DESK.visualDepth;

  const drawSideDesk = (x0, x1, label) => {
    const tl = unitsToScreen(x0, y0);
    const tr = unitsToScreen(x1, y0);
    const w = tr.x - tl.x;
    const h = unitsToScreen(x0, y1).y - tl.y;

    ctx.fillStyle = '#e8d5b5';
    ctx.strokeStyle = '#8b6914';
    ctx.lineWidth = 2;
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.strokeRect(tl.x, tl.y, w, h);

    const topBand = Math.max(4, GRID_SIZE * state.scale * 0.15);
    ctx.fillStyle = 'rgba(76, 140, 74, 0.3)';
    ctx.fillRect(tl.x, tl.y - topBand * 0.6, w, topBand);

    ctx.strokeStyle = '#2d5a3d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.stroke();

    ctx.fillStyle = '#5c4a32';
    ctx.font = '11px Pretendard, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${label} (${DESK.length}cm)`, tl.x + w / 2, tl.y + h + 16);
    ctx.textAlign = 'left';
  };

  for (const desk of getDeskVisuals()) {
    drawSideDesk(desk.x0, desk.x1, desk.label);
  }

  const gapLeft = unitsToScreen(DESK.gapStart, y0);
  const gapRight = unitsToScreen(DESK.gapEnd, y0);
  const dimY = gapLeft.y + unitsToScreen(0, y1).y - gapLeft.y + 28;

  ctx.strokeStyle = 'rgba(45, 90, 61, 0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(gapLeft.x, gapLeft.y);
  ctx.lineTo(gapRight.x, gapRight.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#c45c26';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(gapLeft.x, dimY);
  ctx.lineTo(gapRight.x, dimY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#c45c26';
  for (const [gx, dir] of [[gapLeft.x, 1], [gapRight.x, -1]]) {
    ctx.beginPath();
    ctx.moveTo(gx, dimY);
    ctx.lineTo(gx + dir * 6, dimY - 4);
    ctx.lineTo(gx + dir * 6, dimY + 4);
    ctx.closePath();
    ctx.fill();
  }

  ctx.font = 'bold 12px Pretendard, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`책상 간격 ${DESK.gap}cm`, (gapLeft.x + gapRight.x) / 2, dimY + 16);
  ctx.textAlign = 'left';
}

function drawGapBelowZone() {
  const tl = unitsToScreen(DESK.gapStart, DESK.bridgeY);
  const br = unitsToScreen(DESK.gapEnd, 30);
  const w = br.x - tl.x;
  const h = br.y - tl.y;

  ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
  ctx.fillRect(tl.x, tl.y, w, h);
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(tl.x, tl.y, w, h);
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(59, 130, 246, 0.85)';
  ctx.font = '10px Pretendard, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('하중 지지 (아래)', tl.x + w / 2, tl.y + h / 2 + 4);
  ctx.textAlign = 'left';
}

function drawSupport(node, type) {
  const s = unitsToScreen(node.x, node.y);
  const r = 10;
  ctx.fillStyle = '#5c4a32';
  ctx.strokeStyle = '#3d3020';
  ctx.lineWidth = 2;

  if (type === 'pin') {
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - r, s.y + r * 1.4);
    ctx.lineTo(s.x + r, s.y + r * 1.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x - r - 4, s.y + r * 1.4);
    ctx.lineTo(s.x + r + 4, s.y + r * 1.4);
    ctx.stroke();
  } else if (type === 'roller-y') {
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - r, s.y + r * 1.2);
    ctx.lineTo(s.x + r, s.y + r * 1.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#888';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(s.x + i * 6, s.y + r * 1.2 + 5, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (type === 'roller-x') {
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + r * 1.2, s.y - r);
    ctx.lineTo(s.x + r * 1.2, s.y + r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function drawLoad(node, weight) {
  if (weight < 1e-6) return;
  const s = unitsToScreen(node.x, node.y);
  const len = Math.min(50, 18 + weight * 0.35);

  ctx.strokeStyle = '#d97706';
  ctx.fillStyle = '#d97706';
  ctx.lineWidth = 2.5;

  const x0 = s.x;
  const y0 = s.y - len;

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(s.x, s.y);
  ctx.stroke();

  const head = 8;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(s.x - head * 0.45, s.y - head);
  ctx.lineTo(s.x + head * 0.45, s.y - head);
  ctx.closePath();
  ctx.fill();

  ctx.font = '11px sans-serif';
  ctx.fillText(`${weight.toFixed(1)}N ↓`, x0 + 8, y0 - 4);
}

function getMemberColor(memberId) {
  if (!state.results) return null;
  const mf = state.results.memberForces.find((f) => f.memberId === memberId);
  if (!mf) return null;
  if (mf.type === 'tension') return '#1a6b8a';
  if (mf.type === 'compression') return '#b83232';
  return '#888';
}

function findCriticalMember(result) {
  if (!result?.memberForces?.length) return null;
  let critical = result.memberForces[0];
  let maxAbs = Math.abs(critical.force);
  for (const mf of result.memberForces) {
    const abs = Math.abs(mf.force);
    if (abs > maxAbs) {
      maxAbs = abs;
      critical = mf;
    }
  }
  return maxAbs < 1e-9 ? null : critical;
}

function drawMember(m, isCritical) {
  const na = state.nodes.find((n) => n.id === m.nodeA);
  const nb = state.nodes.find((n) => n.id === m.nodeB);
  if (!na || !nb) return;

  const sa = unitsToScreen(na.x, na.y);
  const sb = unitsToScreen(nb.x, nb.y);
  const color = getMemberColor(m.id) || '#3d4f6f';

  if (isCritical) {
    ctx.save();
    ctx.strokeStyle = 'rgba(196, 92, 38, 0.45)';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.restore();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = isCritical ? 6 : state.results ? 4 : 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();

  if (isCritical) {
    ctx.save();
    ctx.strokeStyle = '#c45c26';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  if (state.results) {
    const mf = state.results.memberForces.find((f) => f.memberId === m.id);
    if (mf) {
      const mx = (sa.x + sb.x) / 2;
      const my = (sa.y + sb.y) / 2;
      ctx.fillStyle = isCritical ? '#c45c26' : color;
      ctx.font = isCritical ? 'bold 12px sans-serif' : 'bold 11px sans-serif';
      const label = `${Math.abs(mf.force).toFixed(2)}N`;
      const prefix = mf.type === 'tension' ? 'T' : mf.type === 'compression' ? 'C' : '';
      ctx.fillText(`${prefix}${label}`, mx + 4, my - 4);
      if (isCritical) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#c45c26';
        ctx.lineWidth = 3;
        const badge = '⚠ 취약';
        const tw = ctx.measureText(badge).width;
        const bx = mx - tw / 2 - 4;
        const by = my + 14;
        ctx.fillRect(bx, by - 11, tw + 8, 16);
        ctx.strokeRect(bx, by - 11, tw + 8, 16);
        ctx.fillStyle = '#c45c26';
        ctx.fillText(badge, bx + 4, by);
      }
    }
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  drawDesks();
  drawBuildBound();
  drawGapBelowZone();

  const critical = state.results ? findCriticalMember(state.results) : null;
  const criticalId = critical?.memberId ?? null;

  for (const m of state.members) {
    if (m.id === criticalId) continue;
    drawMember(m, false);
  }
  if (criticalId !== null) {
    const criticalMember = state.members.find((m) => m.id === criticalId);
    if (criticalMember) drawMember(criticalMember, true);
  }

  if (state.pendingMemberStart) {
    const s = unitsToScreen(state.pendingMemberStart.x, state.pendingMemberStart.y);
    ctx.strokeStyle = 'rgba(196, 92, 38, 0.6)';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const sup of state.supports) {
    const node = state.nodes.find((n) => n.id === sup.nodeId);
    if (node) drawSupport(node, sup.type);
  }

  for (const load of state.loads) {
    const node = state.nodes.find((n) => n.id === load.nodeId);
    if (node) drawLoad(node, load.weight);
  }

  for (const n of state.nodes) {
    const s = unitsToScreen(n.x, n.y);
    const isSelected = state.selectedNode === n.id;
    ctx.beginPath();
    ctx.arc(s.x, s.y, NODE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? '#c45c26' : '#2d5a3d';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n.id, s.x, s.y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
}

function setMode(mode) {
  state.mode = mode;
  state.pendingMemberStart = null;
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  updateHint();
}

function updateHint() {
  const hints = {
    node: '60×30cm 박스 안에 설계하세요. 책상 사이(파란 영역) 아래쪽에도 지지 노드를 찍을 수 있습니다.',
    member: '시작 노드를 클릭한 뒤, 연결할 끝 노드를 클릭해 막대(부재)를 만듭니다.',
    load: '하중을 받을 노드를 클릭해 무게(N)를 입력합니다. 항상 아래 방향입니다.',
    delete: '노드·부재를 클릭해 삭제합니다.',
    select: '노드를 클릭해 선택합니다. Delete 키로 삭제.',
  };
  document.getElementById('hint-text').textContent = hints[state.mode] || '';
}

function addNodeAt(px, py) {
  const units = snapUnits(px, py);
  const snapped = unitsToScreen(units.x, units.y);
  const existing = findNodeAt(snapped.x, snapped.y);
  if (existing) return existing;

  const node = { id: uid(), x: units.x, y: units.y };
  state.nodes.push(node);
  state.results = null;
  state.supports = [];
  draw();
  updateCounts();
  return node;
}

function addMember(nodeA, nodeB) {
  if (nodeA.id === nodeB.id) return;
  const exists = state.members.some(
    (m) => (m.nodeA === nodeA.id && m.nodeB === nodeB.id) || (m.nodeA === nodeB.id && m.nodeB === nodeA.id)
  );
  if (exists) return;

  state.members.push({ id: uid(), nodeA: nodeA.id, nodeB: nodeB.id });
  state.results = null;
  state.supports = [];
  draw();
  updateCounts();
}

function openLoadModal(node) {
  const existing = state.loads.find((l) => l.nodeId === node.id);
  document.getElementById('load-weight').value = existing?.weight ?? 10;
  loadModal.dataset.nodeId = node.id;
  loadModal.classList.add('open');
}

function applyLoad() {
  const nodeId = Number(loadModal.dataset.nodeId);
  const weight = Math.max(0, parseFloat(document.getElementById('load-weight').value) || 0);

  const idx = state.loads.findIndex((l) => l.nodeId === nodeId);
  if (weight < 1e-9) {
    if (idx >= 0) state.loads.splice(idx, 1);
  } else if (idx >= 0) {
    state.loads[idx] = { nodeId, weight };
  } else {
    state.loads.push({ nodeId, weight });
  }

  loadModal.classList.remove('open');
  state.results = null;
  draw();
  updateCounts();
}

function deleteAt(px, py) {
  const node = findNodeAt(px, py);
  if (node) {
    state.nodes = state.nodes.filter((n) => n.id !== node.id);
    state.members = state.members.filter((m) => m.nodeA !== node.id && m.nodeB !== node.id);
    state.supports = state.supports.filter((s) => s.nodeId !== node.id);
    state.loads = state.loads.filter((l) => l.nodeId !== node.id);
    state.results = null;
    draw();
    updateCounts();
    return;
  }

  for (const m of state.members) {
    const na = state.nodes.find((n) => n.id === m.nodeA);
    const nb = state.nodes.find((n) => n.id === m.nodeB);
    if (!na || !nb) continue;
    const sa = unitsToScreen(na.x, na.y);
    const sb = unitsToScreen(nb.x, nb.y);
    const dist = pointToSegmentDist(px, py, sa.x, sa.y, sb.x, sb.y);
    if (dist < 8) {
      state.members = state.members.filter((x) => x.id !== m.id);
      state.results = null;
      draw();
      updateCounts();
      return;
    }
  }
}

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function runAnalysis() {
  errorBox.style.display = 'none';
  state.results = null;

  if (state.loads.length === 0) {
    errorBox.textContent = '하중을 하나 이상 설정해 주세요.';
    errorBox.style.display = 'block';
    return;
  }

  if (!isStructureWithinHeight()) {
    errorBox.textContent = `다리 전체 높이가 ${BOUND.height}cm를 넘습니다. (현재 ${getStructureHeight().toFixed(0)}cm)`;
    errorBox.style.display = 'block';
    return;
  }

  state.gridUnit = 1;

  const supportResult = autoDetectSupports();
  if (!supportResult.success) {
    errorBox.textContent = supportResult.error;
    errorBox.style.display = 'block';
    state.supports = [];
    draw();
    return;
  }

  state.supports = supportResult.supports;

  const loadsForAnalysis = state.loads.map((l) => ({
    nodeId: l.nodeId,
    fx: 0,
    fy: -l.weight,
  }));

  const analyzer = new TrussAnalyzer(
    state.nodes,
    state.members,
    state.supports,
    loadsForAnalysis,
    state.material
  );

  const result = analyzer.analyze();

  if (!result.success) {
    errorBox.textContent = result.error;
    errorBox.style.display = 'block';
    renderResults(null);
    draw();
    return;
  }

  state.results = result;
  draw();
  renderResults(result);
}

function renderResults(result) {
  if (!result) {
    resultsPanel.innerHTML = '<p class="results-empty">하중 계산을 실행하면 각 막대의 축력이 표시됩니다.</p>';
    return;
  }

  let html = '<div class="legend"><div class="legend-item"><div class="legend-dot tension"></div>인장 (T)</div>';
  html += '<div class="legend-item"><div class="legend-dot compression"></div>압축 (C)</div></div>';

  const critical = findCriticalMember(result);
  if (critical) {
    const prefix = critical.type === 'tension' ? '인장' : critical.type === 'compression' ? '압축' : '무축력';
    const typeLabel = critical.type === 'tension' ? 'T' : critical.type === 'compression' ? 'C' : '';
    html += `<div class="critical-banner">
      <div class="critical-banner-title">⚠ 가장 취약한 부재</div>
      <div class="critical-banner-body">
        부재 #${critical.memberId} (노드 ${critical.nodeA}↔${critical.nodeB}) · ${prefix}
      </div>
      <div class="critical-banner-force">${typeLabel} ${Math.abs(critical.force).toFixed(2)} N</div>
      <div class="critical-banner-note">축력 절댓값이 가장 커서 파단 가능성이 가장 높습니다.</div>
    </div>`;
  }

  html += '<div class="divider"></div><h2>부재별 축력</h2>';

  const sorted = [...result.memberForces].sort((a, b) => a.memberId - b.memberId);
  for (const mf of sorted) {
    const prefix = mf.type === 'tension' ? 'T ' : mf.type === 'compression' ? 'C ' : '';
    const isCritical = critical && mf.memberId === critical.memberId;
    html += `<div class="member-row ${mf.type}${isCritical ? ' critical' : ''}">
      <span>${isCritical ? '⚠ ' : ''}부재 #${mf.memberId} (${mf.nodeA}↔${mf.nodeB})</span>
      <span class="force-value ${mf.type}">${prefix}${Math.abs(mf.force).toFixed(2)} N</span>
    </div>`;
  }

  if (result.reactions.length > 0) {
    html += '<div class="divider"></div><h2>받침 반력 (위쪽)</h2>';
    for (const r of result.reactions) {
      const label = r.type === 'pin' ? '고정' : '받침';
      html += `<div class="reaction-row">노드 #${r.nodeId} (${label}): ${r.ry.toFixed(2)} N ↑</div>`;
    }
  }

  const totalLoad = state.loads.reduce((s, l) => s + l.weight, 0);
  const totalReaction = result.reactions.reduce((s, r) => s + r.ry, 0);

  html += '<div class="divider"></div><h2>평형 검증</h2>';
  html += `<div class="reaction-row">총 하중: ${totalLoad.toFixed(2)} N ↓</div>`;
  html += `<div class="reaction-row">총 반력: ${totalReaction.toFixed(2)} N ↑</div>`;

  resultsPanel.innerHTML = html;
}

function getTotalMemberLength() {
  let total = 0;
  for (const m of state.members) {
    const na = state.nodes.find((n) => n.id === m.nodeA);
    const nb = state.nodes.find((n) => n.id === m.nodeB);
    if (!na || !nb) continue;
    total += Math.hypot(nb.x - na.x, nb.y - na.y);
  }
  return total;
}

function updateCounts() {
  document.getElementById('count-nodes').textContent = state.nodes.length;
  document.getElementById('count-members').textContent = state.members.length;
  document.getElementById('count-loads').textContent = state.loads.length;
  document.getElementById('total-member-length').textContent =
    `${getTotalMemberLength().toFixed(1)} cm`;
}

function serializeBridgeState() {
  return {
    nodes: state.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
    members: state.members.map((m) => ({ id: m.id, nodeA: m.nodeA, nodeB: m.nodeB })),
    loads: state.loads.map((l) => ({ nodeId: l.nodeId, weight: l.weight })),
    nextId: state.nextId,
  };
}

function applyBridgeState(data) {
  if (!Array.isArray(data.nodes) || !Array.isArray(data.members) || !Array.isArray(data.loads)) {
    alert('저장 데이터가 손상되었습니다.');
    return;
  }

  state.nodes = data.nodes.map((n) => ({ ...n }));
  state.members = data.members.map((m) => ({ ...m }));
  state.loads = data.loads.map((l) => ({ ...l }));
  state.nextId = data.nextId ?? 1;
  state.supports = [];
  state.results = null;
  state.pendingMemberStart = null;
  state.selectedNode = null;
  draw();
  renderResults(null);
  updateCounts();
}

function getSavedBridges() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedBridges(bridges) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bridges));
}

function formatSavedDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderSavedList() {
  const bridges = getSavedBridges().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  if (bridges.length === 0) {
    savedListEl.innerHTML = '<p class="saved-empty">저장된 다리가 없습니다.</p>';
    return;
  }

  savedListEl.innerHTML = bridges
    .map((bridge) => {
      const nodeCount = bridge.nodes?.length ?? 0;
      const memberCount = bridge.members?.length ?? 0;
      const loadCount = bridge.loads?.length ?? 0;
      const date = formatSavedDate(bridge.savedAt);
      const safeName = bridge.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      return `<div class="saved-item" data-id="${bridge.id}">
        <div class="saved-item-info">
          <span class="saved-item-name" title="${safeName}">${safeName}</span>
          <span class="saved-item-meta">노드 ${nodeCount} · 막대 ${memberCount} · 하중 ${loadCount}${date ? ` · ${date}` : ''}</span>
        </div>
        <div class="saved-item-actions">
          <button type="button" class="saved-load" data-id="${bridge.id}">불러오기</button>
          <button type="button" class="saved-delete" data-id="${bridge.id}">삭제</button>
        </div>
      </div>`;
    })
    .join('');
}

function openSaveModal() {
  if (state.nodes.length === 0) {
    alert('저장할 노드가 없습니다. 다리를 먼저 설계해 주세요.');
    return;
  }

  const input = document.getElementById('save-name');
  const count = getSavedBridges().length + 1;
  input.value = `다리 ${count}`;
  saveModal.classList.add('open');
  input.focus();
  input.select();
}

function applySave() {
  const input = document.getElementById('save-name');
  const name = input.value.trim() || `다리 ${getSavedBridges().length + 1}`;
  const bridges = getSavedBridges();

  if (bridges.length >= MAX_SAVED_BRIDGES) {
    alert(`저장은 최대 ${MAX_SAVED_BRIDGES}개까지 가능합니다. 오래된 항목을 삭제해 주세요.`);
    return;
  }

  bridges.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    savedAt: new Date().toISOString(),
    ...serializeBridgeState(),
  });

  writeSavedBridges(bridges);
  saveModal.classList.remove('open');
  renderSavedList();
}

function loadSavedBridge(id) {
  const bridge = getSavedBridges().find((b) => b.id === id);
  if (!bridge) {
    renderSavedList();
    return;
  }

  const hasCurrent =
    state.nodes.length > 0 || state.members.length > 0 || state.loads.length > 0;
  if (hasCurrent && !confirm(`「${bridge.name}」을(를) 불러올까요? 현재 작업 내용은 사라집니다.`)) {
    return;
  }

  applyBridgeState(bridge);
}

function deleteSavedBridge(id) {
  const bridge = getSavedBridges().find((b) => b.id === id);
  if (!bridge) {
    renderSavedList();
    return;
  }
  if (!confirm(`「${bridge.name}」 저장을 삭제할까요?`)) return;

  writeSavedBridges(getSavedBridges().filter((b) => b.id !== id));
  renderSavedList();
}

function clearAll() {
  if (!confirm('모든 노드·부재·하중을 삭제할까요?')) return;
  state.nodes = [];
  state.members = [];
  state.supports = [];
  state.loads = [];
  state.results = null;
  state.pendingMemberStart = null;
  draw();
  renderResults(null);
  updateCounts();
}

function findOrCreateNodeAt(x, y) {
  const existing = state.nodes.find((n) => Math.abs(n.x - x) < 0.5 && Math.abs(n.y - y) < 0.5);
  if (existing) return existing;
  const node = { id: uid(), x, y };
  state.nodes.push(node);
  return node;
}

function loadExample() {
  state.nodes = [];
  state.members = [];
  state.supports = [];
  state.loads = [];
  state.nextId = 1;
  state.results = null;

  const n1 = findOrCreateNodeAt(38, DESK.bridgeY);
  const n3 = findOrCreateNodeAt(82, DESK.bridgeY);
  const n2 = findOrCreateNodeAt(60, DESK.bridgeY);
  const n4 = findOrCreateNodeAt(50, -8);
  const n5 = findOrCreateNodeAt(70, -8);
  const n8 = findOrCreateNodeAt(60, 12);

  const pairs = [
    [n1, n4], [n4, n2], [n2, n5], [n5, n3], [n1, n2], [n2, n3],
    [n4, n5], [n4, n8], [n8, n5], [n1, n8], [n8, n3],
  ];
  for (const [a, b] of pairs) {
    state.members.push({ id: uid(), nodeA: a.id, nodeB: b.id });
  }

  state.loads.push({ nodeId: n2.id, weight: 100 });

  draw();
  updateCounts();
  renderResults(null);
}

canvas.addEventListener('mousedown', (e) => {
  if (state.view.spaceHeld || e.button === 1) {
    e.preventDefault();
    e.stopPropagation();
    state.view.isPanning = true;
    state.view.lastX = e.clientX;
    state.view.lastY = e.clientY;
    state.view.didPan = false;
    updateCanvasCursor();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!state.view.isPanning) return;
  handlePanMove(e.clientX, e.clientY);
});

window.addEventListener('mouseup', () => {
  if (state.view.isPanning) endPan();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
}, { passive: false });

canvas.addEventListener('click', (e) => {
  if (isPanMode() || state.view.didPan) {
    state.view.didPan = false;
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;

  if (state.mode === 'node') {
    addNodeAt(px, py);
    return;
  }

  const node = findNodeAt(px, py);

  if (state.mode === 'member') {
    if (!node) return;
    if (!state.pendingMemberStart) {
      state.pendingMemberStart = node;
      draw();
    } else {
      addMember(state.pendingMemberStart, node);
      state.pendingMemberStart = null;
      draw();
    }
    return;
  }

  if (state.mode === 'load') {
    if (!node) return;
    openLoadModal(node);
    return;
  }

  if (state.mode === 'delete') {
    deleteAt(px, py);
    return;
  }

  if (state.mode === 'select') {
    state.selectedNode = node?.id ?? null;
    draw();
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (state.view.isPanning) return;

  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;

  const snapped = snapToGrid(px, py);
  const units = gridToUnits(snapped.x, snapped.y);
  let zone = '';
  if (isInGap(units.x) && units.y > 0) zone = ' · 간격 아래 지지';
  else if (isOnDeskTop(units.x, units.y, 0.6)) zone = ' · 책상 위';
  else if (isInsideSpan(units.x, units.y)) zone = ' · 60cm 구간';
  const h = state.nodes.length ? getStructureHeight() : 0;
  const zoomPct = Math.round(state.scale * 100);
  statusBar.textContent = `위치: ${units.x.toFixed(1)}, ${units.y.toFixed(1)} ${state.unitLabel}${zone} · 높이 ${h.toFixed(0)}/${BOUND.height}cm · ${zoomPct}%`;
});

document.querySelectorAll('.tool-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

document.getElementById('btn-analyze').addEventListener('click', runAnalysis);
document.getElementById('btn-clear').addEventListener('click', clearAll);
document.getElementById('btn-example').addEventListener('click', loadExample);
document.getElementById('btn-save').addEventListener('click', openSaveModal);
document.getElementById('save-apply').addEventListener('click', applySave);
document.getElementById('save-cancel').addEventListener('click', () => saveModal.classList.remove('open'));
document.getElementById('save-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applySave();
});
savedListEl.addEventListener('click', (e) => {
  const loadBtn = e.target.closest('.saved-load');
  const deleteBtn = e.target.closest('.saved-delete');
  if (loadBtn) loadSavedBridge(loadBtn.dataset.id);
  if (deleteBtn) deleteSavedBridge(deleteBtn.dataset.id);
});
document.getElementById('desk-gap-label').textContent = `${DESK.gap} cm`;
document.getElementById('bound-label').textContent = `${BOUND.height} cm`;
document.getElementById('load-apply').addEventListener('click', applyLoad);
document.getElementById('load-cancel').addEventListener('click', () => loadModal.classList.remove('open'));
state.gridUnit = 1;
state.unitLabel = 'cm';

window.addEventListener('resize', resizeCanvas);
window.addEventListener(
  'keydown',
  (e) => {
    if (e.code === 'Space' && !e.repeat) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      e.preventDefault();
      state.view.spaceHeld = true;
      updateCanvasCursor();
    }
    if (e.key === 'Delete' && state.selectedNode) {
      const node = state.nodes.find((n) => n.id === state.selectedNode);
      if (node) {
        const s = unitsToScreen(node.x, node.y);
        deleteAt(s.x, s.y);
        state.selectedNode = null;
      }
    }
    if (e.key === 'Escape') {
      state.pendingMemberStart = null;
      loadModal.classList.remove('open');
      saveModal.classList.remove('open');
      draw();
    }
    if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      fitDesksInView();
      draw();
    }
  },
  { capture: true }
);

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    state.view.spaceHeld = false;
    endPan();
  }
});

setMode('node');
updateCanvasCursor();
resizeCanvas();
updateCounts();
renderSavedList();
renderResults(null);
