/*
 * Drive Dupe Destroyer (DDD) v14.0 — unionfind.js
 *
 * Copyright (c) 2025 Carlos Camacho
 * SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
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
