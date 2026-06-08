/*
 * Drive Dupe Destroyer (DDD) v14.0 — unionfind.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Noncommercial use only: you may use, copy, modify, and share this
 * software for any noncommercial purpose. Commercial use — including
 * selling it or hosting it as a paid product or service — is NOT permitted.
 * Full terms: see the LICENSE file, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0/
 */
// Union-Find with iterative path compression

export function makeUnionFind() {
  const parent = new Map();
  const size = new Map();

  const find = (x) => {
    if (!parent.has(x)) {
      parent.set(x, x);
      size.set(x, 1);
      return x;
    }
    
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    
    let current = x;
    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    
    return root;
  };

  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    
    if (ra === rb) return false;
    
    const sa = size.get(ra) || 1;
    const sb = size.get(rb) || 1;
    
    if (sa < sb) {
      parent.set(ra, rb);
      size.set(rb, sa + sb);
    } else {
      parent.set(rb, ra);
      size.set(ra, sa + sb);
    }
    
    return true;
  };

  const groupSize = (x) => size.get(find(x)) || 1;
  const connected = (a, b) => find(a) === find(b);

  const groupsFrom = (idsToFile) => {
    const buckets = new Map();
    
    for (const id of idsToFile.keys()) {
      const root = find(id);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(idsToFile.get(id));
    }
    
    return Array.from(buckets.values()).filter(g => g.length > 1);
  };

  const setCount = () => {
    const roots = new Set();
    for (const id of parent.keys()) roots.add(find(id));
    return roots.size;
  };

  return { find, union, groupsFrom, groupSize, connected, setCount };
}
