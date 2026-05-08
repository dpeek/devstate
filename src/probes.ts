import { setTimeout as delay } from "node:timers/promises";

import type { ProbeConfig, ServiceConfig } from "./config.js";

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
  const probes = service.ready ?? [];
  if (probes.length === 0) {
    return { ok: true };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.hasExited()) {
      return { ok: false, reason: "service exited before ready" };
    }

    const results = await Promise.all(probes.map((probe) => probeReady(probe, runtime)));
    if (results.every(Boolean)) {
      return { ok: true };
    }
    await delay(POLL_INTERVAL_MS);
  }

  return { ok: false, reason: "ready timeout" };
}

async function probeReady(probe: ProbeConfig, runtime: ProbeRuntime): Promise<boolean> {
  if (probe.type === "log") {
    return new RegExp(probe.match).test(runtime.getLog());
  }

  const resolvedUrl = resolveProbeUrl(probe.url, runtime.getUrl());
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
