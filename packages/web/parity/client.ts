import { fixtureResponse } from "./fixture";

export const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const api = {
  get: async <T>(path: string) => fixtureResponse(path) as T,
  assetUrl: (_space: string, src: string) => src,
  beacon: () => undefined
};

export const failureMessage = (error: unknown) => String(error);

export const onSessionExpired = () => () => undefined;

export const setVisitor = (_value: boolean) => undefined;

/** Nothing comes rendered from a server here. */
export const prepareAnswers = () => undefined;
