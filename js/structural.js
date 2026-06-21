/**
 * 2D Truss Structural Analysis — Direct Stiffness Method
 * Axial-force members only (pin-jointed truss idealization)
 */

export class TrussAnalyzer {
  constructor(nodes, members, supports, loads, material = { E: 1, A: 1 }) {
    this.nodes = nodes;       // { id, x, y }
    this.members = members;   // { id, nodeA, nodeB, E, A }
    this.supports = supports; // { nodeId, type: 'pin'|'roller-x'|'roller-y' }
    this.loads = loads;       // { nodeId, fx, fy }
    this.E = material.E;
    this.A = material.A;
  }

  getNode(id) {
    return this.nodes.find((n) => n.id === id);
  }

  analyze() {
    const n = this.nodes.length;
    if (n < 2) return { success: false, error: '노드가 2개 이상 필요합니다.' };
    if (this.members.length === 0) return { success: false, error: '막대(부재)가 없습니다.' };

    const dof = 2 * n;
    const nodeIndex = new Map(this.nodes.map((nd, i) => [nd.id, i]));

    const K = Array.from({ length: dof }, () => new Float64Array(dof));
    const F = new Float64Array(dof);

    for (const load of this.loads) {
      const idx = nodeIndex.get(load.nodeId);
      if (idx === undefined) continue;
      F[2 * idx] += load.fx;
      F[2 * idx + 1] += load.fy;
    }

    const memberData = [];

    for (const m of this.members) {
      const na = this.getNode(m.nodeA);
      const nb = this.getNode(m.nodeB);
      if (!na || !nb) return { success: false, error: `부재 ${m.id}: 노드를 찾을 수 없습니다.` };

      const dx = nb.x - na.x;
      const dy = nb.y - na.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) return { success: false, error: `부재 ${m.id}: 길이가 0입니다.` };

      const c = dx / L;
      const s = dy / L;
      const E = m.E ?? this.E;
      const A = m.A ?? this.A;
      const k = (E * A) / L;

      const ke = [
        [k * c * c, k * c * s, -k * c * c, -k * c * s],
        [k * c * s, k * s * s, -k * c * s, -k * s * s],
        [-k * c * c, -k * c * s, k * c * c, k * c * s],
        [-k * c * s, -k * s * s, k * c * s, k * s * s],
      ];

      const iA = nodeIndex.get(m.nodeA);
      const iB = nodeIndex.get(m.nodeB);
      const map = [2 * iA, 2 * iA + 1, 2 * iB, 2 * iB + 1];

      for (let r = 0; r < 4; r++) {
        for (let c2 = 0; c2 < 4; c2++) {
          K[map[r]][map[c2]] += ke[r][c2];
        }
      }

      memberData.push({ member: m, L, c, s, k, map, na, nb });
    }

    const constrained = new Set();
    for (const sup of this.supports) {
      const idx = nodeIndex.get(sup.nodeId);
      if (idx === undefined) continue;
      if (sup.type === 'pin' || sup.type === 'fixed') {
        constrained.add(2 * idx);
        constrained.add(2 * idx + 1);
      } else if (sup.type === 'roller-y') {
        constrained.add(2 * idx + 1);
      } else if (sup.type === 'roller-x') {
        constrained.add(2 * idx);
      }
    }

    if (constrained.size < 3) {
      return {
        success: false,
        error: '다리 받침이 부족합니다. 양 끝 노드에 「고정」1개 + 「받침」1개를 설정하세요.',
      };
    }

    const freeDofs = [];
    for (let i = 0; i < dof; i++) {
      if (!constrained.has(i)) freeDofs.push(i);
    }

    const nf = freeDofs.length;
    const Kff = Array.from({ length: nf }, () => new Float64Array(nf));
    const Ff = new Float64Array(nf);

    for (let i = 0; i < nf; i++) {
      Ff[i] = F[freeDofs[i]];
      for (let j = 0; j < nf; j++) {
        Kff[i][j] = K[freeDofs[i]][freeDofs[j]];
      }
    }

    const singular = this._isSingular(Kff, nf);
    if (singular) {
      return {
        success: false,
        error: '구조가 불안정합니다. 부재 배치·지지 조건을 확인하세요. (기구학적 불안정)',
      };
    }

    const Uf = this._solve(Kff, Ff, nf);
    if (!Uf) {
      return { success: false, error: '방정식을 풀 수 없습니다. 구조를 확인하세요.' };
    }

    const U = new Float64Array(dof);
    for (let i = 0; i < nf; i++) U[freeDofs[i]] = Uf[i];

    const memberForces = [];
    for (const md of memberData) {
      const { member, L, c, s, map } = md;
      const u1 = U[map[0]];
      const v1 = U[map[1]];
      const u2 = U[map[2]];
      const v2 = U[map[3]];
      const axialDisp = c * (u2 - u1) + s * (v2 - v1);
      const force = md.k * axialDisp;
      memberForces.push({
        memberId: member.id,
        nodeA: member.nodeA,
        nodeB: member.nodeB,
        force,
        type: force > 1e-6 ? 'tension' : force < -1e-6 ? 'compression' : 'zero',
        length: L,
      });
    }

    const reactions = [];
    for (const sup of this.supports) {
      const idx = nodeIndex.get(sup.nodeId);
      if (idx === undefined) continue;
      let rx = 0;
      let ry = 0;
      for (let j = 0; j < dof; j++) {
        rx += K[2 * idx][j] * U[j];
        ry += K[2 * idx + 1][j] * U[j];
      }
      rx -= F[2 * idx];
      ry -= F[2 * idx + 1];
      if (Math.abs(rx) > 1e-9 || Math.abs(ry) > 1e-9) {
        reactions.push({ nodeId: sup.nodeId, rx, ry, type: sup.type });
      }
    }

    return {
      success: true,
      displacements: this.nodes.map((nd, i) => ({
        nodeId: nd.id,
        ux: U[2 * i],
        uy: U[2 * i + 1],
      })),
      memberForces,
      reactions,
    };
  }

  _solve(A, b, n) {
    const M = A.map((row) => Float64Array.from(row));
    const x = Float64Array.from(b);

    for (let col = 0; col < n; col++) {
      let maxVal = Math.abs(M[col][col]);
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > maxVal) {
          maxVal = Math.abs(M[row][col]);
          maxRow = row;
        }
      }
      if (maxVal < 1e-12) return null;

      if (maxRow !== col) {
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
        [x[col], x[maxRow]] = [x[maxRow], x[col]];
      }

      for (let row = col + 1; row < n; row++) {
        const factor = M[row][col] / M[col][col];
        for (let j = col; j < n; j++) M[row][j] -= factor * M[col][j];
        x[row] -= factor * x[col];
      }
    }

    const result = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let sum = x[i];
      for (let j = i + 1; j < n; j++) sum -= M[i][j] * result[j];
      result[i] = sum / M[i][i];
    }
    return result;
  }

  _isSingular(A, n) {
    const M = A.map((row) => Float64Array.from(row));
    for (let col = 0; col < n; col++) {
      let maxVal = Math.abs(M[col][col]);
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > maxVal) {
          maxVal = Math.abs(M[row][col]);
          maxRow = row;
        }
      }
      if (maxVal < 1e-10) return true;
      if (maxRow !== col) [M[col], M[maxRow]] = [M[maxRow], M[col]];
      for (let row = col + 1; row < n; row++) {
        const factor = M[row][col] / M[col][col];
        for (let j = col; j < n; j++) M[row][j] -= factor * M[col][j];
      }
    }
    return false;
  }
}
