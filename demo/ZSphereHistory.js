/**
 * Snapshot undo/redo stack for ZSphereGraph.captureState / restoreState.
 * One entry = one user gesture (create, delete, whole drag move/scale/rotate, …).
 */
export class ZSphereHistory {
  constructor({ limit = 64 } = {}) {
    this.limit = Math.max(1, limit);
    /** @type {{ label: string, state: object }[]} */
    this._undo = [];
    /** @type {{ label: string, state: object }[]} */
    this._redo = [];
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  clear() {
    this._undo.length = 0;
    this._redo.length = 0;
  }

  /** Record graph state *before* a mutating gesture. */
  push(label, state) {
    if (!state) return;
    this._undo.push({ label: label || 'edit', state });
    while (this._undo.length > this.limit) this._undo.shift();
    this._redo.length = 0;
  }

  /** Drop the newest undo entry without restoring (e.g. aborted create). */
  discardLast() {
    if (!this._undo.length) return false;
    this._undo.pop();
    return true;
  }

  /**
   * @param {() => object} captureCurrent
   * @param {(state: object) => void} restore
   * @returns {string|null} undone label
   */
  undo(captureCurrent, restore) {
    if (!this._undo.length) return null;
    const entry = this._undo.pop();
    this._redo.push({ label: entry.label, state: captureCurrent() });
    restore(entry.state);
    return entry.label;
  }

  /**
   * @param {() => object} captureCurrent
   * @param {(state: object) => void} restore
   * @returns {string|null} redone label
   */
  redo(captureCurrent, restore) {
    if (!this._redo.length) return null;
    const entry = this._redo.pop();
    this._undo.push({ label: entry.label, state: captureCurrent() });
    restore(entry.state);
    return entry.label;
  }
}
