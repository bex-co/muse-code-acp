/**
 * Turn-scoped pending-id tracking shared by approvals and user-input.
 * Bumping generation invalidates every outstanding track for that surface.
 */
export class TurnScopedLifecycle {
  private readonly pending = new Map<string, { turnId: string }>();
  private generation = 0;

  beginTurn(turnId: string): number {
    this.generation += 1;
    for (const [id, meta] of this.pending) {
      if (meta.turnId !== turnId) {
        this.pending.delete(id);
      }
    }
    return this.generation;
  }

  track(id: string, turnId: string, generation: number): boolean {
    if (generation !== this.generation) {
      return false;
    }
    this.pending.set(id, { turnId });
    return true;
  }

  isLive(id: string, turnId: string, generation: number): boolean {
    if (generation !== this.generation) {
      return false;
    }
    return this.pending.get(id)?.turnId === turnId;
  }

  resolve(id: string): void {
    this.pending.delete(id);
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  disposeTurn(turnId: string): void {
    for (const [id, meta] of this.pending) {
      if (meta.turnId === turnId) {
        this.pending.delete(id);
      }
    }
  }

  disposeAll(): void {
    this.pending.clear();
    this.generation += 1;
  }
}
