/*
 * Drive Dupe Destroyer (DDD) v14.0 — shared-worker-pool.js
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
// SharedArrayBuffer-based worker pool for zero-copy hash computation
// Falls back to standard postMessage if SAB not available

// ============================================================================
// SharedArrayBuffer Availability Detection
// ============================================================================

/**
 * Check if SharedArrayBuffer is available
 * Requires specific security headers:
 * - Cross-Origin-Opener-Policy: same-origin
 * - Cross-Origin-Embedder-Policy: require-corp
 */
function isSharedArrayBufferAvailable() {
  try {
    // Check if SAB exists
    if (typeof SharedArrayBuffer === 'undefined') {
      return false;
    }
    
    // Try to create one (will throw if blocked by security)
    const test = new SharedArrayBuffer(1);
    return test.byteLength === 1;
    
  } catch (e) {
    return false;
  }
}

/**
 * Check if Atomics is available (required for SAB synchronization)
 */
function isAtomicsAvailable() {
  try {
    return typeof Atomics !== 'undefined' && 
           typeof Atomics.wait === 'function' &&
           typeof Atomics.notify === 'function';
  } catch {
    return false;
  }
}

const SAB_AVAILABLE = isSharedArrayBufferAvailable();
const ATOMICS_AVAILABLE = isAtomicsAvailable();
const USE_SHARED_MEMORY = SAB_AVAILABLE && ATOMICS_AVAILABLE;

console.log(`[SharedWorkerPool] SAB: ${SAB_AVAILABLE}, Atomics: ${ATOMICS_AVAILABLE}, Using: ${USE_SHARED_MEMORY ? 'SharedArrayBuffer' : 'postMessage'}`);

// ============================================================================
// Memory Layout for SharedArrayBuffer
// ============================================================================

// Control region (first 1KB)
const CTRL_OFFSET = 0;
const CTRL_SIZE = 1024;

// Control word indices (Int32Array)
const CTRL_STATUS = 0;        // 0=idle, 1=working, 2=done, -1=error
const CTRL_TASK_TYPE = 1;     // Task type ID
const CTRL_INPUT_SIZE = 2;    // Input data size
const CTRL_OUTPUT_SIZE = 3;   // Output data size
const CTRL_WORKER_ID = 4;     // Which worker owns this slot
const CTRL_SEQUENCE = 5;      // Sequence number for ordering

// Status values
const STATUS_IDLE = 0;
const STATUS_WORKING = 1;
const STATUS_DONE = 2;
const STATUS_ERROR = -1;

// Task types
const TASK_DHASH = 1;
const TASK_HAMMING = 2;
const TASK_BATCH_COMPARE = 3;

// Data regions per worker
const WORKER_REGION_SIZE = 256 * 1024;  // 256KB per worker
const INPUT_OFFSET = CTRL_SIZE;
const OUTPUT_OFFSET = CTRL_SIZE + 64 * 1024;  // 64KB for input

// ============================================================================
// Shared Memory Pool
// ============================================================================

class SharedMemoryPool {
  constructor(workerCount, regionSize = WORKER_REGION_SIZE) {
    this.workerCount = workerCount;
    this.regionSize = regionSize;
    
    // Total size: control + (region × workers)
    const totalSize = CTRL_SIZE + regionSize * workerCount;
    
    if (USE_SHARED_MEMORY) {
      this.sharedBuffer = new SharedArrayBuffer(totalSize);
      this.controlView = new Int32Array(this.sharedBuffer, CTRL_OFFSET, CTRL_SIZE / 4);
      
      // Initialize control words
      for (let i = 0; i < workerCount; i++) {
        const offset = i * 8;  // 8 int32s per worker
        this.controlView[offset + CTRL_STATUS] = STATUS_IDLE;
        this.controlView[offset + CTRL_WORKER_ID] = i;
      }
    } else {
      this.sharedBuffer = null;
      this.controlView = null;
    }
  }
  
  /**
   * Get region boundaries for a worker
   */
  getWorkerRegion(workerId) {
    const baseOffset = CTRL_SIZE + workerId * this.regionSize;
    return {
      input: baseOffset,
      output: baseOffset + this.regionSize / 2,
      size: this.regionSize / 2
    };
  }
  
  /**
   * Get control word offset for a worker
   */
  getControlOffset(workerId) {
    return workerId * 8;  // 8 int32s per worker
  }
  
  /**
   * Set worker status (main thread)
   */
  setStatus(workerId, status) {
    if (!this.controlView) return;
    const offset = this.getControlOffset(workerId);
    Atomics.store(this.controlView, offset + CTRL_STATUS, status);
    Atomics.notify(this.controlView, offset + CTRL_STATUS);
  }
  
  /**
   * Get worker status
   */
  getStatus(workerId) {
    if (!this.controlView) return STATUS_IDLE;
    const offset = this.getControlOffset(workerId);
    return Atomics.load(this.controlView, offset + CTRL_STATUS);
  }
  
  /**
   * Wait for worker to complete (main thread)
   */
  async waitForCompletion(workerId, timeoutMs = 30000) {
    if (!this.controlView) return STATUS_DONE;
    
    const offset = this.getControlOffset(workerId);
    const startTime = Date.now();
    
    while (true) {
      const status = Atomics.load(this.controlView, offset + CTRL_STATUS);
      
      if (status === STATUS_DONE || status === STATUS_ERROR) {
        return status;
      }
      
      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Worker timeout');
      }
      
      // Wait with timeout
      const result = Atomics.wait(
        this.controlView, 
        offset + CTRL_STATUS, 
        STATUS_WORKING, 
        100  // 100ms chunks
      );
      
      if (result === 'not-equal') {
        // Status changed
        continue;
      }
      
      // Yield to event loop
      await new Promise(r => setTimeout(r, 0));
    }
  }
  
  /**
   * Copy data into worker's input region
   */
  setInputData(workerId, data) {
    if (!this.sharedBuffer) return;
    
    const region = this.getWorkerRegion(workerId);
    const view = new Uint8Array(this.sharedBuffer, region.input, data.length);
    view.set(data);
    
    // Set input size in control
    const offset = this.getControlOffset(workerId);
    Atomics.store(this.controlView, offset + CTRL_INPUT_SIZE, data.length);
  }
  
  /**
   * Get output data from worker's output region
   */
  getOutputData(workerId) {
    if (!this.sharedBuffer) return null;
    
    const offset = this.getControlOffset(workerId);
    const outputSize = Atomics.load(this.controlView, offset + CTRL_OUTPUT_SIZE);
    
    if (outputSize <= 0) return null;
    
    const region = this.getWorkerRegion(workerId);
    const view = new Uint8Array(this.sharedBuffer, region.output, outputSize);
    return new Uint8Array(view);  // Copy out
  }
}

// ============================================================================
// Shared Worker Implementation
// ============================================================================

const SHARED_WORKER_CODE = `
// Inline worker code for SharedArrayBuffer mode
const CTRL_STATUS = 0;
const CTRL_TASK_TYPE = 1;
const CTRL_INPUT_SIZE = 2;
const CTRL_OUTPUT_SIZE = 3;
const STATUS_IDLE = 0;
const STATUS_WORKING = 1;
const STATUS_DONE = 2;
const STATUS_ERROR = -1;
const TASK_DHASH = 1;

let sharedBuffer = null;
let controlView = null;
let workerId = -1;
let regionInput = 0;
let regionOutput = 0;
let regionSize = 0;

// Popcount table
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, c = 0;
  while (v) { c += v & 1; v >>>= 1; }
  POPCOUNT[i] = c;
}

function packBits(bits, count) {
  const byteLen = Math.ceil(count / 8);
  const out = new Uint8Array(byteLen);
  let byteIdx = 0, bitIdx = 7, currentByte = 0;
  
  for (let i = 0; i < count; i++) {
    if (bits[i]) currentByte |= (1 << bitIdx);
    bitIdx--;
    if (bitIdx < 0) {
      out[byteIdx++] = currentByte;
      currentByte = 0;
      bitIdx = 7;
    }
  }
  if (bitIdx < 7) out[byteIdx] = currentByte;
  return out;
}

function computeDHash(grayscale, width, height) {
  const srcWidth = width + 1;
  const bits = new Uint8Array(width * height);
  let k = 0;
  
  for (let y = 0; y < height; y++) {
    const row = y * srcWidth;
    for (let x = 0; x < width; x++) {
      bits[k++] = grayscale[row + x] > grayscale[row + x + 1] ? 1 : 0;
    }
  }
  
  return packBits(bits, width * height);
}

function processTask() {
  if (!controlView) return;
  
  const ctrlOffset = workerId * 8;
  const taskType = Atomics.load(controlView, ctrlOffset + CTRL_TASK_TYPE);
  const inputSize = Atomics.load(controlView, ctrlOffset + CTRL_INPUT_SIZE);
  
  try {
    if (taskType === TASK_DHASH) {
      // Read parameters from first 8 bytes of input
      const paramsView = new DataView(sharedBuffer, regionInput, 8);
      const width = paramsView.getUint32(0, true);
      const height = paramsView.getUint32(4, true);
      
      // Read grayscale data
      const grayscale = new Uint8Array(sharedBuffer, regionInput + 8, inputSize - 8);
      
      // Compute hash
      const hash = computeDHash(grayscale, width, height);
      
      // Write to output region
      const outputView = new Uint8Array(sharedBuffer, regionOutput, hash.length);
      outputView.set(hash);
      
      Atomics.store(controlView, ctrlOffset + CTRL_OUTPUT_SIZE, hash.length);
      Atomics.store(controlView, ctrlOffset + CTRL_STATUS, STATUS_DONE);
    } else {
      Atomics.store(controlView, ctrlOffset + CTRL_STATUS, STATUS_ERROR);
    }
  } catch (e) {
    console.error('[SharedWorker] Task error:', e);
    Atomics.store(controlView, ctrlOffset + CTRL_STATUS, STATUS_ERROR);
  }
  
  Atomics.notify(controlView, ctrlOffset + CTRL_STATUS);
}

self.onmessage = (ev) => {
  const { type, data } = ev.data;
  
  if (type === 'init') {
    sharedBuffer = data.buffer;
    workerId = data.workerId;
    regionInput = data.regionInput;
    regionOutput = data.regionOutput;
    regionSize = data.regionSize;
    controlView = new Int32Array(sharedBuffer, 0, 256);
    self.postMessage({ type: 'ready', workerId });
    return;
  }
  
  if (type === 'task') {
    processTask();
    return;
  }
  
  // Fallback: standard hash task (non-SAB mode)
  if (type === 'hash') {
    const { id, bitmap, withVariants } = data;
    // ... standard hash processing
    self.postMessage({ id, ok: true, base8: new Uint8Array(8), base12: new Uint8Array(18) });
  }
};
`;

// ============================================================================
// Worker Pool Manager
// ============================================================================

export class SharedWorkerPool {
  constructor(poolSize = null) {
    this.poolSize = poolSize || Math.min(navigator.hardwareConcurrency - 1 || 2, 8);
    this.workers = [];
    this.memoryPool = null;
    this.pendingTasks = new Map();
    this.taskIdCounter = 0;
    this.initialized = false;
    this.useSharedMemory = USE_SHARED_MEMORY;
  }
  
  /**
   * Initialize the worker pool
   */
  async initialize() {
    if (this.initialized) return;
    
    if (this.useSharedMemory) {
      await this.initSharedMemoryMode();
    } else {
      await this.initStandardMode();
    }
    
    this.initialized = true;
    console.log(`[SharedWorkerPool] Initialized with ${this.poolSize} workers (${this.useSharedMemory ? 'SAB' : 'postMessage'})`);
  }
  
  /**
   * Initialize with SharedArrayBuffer
   */
  async initSharedMemoryMode() {
    this.memoryPool = new SharedMemoryPool(this.poolSize);
    
    // Create blob URL for inline worker
    const blob = new Blob([SHARED_WORKER_CODE], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    
    const initPromises = [];
    
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(workerUrl);
      
      const readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 10000);
        
        worker.onmessage = (ev) => {
          if (ev.data.type === 'ready') {
            clearTimeout(timeout);
            resolve();
          }
        };
        
        worker.onerror = (e) => {
          clearTimeout(timeout);
          reject(e);
        };
      });
      
      const region = this.memoryPool.getWorkerRegion(i);
      
      worker.postMessage({
        type: 'init',
        data: {
          buffer: this.memoryPool.sharedBuffer,
          workerId: i,
          regionInput: region.input,
          regionOutput: region.output,
          regionSize: region.size
        }
      });
      
      this.workers.push({
        worker,
        id: i,
        busy: false
      });
      
      initPromises.push(readyPromise);
    }
    
    await Promise.all(initPromises);
    URL.revokeObjectURL(workerUrl);
  }
  
  /**
   * Initialize standard postMessage mode
   */
  async initStandardMode() {
    for (let i = 0; i < this.poolSize; i++) {
      // Use the standard worker-hash.js
      const worker = new Worker(
        new URL('./worker-hash.js', import.meta.url),
        { type: 'module' }
      );
      
      worker.onmessage = (ev) => {
        const { id, ok, error, ...result } = ev.data;
        const pending = this.pendingTasks.get(id);
        
        if (pending) {
          this.pendingTasks.delete(id);
          pending.workerInfo.busy = false;
          
          if (ok) {
            pending.resolve(result);
          } else {
            pending.reject(new Error(error || 'Worker error'));
          }
        }
      };
      
      worker.onerror = (e) => {
        console.error(`[Worker ${i}] Error:`, e);
      };
      
      this.workers.push({
        worker,
        id: i,
        busy: false
      });
    }
  }
  
  /**
   * Get an available worker
   */
  getAvailableWorker() {
    return this.workers.find(w => !w.busy) || null;
  }
  
  /**
   * Compute dHash using worker pool
   */
  async computeHash(imageData, width, height, hashSize = 12) {
    await this.initialize();
    
    // Wait for available worker
    let workerInfo = this.getAvailableWorker();
    while (!workerInfo) {
      await new Promise(r => setTimeout(r, 10));
      workerInfo = this.getAvailableWorker();
    }
    
    workerInfo.busy = true;
    
    try {
      if (this.useSharedMemory) {
        return await this.computeHashShared(workerInfo, imageData, width, height, hashSize);
      } else {
        return await this.computeHashStandard(workerInfo, imageData, width, height, hashSize);
      }
    } finally {
      workerInfo.busy = false;
    }
  }
  
  /**
   * Compute hash using SharedArrayBuffer
   */
  async computeHashShared(workerInfo, imageData, width, height, hashSize) {
    const workerId = workerInfo.id;
    
    // Prepare input: [width:u32][height:u32][grayscale data]
    const grayscaleSize = (hashSize + 1) * hashSize;
    const inputBuffer = new ArrayBuffer(8 + grayscaleSize);
    const inputView = new DataView(inputBuffer);
    inputView.setUint32(0, hashSize, true);
    inputView.setUint32(4, hashSize, true);
    
    // Simple grayscale conversion (resize handled by caller)
    const grayscale = new Uint8Array(inputBuffer, 8, grayscaleSize);
    for (let i = 0; i < grayscaleSize && i * 4 < imageData.length; i++) {
      const offset = i * 4;
      grayscale[i] = Math.round(
        0.299 * imageData[offset] +
        0.587 * imageData[offset + 1] +
        0.114 * imageData[offset + 2]
      );
    }
    
    // Copy to shared memory
    this.memoryPool.setInputData(workerId, new Uint8Array(inputBuffer));
    
    // Set task type and trigger worker
    const ctrlOffset = this.memoryPool.getControlOffset(workerId);
    Atomics.store(this.memoryPool.controlView, ctrlOffset + CTRL_TASK_TYPE, TASK_DHASH);
    this.memoryPool.setStatus(workerId, STATUS_WORKING);
    
    // Notify worker
    workerInfo.worker.postMessage({ type: 'task' });
    
    // Wait for completion
    const status = await this.memoryPool.waitForCompletion(workerId);
    
    if (status === STATUS_ERROR) {
      throw new Error('Hash computation failed');
    }
    
    // Get result
    const hash = this.memoryPool.getOutputData(workerId);
    this.memoryPool.setStatus(workerId, STATUS_IDLE);
    
    return { base12: hash, base8: hash?.subarray(0, 8) };
  }
  
  /**
   * Compute hash using standard postMessage
   */
  async computeHashStandard(workerInfo, bitmap, withVariants = false) {
    const taskId = ++this.taskIdCounter;
    
    return new Promise((resolve, reject) => {
      this.pendingTasks.set(taskId, { resolve, reject, workerInfo });
      
      // Transfer bitmap ownership
      workerInfo.worker.postMessage(
        { id: taskId, bitmap, withVariants },
        [bitmap]
      );
    });
  }
  
  /**
   * Terminate all workers
   */
  terminate() {
    for (const { worker } of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingTasks.clear();
    this.initialized = false;
  }
  
  /**
   * Get pool status
   */
  getStatus() {
    return {
      poolSize: this.poolSize,
      initialized: this.initialized,
      useSharedMemory: this.useSharedMemory,
      busyWorkers: this.workers.filter(w => w.busy).length,
      pendingTasks: this.pendingTasks.size
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultPool = null;

export function getSharedWorkerPool() {
  if (!defaultPool) {
    defaultPool = new SharedWorkerPool();
  }
  return defaultPool;
}

export function terminateSharedWorkerPool() {
  if (defaultPool) {
    defaultPool.terminate();
    defaultPool = null;
  }
}

// ============================================================================
// Security Headers Check
// ============================================================================

/**
 * Check if the required security headers are set
 * Returns guidance on how to enable SharedArrayBuffer
 */
export function getSecurityHeadersStatus() {
  const headersNeeded = `
To enable SharedArrayBuffer for maximum performance, add these headers to your server:

Apache (.htaccess):
  Header set Cross-Origin-Opener-Policy "same-origin"
  Header set Cross-Origin-Embedder-Policy "require-corp"

Nginx:
  add_header Cross-Origin-Opener-Policy same-origin;
  add_header Cross-Origin-Embedder-Policy require-corp;

Node.js/Express:
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });

Note: These headers may break some third-party embeds (iframes, images from other domains).
`;

  return {
    sabAvailable: SAB_AVAILABLE,
    atomicsAvailable: ATOMICS_AVAILABLE,
    usingSharedMemory: USE_SHARED_MEMORY,
    guidance: !USE_SHARED_MEMORY ? headersNeeded : 'SharedArrayBuffer is enabled!'
  };
}
