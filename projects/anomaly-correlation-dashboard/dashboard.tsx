import React, {
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
  FC,
  ReactNode,
} from "react";
import type { MessageEvent } from "ws";
import LRUCache from "lru-cache";

// Types for incoming data ----------------------------------------------------
interface KalmanForecast {
  timestamp: number; // Unix epoch ms
  value: number;
  lowerBound: number;
  upperBound: number;
}

interface KMeansCluster {
  timestamp: number;
  clusterId: number;
  x: number;
  y: number;
}

interface ShapScore {
  feature: string;
  score: number;
}

// WebSocket message payload ---------------------------------------------------
interface HubMessage {
  type: "kalman" | "kmeans" | "shap";
  payload: any;
}

// Lazy loaded chart components ------------------------------------------------
const KalmanChart = lazy(() => import("./charts/KalmanChart"));
const KMeansChart = lazy(() => import("./charts/KMeansChart"));
const ShapChart = lazy(() => import("./charts/ShapChart"));

// LRU cache configuration ------------------------------------------------------
const apiCache = new LRUCache<string, any>({
  max: 100, // maximum 100 entries
  ttl: 1000 * 60 * 5, // 5 minutes TTL
});

// Helper to fetch data with caching -------------------------------------------
async function fetchWithCache<T>(url: string): Promise<T> {
  const cached = apiCache.get(url);
  if (cached) {
    return cached as T;
  }
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Network response was not ok: ${response.status}`);
  }
  const data = (await response.json()) as T;
  apiCache.set(url, data);
  return data;
}

// WebSocket hook ---------------------------------------------------------------
function useHubWebSocket(
  url: string,
  onMessage: (msg: HubMessage) => void,
): { error: Error | null; readyState: number } {
  const wsRef = useRef<WebSocket | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CLOSED);

  useEffect(() => {
    if (!url) {
      setError(new Error("WebSocket URL is required"));
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
      wsRef.current = ws;
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const handleOpen = () => setReadyState(ws.readyState);
    const handleClose = () => setReadyState(ws.readyState);
    const handleError = (ev: Event) => {
      setError(new Error(`WebSocket error: ${JSON.stringify(ev)}`));
    };
    const handleMessage = (event: MessageEvent) => {
      try {
        const parsed: HubMessage = JSON.parse(event.data);
        if (!parsed.type || !parsed.payload) {
          throw new Error("Invalid message format");
        }
        onMessage(parsed);
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("close", handleClose);
    ws.addEventListener("error", handleError);
    ws.addEventListener("message", handleMessage);

    setReadyState(ws.readyState);

    return () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("close", handleClose);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("message", handleMessage);
      ws.close();
    };
  }, [url, onMessage]);

  return { error, readyState };
}

// Main Dashboard component -----------------------------------------------------
export const Dashboard: FC = () => {
  const [kalmanData, setKalmanData] = useState<KalmanForecast[]>([]);
  const [kmeansData, setKMeansData] = useState<KMeansCluster[]>([]);
  const [shapData, setShapData] = useState<ShapScore[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [wsError, setWsError] = useState<Error | null>(null);

  // Initial data fetch (lazy loaded) -----------------------------------------
  useEffect(() => {
    async function loadInitialData() {
      try {
        const [kForecasts, kClusters, sScores] = await Promise.all([
          fetchWithCache<KalmanForecast[]>("/api/kalman-forecasts"),
          fetchWithCache<KMeansCluster[]>("/api/kmeans-clusters"),
          fetchWithCache<ShapScore[]>("/api/shap-scores"),
        ]);
        setKalmanData(kForecasts);
        setKMeansData(kClusters);
        setShapData(sScores);
      } catch (e) {
        console.error("Failed to load initial data:", e);
      } finally {
        setLoading(false);
      }
    }
    loadInitialData();
  }, []);

  // WebSocket subscription ----------------------------------------------------
  const { error: wsErr, readyState } = useHubWebSocket(
    "wss://example.com/hub",
    (msg: HubMessage) => {
      switch (msg.type) {
        case "kalman":
          setKalmanData((prev) => [
            ...prev,
            ...(msg.payload as KalmanForecast[]),
          ]);
          break;
        case "kmeans":
          setKMeansData((prev) => [
            ...prev,
            ...(msg.payload as KMeansCluster[]),
          ]);
          break;
        case "shap":
          setShapData((prev) => [...prev, ...(msg.payload as ShapScore[])]);
          break;
        default:
          console.warn(`Unhandled message type: ${msg.type}`);
      }
    },
  );

  useEffect(() => {
    if (wsErr) setWsError(wsErr);
  }, [wsErr]);

  // Synchronization helper ----------------------------------------------------
  // Align timestamps across datasets for synchronized cursor
  const synchronizedTimestamps = React.useMemo(() => {
    const tsSet = new Set<number>();
    kalmanData.forEach((d) => tsSet.add(d.timestamp));
    kmeansData.forEach((d) => tsSet.add(d.timestamp));
    // SHAP scores may not be time based; ignore for timestamp sync
    return Array.from(tsSet).sort((a, b) => a - b);
  }, [kalmanData, kmeansData]);

  // Render --------------------------------------------------------------------
  if (loading) {
    return <div>Loading dashboard...</div>;
  }

  if (wsError) {
    return <div className="error">WebSocket error: {wsError.message}</div>;
  }

  return (
    <div className="dashboard">
      <Suspense fallback={<div>Loading Kalman chart...</div>}>
        <KalmanChart
          data={kalmanData}
          synchronizedTimestamps={synchronizedTimestamps}
        />
      </Suspense>
      <Suspense fallback={<div>Loading K‑Means chart...</div>}>
        <KMeansChart
          data={kmeansData}
          synchronizedTimestamps={synchronizedTimestamps}
        />
      </Suspense>
      <Suspense fallback={<div>Loading SHAP chart...</div>}>
        <ShapChart data={shapData} />
      </Suspense>
    </div>
  );
};

// Optional: Export default for convenience
export default Dashboard;