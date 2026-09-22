export const MAX_BINDINGS = 64;
export const MAX_CANDIDATES = 100;
export const GLOBAL_MAX_RESULT_ROWS = 100;
export const GLOBAL_MAX_RESULT_BYTES = 8 * 1_024 * 1_024;

/** Shared accumulator for one execution, including every operation and binding. */
export class ExecutionBudget {
  private rows = 0;
  private bytes = 0;

  public consume(rows: number, bytes: number): void {
    this.rows += rows;
    this.bytes += bytes;
    if (this.rows > GLOBAL_MAX_RESULT_ROWS || this.bytes > GLOBAL_MAX_RESULT_BYTES) {
      throw productError("result_limits_exceeded");
    }
  }
}
import { productError } from "./errors.js";
