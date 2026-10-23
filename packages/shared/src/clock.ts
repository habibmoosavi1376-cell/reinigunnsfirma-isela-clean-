/** Time source. Services receive a clock so that time-dependent rules are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: Date): Clock {
  return { now: () => new Date(at.getTime()) };
}
