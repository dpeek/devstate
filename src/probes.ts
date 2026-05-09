import { setTimeout as delay } from "node:timers/promises";

import type { EventProbeConfig, ServiceConfig } from "./config.js";

export const READY_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 250;

export interface ProbeRuntime {
  getLog(): string;
  getUrl(): string | undefined;
  hasExited(): boolean;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

export async function waitForReady(
  service: ServiceConfig,
  runtime: ProbeRuntime,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<ProbeResult> {
  const probe = service.events?.ready;
  if (probe === undefined) {
    return { ok: true };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.hasExited()) {
      return { ok: false, reason: "service exited before ready" };
    }

    if (await probeReady(probe, runtime)) {
      return { ok: true };
    }
    await delay(POLL_INTERVAL_MS);
  }

  return { ok: false, reason: "ready timeout" };
}

export async function probeReady(
  probe: EventProbeConfig,
  runtime: Pick<ProbeRuntime, "getLog" | "getUrl">,
): Promise<boolean> {
  if ("log" in probe) {
    return new RegExp(probe.log).test(runtime.getLog());
  }

  const resolvedUrl = resolveProbeUrl(probe.http, runtime.getUrl());
  if (resolvedUrl === null) {
    return false;
  }

  try {
    const response = await fetch(resolvedUrl, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return response.status === probe.status;
  } catch {
    return false;
  }
}

function resolveProbeUrl(url: string, capturedUrl: string | undefined): string | null {
  if (url === "$url") {
    return capturedUrl ?? null;
  }
  return url.replaceAll("$url", capturedUrl ?? "");
}
