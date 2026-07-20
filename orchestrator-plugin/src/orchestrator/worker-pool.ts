/**
 * Worker Pool — 控制同时运行的 agent session 数量。
 * 替代 Phase 2 的 worker_pool 表 + PID 追踪。
 */
export class WorkerPool {
  private active = 0;
  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  hasSlot(): boolean {
    return this.active < this.max;
  }

  available(): number {
    return Math.max(0, this.max - this.active);
  }

  acquire(): void {
    if (!this.hasSlot()) {
      throw new Error("No available worker slot");
    }
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get activeCount(): number {
    return this.active;
  }
}
