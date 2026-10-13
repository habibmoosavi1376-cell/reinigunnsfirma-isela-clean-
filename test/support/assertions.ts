import { expect } from "vitest";
import { isDomainError, type ErrorCode } from "@isela/shared";

/** Asserts that a promise rejects with a DomainError of the given code. */
export async function expectDomainError(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected DomainError ${code}`).toBeDefined();
  expect(isDomainError(error) ? error.code : error).toBe(code);
}

/** Synchronous variant. */
export function expectDomainErrorSync(fn: () => unknown, code: ErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected DomainError ${code}`).toBeDefined();
  expect(isDomainError(caught) ? caught.code : caught).toBe(code);
}

/** Asserts that a promise rejects with a PostgreSQL error of the given SQLSTATE. */
export async function expectPgError(promise: Promise<unknown>, sqlState: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected PostgreSQL error ${sqlState}`).toBeDefined();
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: string } | undefined)?.code;
  expect(code).toBe(sqlState);
}
