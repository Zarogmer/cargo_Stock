/**
 * AIS Stream service.
 *
 * Streams live AIS messages from aisstream.io for vessels in the Port of
 * Santos area. AIS Stream is push-only — there's no historical snapshot —
 * so each call opens a WebSocket, listens for a short window, and returns
 * whatever vessels broadcast during that window. Combined with the
 * upsert-into-Postgres flow in /api/external-ships/sync, repeated calls
 * progressively fill the cache.
 *
 * Anchored vessels broadcast position every ~3 minutes, so a single short
 * pull will under-sample them. Users repeatedly clicking "Atualizar" is
 * the expected mode of operation.
 *
 * Requires AISSTREAM_API_KEY in environment. Without it the service throws
 * a typed error so callers can degrade gracefully.
 */

import WebSocket, { type RawData } from "ws";

export const SANTOS_BBOX = {
  minLat: -24.1,
  maxLat: -23.7,
  minLng: -46.6,
  maxLng: -46.1,
} as const;

export interface NormalizedShip {
  name: string;
  mmsi: string | null;
  imo: string | null;
  lat: number | null;
  lng: number | null;
  status: string | null;
}

export class AisStreamConfigError extends Error {
  constructor() {
    super("AISSTREAM_API_KEY não configurada");
    this.name = "AisStreamConfigError";
  }
}

export class AisStreamApiError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "AisStreamApiError";
  }
}

// AIS NavigationalStatus codes -> human-readable status.
// Reference: https://www.navcen.uscg.gov/ais-class-a-reports
const AIS_STATUS_LABELS: Record<number, string> = {
  0: "underway",
  1: "anchored",
  2: "not_under_command",
  3: "restricted_maneuverability",
  4: "constrained_by_draught",
  5: "moored",
  6: "aground",
  7: "fishing",
  8: "underway_sailing",
  15: "undefined",
};

const WS_URL = "wss://stream.aisstream.io/v0/stream";
const LISTEN_WINDOW_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 5_000;

interface AisStreamMessage {
  MessageType?: string;
  MetaData?: {
    MMSI?: number;
    MMSI_String?: string;
    ShipName?: string;
    latitude?: number;
    longitude?: number;
  };
  Message?: {
    PositionReport?: {
      Latitude?: number;
      Longitude?: number;
      NavigationalStatus?: number;
    };
    ShipStaticData?: {
      ImoNumber?: number;
      Name?: string;
    };
  };
  // Server-side errors come back as { error: "..." } on the same socket.
  error?: string;
}

function getApiKey(): string {
  const key = process.env.AISSTREAM_API_KEY?.trim();
  if (!key) throw new AisStreamConfigError();
  return key;
}

function trimName(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

export async function fetchShipsFromSantos(): Promise<NormalizedShip[]> {
  const apiKey = getApiKey();

  return new Promise<NormalizedShip[]>((resolve, reject) => {
    const ships = new Map<string, NormalizedShip>();
    let opened = false;
    let settled = false;

    const ws = new WebSocket(WS_URL);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      clearTimeout(listenTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(Array.from(ships.values()));
    };

    const connectionTimer = setTimeout(() => {
      if (!opened) {
        finish(new AisStreamApiError("Timeout ao conectar no AIS Stream"));
      }
    }, CONNECTION_TIMEOUT_MS);

    const listenTimer = setTimeout(() => finish(), LISTEN_WINDOW_MS);

    ws.on("open", () => {
      opened = true;

      const subscription = {
        APIKey: apiKey,
        BoundingBoxes: [
          [
            [SANTOS_BBOX.minLat, SANTOS_BBOX.minLng],
            [SANTOS_BBOX.maxLat, SANTOS_BBOX.maxLng],
          ],
        ],
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      };

      try {
        ws.send(JSON.stringify(subscription));
      } catch (err) {
        finish(
          new AisStreamApiError(
            `Falha ao enviar subscription: ${(err as Error).message}`
          )
        );
      }
    });

    ws.on("message", (raw: RawData) => {
      let parsed: AisStreamMessage;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (typeof parsed.error === "string") {
        finish(new AisStreamApiError(`AIS Stream: ${parsed.error}`));
        return;
      }

      const meta = parsed.MetaData;
      if (!meta) return;

      const mmsiNum = meta.MMSI;
      if (typeof mmsiNum !== "number" || !Number.isFinite(mmsiNum)) return;
      const mmsi = String(mmsiNum);

      const existing = ships.get(mmsi) ?? {
        name: "Sem nome",
        mmsi,
        imo: null,
        lat: null,
        lng: null,
        status: null,
      };

      const metaName = trimName(meta.ShipName);
      if (metaName) existing.name = metaName;
      if (typeof meta.latitude === "number") existing.lat = meta.latitude;
      if (typeof meta.longitude === "number") existing.lng = meta.longitude;

      const pos = parsed.Message?.PositionReport;
      if (pos) {
        if (typeof pos.Latitude === "number") existing.lat = pos.Latitude;
        if (typeof pos.Longitude === "number") existing.lng = pos.Longitude;
        if (typeof pos.NavigationalStatus === "number") {
          existing.status = AIS_STATUS_LABELS[pos.NavigationalStatus] ?? null;
        }
      }

      const stat = parsed.Message?.ShipStaticData;
      if (stat) {
        if (typeof stat.ImoNumber === "number" && stat.ImoNumber > 0) {
          existing.imo = String(stat.ImoNumber);
        }
        const staticName = trimName(stat.Name);
        if (staticName) existing.name = staticName;
      }

      ships.set(mmsi, existing);
    });

    ws.on("error", (err) => {
      finish(
        new AisStreamApiError(`Erro de WebSocket AIS Stream: ${err.message}`)
      );
    });

    ws.on("close", () => finish());
  });
}
